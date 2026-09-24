import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

const FIAT = new Set(['EUR', 'USD', 'GBP', 'CHF', 'JPY', 'CAD', 'AUD']);
/** Contropartite comuni su Binance, usate per trovare le coppie da interrogare. */
const BINANCE_QUOTES = ['EUR', 'USDT', 'USDC', 'FDUSD', 'BTC', 'ETH', 'BNB'];

/** Sottoinsieme dell'interfaccia di un exchange ccxt che usiamo. */
interface Trade {
  id?: string;
  timestamp?: number;
  symbol?: string;
  side?: string;
  amount?: number;
  price?: number;
  cost?: number;
  fee?: { cost?: number; currency?: string };
}
interface Transfer {
  id?: string;
  txid?: string;
  timestamp?: number;
  amount?: number;
  currency?: string;
  status?: string;
  fee?: { cost?: number };
}
interface Exchange {
  has: Record<string, unknown>;
  markets: Record<string, { spot?: boolean; active?: boolean; base: string; quote: string }>;
  currencies: Record<string, { name?: string }>;
  loadMarkets(): Promise<unknown>;
  fetchBalance(params?: object): Promise<{ total: Record<string, number | undefined> }>;
  fetchMyTrades(symbol?: string, since?: number, limit?: number, params?: object): Promise<Trade[]>;
  fetchTicker(symbol: string): Promise<{ last?: number; close?: number }>;
  fetchOHLCV(symbol: string, tf: string, since?: number, limit?: number): Promise<number[][]>;
  fetchDeposits(code?: string, since?: number): Promise<Transfer[]>;
  fetchWithdrawals(code?: string, since?: number): Promise<Transfer[]>;
}

/** Tasso di cambio: valuta base per 1 unità di `currency`, alla data `ts` (o attuale). */
export type RateFn = (currency: string, ts?: number) => Promise<number>;

const DAY = 86_400_000;
const isoDate = (ts?: number) => new Date(ts ?? Date.now()).toISOString().slice(0, 10);
/** Kraken espone i saldi in staking come "ETH.F", "DOT.S": li riconduciamo alla moneta. */
export const normalizeCode = (code: string) => code.split('.')[0];

/**
 * Converte le operazioni di un exchange in transazioni dell'app. Uno scambio crypto/crypto
 * (es. ETH/USDT) diventa acquisto di ETH + vendita della contropartita USDT, entrambi valorizzati
 * in valuta base al cambio del giorno.
 */
export async function tradesToTxs(
  prefix: string,
  trades: Trade[],
  base: string,
  rate: RateFn,
  warnings: string[],
): Promise<SyncTx[]> {
  const txs: SyncTx[] = [];
  const sorted = [...trades].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0));
  for (const t of sorted) {
    if (!t.symbol || t.symbol.includes(':') || !t.amount || !t.price) continue; // derivati o dati incompleti
    const [b, q] = t.symbol.split('/').map(normalizeCode);
    if (FIAT.has(b)) continue; // cambio tra valute fiat
    const ts = t.timestamp ?? Date.now();
    const qRate = await rate(q, ts);
    if (!qRate) {
      warnings.push(`Operazione ${t.symbol} del ${isoDate(ts)} ignorata: cambio ${q}/${base} non disponibile.`);
      continue;
    }
    const feeCost = t.fee?.cost ?? 0;
    const feeRate = feeCost && t.fee?.currency ? await rate(normalizeCode(t.fee.currency), ts) : 0;
    const buy = t.side === 'buy';
    const date = isoDate(ts);
    const id = t.id ?? `${ts}-${t.symbol}-${t.amount}`;
    txs.push({
      externalId: `${prefix}:trade:${id}`,
      date,
      type: buy ? 'acquisto' : 'vendita',
      assetKey: `crypto:${b}`,
      quantity: t.amount,
      price: t.price * qRate,
      fees: round2(feeCost * feeRate),
    });
    if (!FIAT.has(q)) {
      txs.push({
        externalId: `${prefix}:trade:${id}:q`,
        date,
        type: buy ? 'vendita' : 'acquisto',
        assetKey: `crypto:${q}`,
        quantity: t.cost ?? t.amount * t.price,
        price: qRate,
        fees: 0,
        note: `Contropartita ${t.symbol}`,
      });
    }
  }
  return txs;
}

/** Tassi da mercati dell'exchange: diretti, inversi o tramite USDT/USDC/BTC; storici con candela giornaliera. */
export function makeRates(ex: Exchange, base: string, warnings: string[]): RateFn {
  const cache = new Map<string, Promise<number | undefined>>();
  const warned = new Set<string>();

  const pair = async (from: string, to: string, ts?: number): Promise<number | undefined> => {
    if (from === to) return 1;
    for (const [symbol, inverse] of [
      [`${from}/${to}`, false],
      [`${to}/${from}`, true],
    ] as const) {
      if (!ex.markets[symbol]) continue;
      try {
        let v: number | undefined;
        if (ts === undefined) {
          const t = await ex.fetchTicker(symbol);
          v = t.last ?? t.close;
        } else {
          const candles = await ex.fetchOHLCV(symbol, '1d', Math.floor(ts / DAY) * DAY, 1);
          v = candles?.[0]?.[4];
        }
        if (v) return inverse ? 1 / v : v;
      } catch {
        // prova la coppia successiva
      }
    }
    return undefined;
  };

  const compute = async (cur: string, ts?: number) => {
    const direct = await pair(cur, base, ts);
    if (direct) return direct;
    for (const via of ['USDT', 'USDC', 'BTC']) {
      if (via === cur) continue;
      const a = await pair(cur, via, ts);
      const b = a && (await pair(via, base, ts));
      if (a && b) return a * b;
    }
    return undefined;
  };

  return async (cur, ts) => {
    if (cur === base) return 1;
    const key = `${cur}|${ts === undefined ? 'now' : Math.floor(ts / DAY)}`;
    if (!cache.has(key)) cache.set(key, compute(cur, ts));
    let v = await cache.get(key);
    if (!v && ts !== undefined) {
      v = await (async () => {
        const k = `${cur}|now`;
        if (!cache.has(k)) cache.set(k, compute(cur));
        return cache.get(k);
      })();
      if (v && !warned.has(cur)) {
        warned.add(cur);
        warnings.push(`Cambio storico ${cur}/${base} non disponibile: usato quello attuale.`);
      }
    }
    return v ?? 0;
  };
}

async function createExchange(id: string, credentials: Record<string, string>): Promise<Exchange> {
  const mod = (await import('ccxt')) as unknown as Record<string, unknown> & { default?: Record<string, unknown> };
  const Ctor = (mod[id] ?? mod.default?.[id]) as new (cfg: object) => Exchange;
  if (!Ctor) throw new ProviderError(`Exchange ${id} non supportato.`);
  return new Ctor({
    apiKey: credentials.apiKey,
    // Le chiavi Coinbase CDP arrivano spesso con "\n" letterali: li trasformiamo in a capo reali.
    secret: credentials.secret?.replace(/\\n/g, '\n'),
    // OKX richiede anche la passphrase scelta alla creazione della chiave.
    password: credentials.password,
    enableRateLimit: true,
    timeout: 30_000,
  });
}

function friendly(e: unknown, label: string): ProviderError {
  const name = (e as Error)?.constructor?.name ?? '';
  const msg = (e as Error)?.message ?? String(e);
  if (/Authentication|PermissionDenied|InvalidNonce/.test(name) || /invalid.*(key|signature)|api-key/i.test(msg)) {
    return new ProviderError(`${label}: chiave API non valida o senza i permessi di lettura.`);
  }
  if (/Network|RequestTimeout|ExchangeNotAvailable|DDoS/.test(name)) {
    return new ProviderError(`${label}: exchange non raggiungibile, riprova più tardi.`);
  }
  return new ProviderError(`${label}: ${msg.slice(0, 300)}`);
}

async function fetchAllTrades(
  id: string,
  ex: Exchange,
  since: number | undefined,
  held: string[],
  credentials: Record<string, string>,
): Promise<Trade[]> {
  if (id === 'binance') {
    const extra = (credentials.extraCoins ?? '')
      .split(/[\s,;]+/)
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    held = [...new Set([...held, ...extra])];
    // Binance richiede la coppia: interroghiamo quelle delle monete possedute.
    const symbols = Object.entries(ex.markets)
      .filter(([, m]) => m.spot && held.includes(m.base) && BINANCE_QUOTES.includes(m.quote))
      .map(([s]) => s);
    const out: Trade[] = [];
    for (const s of symbols) out.push(...(await ex.fetchMyTrades(s, since, undefined, { paginate: true })));
    return out;
  }
  if (id === 'kraken') {
    // Kraken restituisce 50 operazioni per pagina, con offset.
    const out: Trade[] = [];
    for (let ofs = 0; ofs < 20_000; ofs += 50) {
      const page = await ex.fetchMyTrades(undefined, since, undefined, { ofs });
      out.push(...page);
      if (page.length < 50) break;
    }
    return out;
  }
  if (id === 'okx') {
    // OKX espone via API le operazioni spot degli ultimi 3 mesi.
    return ex.fetchMyTrades(undefined, since, undefined, { paginate: true, instType: 'SPOT' });
  }
  return ex.fetchMyTrades(undefined, since, undefined, { paginate: true });
}

interface CcxtOptions extends Pick<Provider, 'guide' | 'docsUrl' | 'fields'> {
  /** Classe ccxt da usare, se dipende dalle credenziali (es. OKX Europa vs globale). */
  ccxtClass?: (credentials: Record<string, string>) => string;
  /** Conti interni da sommare (es. OKX: trading + funding). `undefined` = conto predefinito. */
  balanceTypes?: (string | undefined)[];
}

async function fetchTotals(ex: Exchange, types: (string | undefined)[]) {
  const totals: [string, number | undefined][] = [];
  for (const type of types) {
    const b = await ex.fetchBalance(type ? { type } : undefined);
    totals.push(...Object.entries(b.total));
  }
  return totals;
}

function ccxtProvider(id: string, label: string, extra: CcxtOptions): Provider {
  const { ccxtClass, balanceTypes = [undefined], ...info } = extra;
  const open = (credentials: Record<string, string>) => createExchange(ccxtClass?.(credentials) ?? id, credentials);
  return {
    id,
    label,
    category: 'crypto',
    description: 'Saldi, operazioni, depositi e prelievi con una chiave API di sola lettura.',
    available: true,
    ...info,
    async test(credentials) {
      const ex = await open(credentials);
      try {
        await ex.fetchBalance();
      } catch (e) {
        throw friendly(e, label);
      }
    },
    async sync(credentials, { currency, since }): Promise<SyncResult> {
      const ex = await open(credentials);
      const warnings: string[] = [];
      try {
        await ex.loadMarkets();
        const rate = makeRates(ex, currency, warnings);
        const sinceMs = since ? Date.parse(since) - 7 * DAY : undefined;

        const balances = new Map<string, number>();
        for (const [code, v] of await fetchTotals(ex, balanceTypes)) {
          if (!v || v <= 1e-10) continue;
          const c = normalizeCode(code);
          balances.set(c, (balances.get(c) ?? 0) + v);
        }
        const heldCrypto = [...balances.keys()].filter((c) => !FIAT.has(c));

        const trades = await fetchAllTrades(id, ex, sinceMs, heldCrypto, credentials);
        const transactions = await tradesToTxs(id, trades, currency, rate, warnings);

        // Depositi e prelievi in valuta base (bonifici verso/da l'exchange).
        for (const [method, type] of [
          ['fetchDeposits', 'deposito'],
          ['fetchWithdrawals', 'prelievo'],
        ] as const) {
          if (!ex.has[method]) continue;
          try {
            for (const d of await ex[method](currency, sinceMs)) {
              if (d.status !== 'ok' || !d.amount) continue;
              transactions.push({
                externalId: `${id}:${type}:${d.id ?? d.txid ?? d.timestamp}`,
                date: isoDate(d.timestamp),
                type,
                amount: round2(d.amount),
                fees: round2(d.fee?.cost ?? 0),
              });
            }
          } catch {
            warnings.push(`Impossibile leggere ${type === 'deposito' ? 'i depositi' : 'i prelievi'} in ${currency}.`);
          }
        }

        const assets = new Map<string, SyncAsset>();
        const touch = (code: string) => {
          const key = `crypto:${code}`;
          if (!assets.has(key)) {
            const name = ex.currencies[code]?.name;
            assets.set(key, { key, symbol: code, name: name && name !== code ? name : code, type: 'crypto' });
          }
          return assets.get(key)!;
        };
        for (const t of transactions) if (t.assetKey) touch(t.assetKey.slice('crypto:'.length));

        const holdings: SyncHolding[] = [];
        let cash = 0;
        for (const [code, qty] of balances) {
          const r = await rate(code);
          if (FIAT.has(code)) {
            if (r) cash += qty * r;
            else warnings.push(`Saldo in ${code} non convertibile in ${currency}: escluso.`);
            continue;
          }
          const asset = touch(code);
          if (r) asset.price = r;
          else warnings.push(`Prezzo di ${code} non disponibile su ${label}.`);
          holdings.push({ assetKey: asset.key, quantity: qty });
        }
        // Aggiorna il prezzo anche delle monete vendute del tutto (utile per lo storico).
        for (const a of assets.values()) if (a.price === undefined) a.price = (await rate(a.symbol)) || undefined;

        return {
          accountName: label,
          accountKind: 'wallet',
          currency,
          assets: [...assets.values()],
          transactions,
          holdings,
          cash: round2(cash),
          warnings,
        };
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        throw friendly(e, label);
      }
    },
  };
}

const keyFields = (secretLabel = 'Secret key') => [
  { key: 'apiKey', label: 'API key', secret: true },
  { key: 'secret', label: secretLabel, secret: true },
];

export const binance = ccxtProvider('binance', 'Binance', {
  docsUrl: 'https://www.binance.com/it/support/faq/detail/360002502072',
  fields: [
    ...keyFields(),
    {
      key: 'extraCoins',
      label: 'Monete vendute del tutto da includere (facoltativo)',
      placeholder: 'es. SOL, ADA, DOGE',
      optional: true,
    },
  ],
  guide: [
    'Su Binance: Profilo → Gestione API → Crea API → "Generata dal sistema".',
    'Lascia attivo SOLO "Abilita lettura". Non abilitare trading, prelievi o trasferimenti.',
    'Consigliato: limita l\'accesso a IP attendibili se hai un IP fisso.',
    'Incolla qui API key e Secret key (la secret è mostrata una sola volta).',
    'Binance permette di leggere lo storico solo coppia per coppia: vengono lette le monete che possiedi oggi più quelle che elenchi nel campo facoltativo.',
  ],
});

export const kraken = ccxtProvider('kraken', 'Kraken', {
  docsUrl: 'https://support.kraken.com/articles/360000919966-how-to-create-an-api-key',
  fields: keyFields('Private key'),
  guide: [
    'Su Kraken: Impostazioni → API → Crea chiave API.',
    'Permessi: solo "Query Funds", "Query Open Orders & Trades", "Query Closed Orders & Trades" e "Query Ledger Entries".',
    'Non abilitare deposito, prelievo o trading.',
    'Incolla qui API key e Private key.',
  ],
});

export const coinbase = ccxtProvider('coinbase', 'Coinbase', {
  docsUrl: 'https://docs.cdp.coinbase.com/coinbase-app/authentication-authorization/api-key-authentication',
  fields: [
    { key: 'apiKey', label: 'Nome chiave API (organizations/…/apiKeys/…)', secret: true },
    { key: 'secret', label: 'Chiave privata (-----BEGIN EC PRIVATE KEY-----…)', secret: true, multiline: true },
  ],
  guide: [
    'Vai su portal.cdp.coinbase.com → API Keys → Create API key (chiave "Secret API Key", algoritmo ECDSA).',
    'Permessi: solo "View" (lettura). Non abilitare "Trade" né "Transfer".',
    'Incolla qui il nome della chiave e la chiave privata completa, comprese le righe BEGIN/END.',
  ],
});

export const okx = ccxtProvider('okx', 'OKX', {
  docsUrl: 'https://www.okx.com/help/how-can-i-create-an-api-key',
  ccxtClass: (c) => (c.region === 'global' ? 'okx' : 'myokx'),
  balanceTypes: [undefined, 'funding'],
  fields: [
    {
      key: 'region',
      label: 'Piattaforma',
      options: [
        { value: 'eea', label: 'OKX Europa (utenti italiani/UE)' },
        { value: 'global', label: 'OKX globale (okx.com)' },
      ],
    },
    { key: 'apiKey', label: 'API key', secret: true },
    { key: 'secret', label: 'Secret key', secret: true },
    { key: 'password', label: 'Passphrase', secret: true },
  ],
  guide: [
    'Su OKX (sito web): Profilo → API → Crea chiave API V5.',
    'Permessi: solo "Lettura" (Read). Non selezionare "Trading" né "Prelievo".',
    'Scegli una passphrase e annotala: serve qui insieme ad API key e Secret key.',
    'Se il tuo account è su OKX Europa (utenti UE dal 2025), scegli quella piattaforma qui sotto.',
    'OKX fornisce via API solo le operazioni degli ultimi 3 mesi: ciò che possedevi prima entra come "Saldo iniziale". Vengono sommati conto Trading e conto Funding; i prodotti Earn non sono inclusi.',
  ],
});

function round2(n: number) {
  return Math.round(n * 100) / 100;
}
