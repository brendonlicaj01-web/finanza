import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

const API = 'https://api.bitpanda.com/v1';

interface Item<A> {
  id: string;
  attributes: A;
}
interface Page<A> {
  data: Item<A>[];
  meta?: { next_cursor?: string };
}
interface Wallet {
  cryptocoin_id: string;
  cryptocoin_symbol: string;
  balance: string;
  name?: string;
  deleted?: boolean;
}
interface FiatWallet {
  fiat_symbol: string;
  balance: string;
}
export interface BitpandaTrade {
  status?: string;
  type: 'buy' | 'sell';
  cryptocoin_id: string;
  amount_fiat: string;
  amount_cryptocoin: string;
  fiat_to_eur_rate?: string;
  time: { date_iso8601?: string; unix?: string };
}
export interface BitpandaFiatTx {
  type: string;
  status?: string;
  amount: string;
  fee?: string;
  to_eur_rate?: string;
  time: { date_iso8601?: string; unix?: string };
}

async function get<T>(apiKey: string, path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers: { 'X-Api-Key': apiKey, Accept: 'application/json' } });
  } catch (e) {
    throw new ProviderError(`Bitpanda non raggiungibile: ${(e as Error).message}`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new ProviderError('Bitpanda: chiave API non valida o senza i permessi di lettura.');
  }
  if (!res.ok) throw new ProviderError(`Bitpanda ha risposto con errore ${res.status}.`);
  return (await res.json()) as T;
}

async function getAll<A>(apiKey: string, path: string): Promise<Item<A>[]> {
  const out: Item<A>[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 200; i++) {
    const sep = path.includes('?') ? '&' : '?';
    const page = await get<Page<A>>(apiKey, `${path}${sep}page_size=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    out.push(...page.data);
    cursor = page.meta?.next_cursor;
    if (!cursor || !page.data.length) break;
  }
  return out;
}

const day = (t: { date_iso8601?: string; unix?: string }) =>
  t.date_iso8601 ? t.date_iso8601.slice(0, 10) : new Date(Number(t.unix) * 1000).toISOString().slice(0, 10);

/** Converte operazioni e movimenti fiat Bitpanda (importi riportati in EUR con il tasso fornito da Bitpanda). */
export function bitpandaToTxs(
  trades: Item<BitpandaTrade>[],
  fiatTxs: Item<BitpandaFiatTx>[],
  symbols: Map<string, string>,
  warnings: string[],
): SyncTx[] {
  const txs: SyncTx[] = [];
  for (const { id, attributes: t } of trades) {
    if (t.status && t.status !== 'finished') continue;
    const symbol = symbols.get(t.cryptocoin_id);
    const qty = Number(t.amount_cryptocoin);
    const eur = Number(t.amount_fiat) * (Number(t.fiat_to_eur_rate) || 1);
    if (!symbol) {
      warnings.push(`Operazione Bitpanda ${id}: moneta sconosciuta (id ${t.cryptocoin_id}), ignorata.`);
      continue;
    }
    if (!qty || !eur) continue;
    txs.push({
      externalId: `bitpanda:trade:${id}`,
      date: day(t.time),
      type: t.type === 'sell' ? 'vendita' : 'acquisto',
      assetKey: `crypto:${symbol}`,
      quantity: qty,
      price: eur / qty,
      fees: 0,
    });
  }
  for (const { id, attributes: f } of fiatTxs) {
    if (f.status && f.status !== 'finished') continue;
    if (f.type !== 'deposit' && f.type !== 'withdrawal') continue;
    const rate = Number(f.to_eur_rate) || 1;
    txs.push({
      externalId: `bitpanda:fiat:${id}`,
      date: day(f.time),
      type: f.type === 'deposit' ? 'deposito' : 'prelievo',
      amount: Math.round(Number(f.amount) * rate * 100) / 100,
      fees: Math.round((Number(f.fee) || 0) * rate * 100) / 100,
    });
  }
  return txs;
}

export const bitpanda: Provider = {
  id: 'bitpanda',
  label: 'Bitpanda',
  category: 'crypto',
  description: 'Saldi crypto, acquisti, vendite, depositi e prelievi in euro con chiave API di sola lettura.',
  available: true,
  docsUrl: 'https://developers.bitpanda.com/platform/',
  fields: [{ key: 'apiKey', label: 'API key', secret: true }],
  guide: [
    'Su Bitpanda (web): Profilo → Impostazioni → Chiave API → Nuova chiave.',
    'Seleziona solo gli ambiti di lettura: "Balance", "Trade" e "Transaction". Nessun permesso di prelievo.',
    'Incolla qui la chiave. Nota: azioni, ETF e metalli di Bitpanda non sono inclusi, solo le crypto.',
  ],
  async test({ apiKey }) {
    await get(apiKey, '/fiatwallets');
  },
  async sync({ apiKey }, { currency }): Promise<SyncResult> {
    const warnings: string[] = [];
    if (currency !== 'EUR') warnings.push(`Bitpanda riporta gli importi in EUR: la valuta dell'app è ${currency}.`);
    const [wallets, fiatWallets, trades, fiatTxs, ticker] = await Promise.all([
      get<Page<Wallet>>(apiKey, '/wallets'),
      get<Page<FiatWallet>>(apiKey, '/fiatwallets'),
      getAll<BitpandaTrade>(apiKey, '/trades'),
      getAll<BitpandaFiatTx>(apiKey, '/fiatwallets/transactions').catch(() => {
        warnings.push('Impossibile leggere depositi e prelievi (serve l\'ambito "Transaction").');
        return [] as Item<BitpandaFiatTx>[];
      }),
      fetch(`${API}/ticker`)
        .then((r) => r.json() as Promise<Record<string, Record<string, string>>>)
        .catch(() => ({}) as Record<string, Record<string, string>>),
    ]);

    const symbols = new Map(wallets.data.map((w) => [w.attributes.cryptocoin_id, w.attributes.cryptocoin_symbol]));
    const transactions = bitpandaToTxs(trades, fiatTxs, symbols, warnings);

    const assets = new Map<string, SyncAsset>();
    const touch = (symbol: string, name?: string) => {
      const key = `crypto:${symbol}`;
      if (!assets.has(key)) {
        const price = Number(ticker[symbol]?.[currency] ?? ticker[symbol]?.EUR);
        assets.set(key, {
          key,
          symbol,
          name: name?.replace(/ Wallet$/, '') || symbol,
          type: 'crypto',
          price: price > 0 ? price : undefined,
        });
      }
      return key;
    };
    for (const t of transactions) if (t.assetKey) touch(t.assetKey.slice('crypto:'.length));

    const holdings: SyncHolding[] = [];
    const perCoin = new Map<string, number>();
    for (const w of wallets.data) {
      const qty = Number(w.attributes.balance);
      if (w.attributes.deleted || !(qty > 0)) continue;
      touch(w.attributes.cryptocoin_symbol, w.attributes.name);
      perCoin.set(w.attributes.cryptocoin_symbol, (perCoin.get(w.attributes.cryptocoin_symbol) ?? 0) + qty);
    }
    for (const [symbol, quantity] of perCoin) holdings.push({ assetKey: `crypto:${symbol}`, quantity });

    const cash = fiatWallets.data
      .filter((f) => f.attributes.fiat_symbol === currency)
      .reduce((s, f) => s + Number(f.attributes.balance || 0), 0);
    if (fiatWallets.data.some((f) => f.attributes.fiat_symbol !== currency && Number(f.attributes.balance) > 0)) {
      warnings.push(`Saldi fiat diversi da ${currency} non inclusi nella liquidità.`);
    }

    return {
      accountName: 'Bitpanda',
      accountKind: 'wallet',
      currency,
      assets: [...assets.values()],
      transactions,
      holdings,
      cash: Math.round(cash * 100) / 100,
      warnings,
    };
  },
};
