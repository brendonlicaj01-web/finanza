import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from '../types.ts';
import { FAMILY_LABEL, parseAddresses, type Family } from './detect.ts';
import { PriceBook } from './prices.ts';
import { readEvm } from './evm.ts';
import { readZerion } from './zerion.ts';
import { readSolana } from './solana.ts';
import { readTron } from './tron.ts';
import { readCardano, readStellar, readTon, readXrp } from './others.ts';
import { readDogecoin, readEsplora, usedAddresses } from './utxo.ts';
import type { ChainData, Movement } from './types.ts';

/**
 * Wallet crypto "self-custody" (Ledger, MetaMask, Phantom, Trust…) letti dalle blockchain con i soli indirizzi
 * pubblici: nessuna chiave privata, nessun permesso di spesa.
 *
 * Ogni entrata o uscita è un **trasferimento crypto interno** (le crypto arrivano o partono verso altri conti o
 * wallet); uno scambio nella stessa transazione (es. su un DEX) è una vendita + un acquisto; la commissione di rete
 * è un'uscita a parte.
 */

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

interface Leg {
  chain: string;
  hash: string;
  time: number;
  symbol: string;
  amount: number;
  fee: number;
}

/** Somma i movimenti della stessa transazione e dello stesso asset (più indirizzi dello stesso wallet). */
function aggregate(movements: Movement[]): Map<string, Leg[]> {
  const byTx = new Map<string, Map<string, Leg>>();
  for (const m of movements) {
    const txKey = `${m.chain}:${m.hash}`;
    let legs = byTx.get(txKey);
    if (!legs) byTx.set(txKey, (legs = new Map()));
    const leg = legs.get(m.symbol) ?? { chain: m.chain, hash: m.hash, time: m.time, symbol: m.symbol, amount: 0, fee: 0 };
    leg.amount += m.amount;
    leg.fee += m.fee ?? 0;
    legs.set(m.symbol, leg);
  }
  return new Map([...byTx].map(([k, v]) => [k, [...v.values()]]));
}

/** Converte movimenti e saldi nel formato comune, valorizzando in euro al prezzo del giorno. */
type Prices = Pick<PriceBook, 'at' | 'has' | 'latest'>;

/**
 * Prezzi: prima quelli forniti dalla fonte (es. Zerion, valore al momento della transazione), poi lo storico
 * giornaliero pubblico (Binance/CryptoCompare).
 */
function withHints(chains: ChainData[], book: Prices): Prices {
  const byDay = new Map<string, Map<string, number>>();
  for (const m of chains.flatMap((c) => c.movements)) {
    if (!m.price || !m.time) continue;
    const days = byDay.get(m.symbol) ?? new Map<string, number>();
    days.set(dayOf(m.time), m.price);
    byDay.set(m.symbol, days);
  }
  const latest = new Map<string, number>();
  for (const c of chains) for (const [k, v] of c.prices ?? []) latest.set(k, v);
  const nearest = (symbol: string, day: string) => {
    const days = byDay.get(symbol);
    if (!days) return undefined;
    const keys = [...days.keys()].sort();
    const before = keys.filter((d) => d <= day).pop() ?? keys[0];
    return days.get(before);
  };
  return {
    at: (symbol, ms) => byDay.get(symbol)?.get(dayOf(ms)) ?? book.at(symbol, ms) ?? nearest(symbol, dayOf(ms)) ?? latest.get(symbol),
    has: (symbol) => byDay.has(symbol) || latest.has(symbol) || book.has(symbol),
    latest: (symbol) => latest.get(symbol) ?? book.latest(symbol) ?? nearest(symbol, dayOf(Date.now())),
  };
}

export function walletToSync(chains: ChainData[], book: Prices): SyncResult {
  const prices = withHints(chains, book);
  const warnings = chains.flatMap((c) => c.warnings);
  const all = chains.flatMap((c) => c.movements);
  // Senza data non si può valorizzare né abbinare: meglio lasciare che l'allineamento al saldo li compensi.
  const movements = all.filter((m) => m.time > 0);
  if (movements.length < all.length) warnings.push(`${all.length - movements.length} movimenti senza data ignorati.`);
  const balances = new Map<string, number>();
  for (const c of chains) for (const [s, q] of c.balances) balances.set(s, (balances.get(s) ?? 0) + q);

  const assets = new Map<string, SyncAsset>();
  const unpriced = new Set<string>();
  const touch = (symbol: string) => {
    const key = `crypto:${symbol}`;
    if (!assets.has(key)) {
      const price = prices.latest(symbol);
      assets.set(key, { key, symbol, name: symbol, type: 'crypto', taxRate: 26, ...(price ? { price } : {}) });
    }
    return key;
  };
  const priced = (symbol: string) => {
    if (prices.has(symbol)) return true;
    unpriced.add(symbol);
    return false;
  };

  const transactions: SyncTx[] = [];
  let swaps = 0;
  // In ordine di tempo: nello stesso giorno un invio non deve precedere la ricezione che lo rende possibile.
  const ordered = [...aggregate(movements).values()].sort((a, b) => a[0].time - b[0].time);
  for (const legs of ordered) {
    const { chain, hash, time } = legs[0];
    const date = dayOf(time);
    const base = `wallet:${chain}:${hash}`;
    const value = (l: Leg) => (prices.at(l.symbol, time) ?? 0) * Math.abs(l.amount);
    const moving = legs.filter((l) => Math.abs(l.amount) > 1e-12 && priced(l.symbol));
    const outs = moving.filter((l) => l.amount < 0);
    const ins = moving.filter((l) => l.amount > 0);
    const swap = outs.length > 0 && ins.length > 0;

    // Commissione di rete: dentro l'uscita della moneta della rete, se c'è ed è un semplice invio; altrimenti a parte.
    const feeLeg = legs.find((l) => l.fee > 0);
    let feeInside = false;
    if (swap) {
      swaps++;
      const outValue = outs.reduce((s, l) => s + value(l), 0);
      for (const l of outs) {
        transactions.push({
          externalId: `${base}:${l.symbol}`,
          date,
          type: 'vendita',
          assetKey: touch(l.symbol),
          quantity: r8(-l.amount),
          price: prices.at(l.symbol, time) ?? 0,
          fees: 0,
          note: `Scambio on-chain (${chain})`,
          rev: 1,
        });
      }
      for (const l of ins) {
        // Con una sola moneta ricevuta, il suo costo è il valore di ciò che è stato dato in cambio.
        const price = ins.length === 1 && outValue ? outValue / l.amount : (prices.at(l.symbol, time) ?? 0);
        transactions.push({
          externalId: `${base}:${l.symbol}`,
          date,
          type: 'acquisto',
          assetKey: touch(l.symbol),
          quantity: r8(l.amount),
          price,
          fees: 0,
          note: `Scambio on-chain (${chain})`,
          rev: 1,
        });
      }
    } else {
      for (const l of moving) {
        const out = l.amount < 0;
        const withFee = out && feeLeg?.symbol === l.symbol;
        if (withFee) feeInside = true;
        transactions.push({
          externalId: `${base}:${l.symbol}`,
          date,
          type: out ? 'trasf_uscita' : 'trasf_entrata',
          assetKey: touch(l.symbol),
          quantity: r8(Math.abs(l.amount) + (withFee ? feeLeg!.fee : 0)),
          price: prices.at(l.symbol, time) ?? 0,
          fees: 0,
          note: out ? `Inviate da wallet (${chain})` : `Ricevute nel wallet (${chain})`,
          rev: 1,
        });
      }
    }
    if (feeLeg && !feeInside && priced(feeLeg.symbol)) {
      transactions.push({
        externalId: `${base}:gas`,
        date,
        type: 'trasf_uscita',
        assetKey: touch(feeLeg.symbol),
        quantity: r8(feeLeg.fee),
        price: prices.at(feeLeg.symbol, time) ?? 0,
        fees: 0,
        note: `Commissione di rete (${chain})`,
        rev: 1,
      });
    }
  }

  const holdings: SyncHolding[] = [];
  for (const [symbol, qty] of balances) {
    if (qty <= 1e-12 || !priced(symbol)) continue;
    holdings.push({ assetKey: touch(symbol), quantity: r8(qty) });
  }

  if (unpriced.size) {
    warnings.push(`${unpriced.size} monete senza prezzo di mercato ignorate: ${[...unpriced].slice(0, 10).join(', ')}${unpriced.size > 10 ? '…' : ''}.`);
  }
  if (swaps) warnings.push(`${swaps} scambi on-chain (es. su un DEX) registrati come vendita + acquisto.`);

  return {
    accountName: 'Wallet crypto',
    accountKind: 'wallet',
    currency: 'EUR',
    assets: [...assets.values()],
    transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
    holdings,
    // Un wallet non ha liquidità in euro: eventuali residui degli scambi si azzerano.
    cash: 0,
    complete: true,
    warnings,
  };
}

type Reader = (addresses: string[]) => Promise<ChainData>;

/** Fonti senza chiave, per rete. */
const FREE: Record<Family, Reader> = {
  bitcoin: (a) => readEsplora('bitcoin', a),
  'bitcoin-xpub': async (keys) => {
    const addresses: string[] = [];
    for (const k of keys) addresses.push(...(await usedAddresses(k)));
    const data = await readEsplora('bitcoin', addresses);
    data.warnings.push(`Bitcoin: ${addresses.length} indirizzi usati trovati dalla chiave pubblica estesa.`);
    return data;
  },
  litecoin: (a) => readEsplora('litecoin', a),
  dogecoin: (a) => readDogecoin(a),
  evm: (a) => readEvm(a),
  solana: (a) => readSolana(a),
  tron: (a) => readTron(a),
  xrp: (a) => readXrp(a),
  cardano: (a) => readCardano(a),
  ton: (a) => readTon(a),
  stellar: (a) => readStellar(a),
};
/** Reti che Zerion legge per intero (storico interpretato, valori in euro, filtro antispam). */
const ZERION_FAMILIES = new Set<Family>(['evm', 'solana', 'tron']);

function checkAddresses(text = '') {
  const { valid, invalid } = parseAddresses(text);
  if (invalid.length) {
    throw new ProviderError(`Indirizzi non riconosciuti: ${invalid.slice(0, 3).join(', ')}${invalid.length > 3 ? '…' : ''}. Incolla indirizzi pubblici, uno per riga (mai la frase segreta).`);
  }
  if (!valid.length) throw new ProviderError('Inserisci almeno un indirizzo pubblico.');
  return valid;
}

export const wallet: Provider = {
  id: 'wallet',
  label: 'Wallet crypto',
  category: 'crypto',
  description:
    'Ledger, Trezor, MetaMask, Trust, Phantom e ogni altro wallet: incolli l\'indirizzo pubblico e arrivano tutte le transazioni della rete. Bitcoin (anche xpub/zpub), Ethereum e reti compatibili, Solana, Tron, XRP, Litecoin, Dogecoin; saldo di Cardano, TON e Stellar.',
  available: true,
  fields: [
    {
      key: 'addresses',
      label: 'Indirizzi pubblici (uno per riga, la rete si riconosce da sola)',
      multiline: true,
      placeholder: 'bc1q… oppure zpub…\n0x…\nChiave pubblica Solana…\nT… (Tron)',
    },
    {
      key: 'zerionKey',
      label: 'Chiave Zerion gratuita (consigliata per Ethereum & co., Solana e Tron)',
      secret: true,
      optional: true,
      placeholder: 'zk_…',
    },
  ],
  guide: [
    'Nel wallet copia l\'indirizzo di ricezione di ogni rete. Per Bitcoin è meglio la chiave pubblica estesa (xpub/zpub): contiene tutti gli indirizzi del conto (Ledger Live: Account → ⋯ → Modifica account → Avanzate; Trezor Suite: Account → Dettagli). Non inserire mai la frase segreta o le chiavi private.',
    'Incolla gli indirizzi qui sotto, uno per riga, anche con un nome davanti (es. "Ledger bc1q…"). Lo stesso indirizzo 0x… vale per Ethereum, Arbitrum, Base, Polygon, BNB Chain e le altre reti compatibili: vengono lette tutte.',
    'Consigliato: crea una chiave gratuita su dashboard.zerion.io (nessuna carta, 3.000 richieste al giorno) e incollala qui. Con la chiave arrivano lo storico completo di tutte le reti EVM, di Solana e di Tron, già interpretato (invii, ricezioni, scambi) e senza token truffaldini. Bitcoin, Litecoin, Dogecoin e XRP non ne hanno bisogno.',
    'Ogni entrata o uscita diventa un "Trasferimento crypto interno" e si abbina da sola all\'altra metà sugli exchange o sugli altri wallet; gli scambi (DEX) sono vendita + acquisto.',
  ],
  async test(credentials) {
    checkAddresses(credentials.addresses);
  },
  async sync(credentials, { currency }) {
    const list = checkAddresses(credentials.addresses);
    const zerionKey = credentials.zerionKey?.trim();
    const byFamily = new Map<Family, string[]>();
    for (const a of list) byFamily.set(a.family, [...(byFamily.get(a.family) ?? []), a.address]);

    const chains: ChainData[] = [];
    const failures: string[] = [];
    const read = async (family: Family, addresses: string[]) => {
      try {
        chains.push(await FREE[family](addresses));
      } catch (e) {
        failures.push(`${FAMILY_LABEL[family]}: ${(e as Error).message}`);
      }
    };

    // Con la chiave Zerion, un'unica lettura per EVM, Solana e Tron; se non riesce, le fonti senza chiave.
    if (zerionKey) {
      const zAddresses = [...byFamily].filter(([f]) => ZERION_FAMILIES.has(f)).flatMap(([, a]) => a);
      if (zAddresses.length) {
        try {
          chains.push(await readZerion(zAddresses, zerionKey));
          for (const f of ZERION_FAMILIES) byFamily.delete(f);
        } catch (e) {
          if (/chiave API non valida/.test((e as Error).message)) throw e;
          failures.push(`Zerion: ${(e as Error).message} (uso le fonti senza chiave)`);
        }
      }
    }
    for (const [family, addresses] of byFamily) await read(family, addresses);
    if (!chains.length) throw new ProviderError(failures.join(' '));

    // Prezzi storici pubblici solo per ciò che la fonte non ha già valorizzato.
    const prices = new PriceBook();
    const movements = chains.flatMap((c) => c.movements);
    const hinted = new Set(chains.flatMap((c) => [...(c.prices?.keys() ?? []), ...c.movements.filter((m) => m.price).map((m) => m.symbol)]));
    const symbols = new Set(
      [...movements.filter((m) => !m.price).map((m) => m.symbol), ...chains.flatMap((c) => [...c.balances.keys()])].filter((s) => !hinted.has(s)),
    );
    const from = movements.reduce((m, x) => (x.time && x.time < m ? x.time : m), Date.now() - 86_400_000);
    if (symbols.size) {
      await prices.prepare(symbols, from);
      await prices.save().catch(() => {});
    }

    const result = walletToSync(chains, prices);
    result.warnings.unshift(...failures.map((f) => `Non letto — ${f}`));
    if (!zerionKey && (byFamily.has('evm') || byFamily.has('solana') || byFamily.has('tron'))) {
      result.warnings.push('Suggerimento: con una chiave Zerion gratuita lo storico di Ethereum & co., Solana e Tron è più completo e veloce.');
    }
    if (currency !== 'EUR') result.warnings.push(`I valori dei wallet sono in EUR, non in ${currency}.`);
    return result;
  },
};
