import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../../store.ts';
import { getJson } from './http.ts';

/**
 * Prezzi giornalieri in euro delle crypto, per valorizzare i movimenti on-chain al valore del giorno.
 * Fonte principale: Binance (dati pubblici, senza chiave); ripiego: CryptoCompare.
 * I giorni passati non cambiano: restano in cache in ~/.finanza/cache/prices.json.
 */

type DayPrices = Record<string, number>; // YYYY-MM-DD → prezzo in EUR

const CACHE_FILE = join(DATA_DIR, 'cache', 'prices.json');
/** Monete ancorate al dollaro: valgono 1 USDT. */
const USD_STABLE = new Set(['USDT', 'USDC', 'DAI', 'USDS', 'BUSD', 'TUSD', 'FDUSD', 'USDE', 'PYUSD', 'USDD', 'XDAI', 'USDC.E', 'USDBC']);
/** Monete ancorate all'euro. */
const EUR_STABLE = new Set(['EURC', 'EURS', 'EURE', 'EURCV', 'EURI']);
/** Token "incartati" che valgono come la moneta originale. */
const ALIAS: Record<string, string> = { WETH: 'ETH', WBTC: 'BTC', CBBTC: 'BTC', WBNB: 'BNB', WPOL: 'POL', WMATIC: 'POL', MATIC: 'POL', WAVAX: 'AVAX', WSOL: 'SOL', STETH: 'ETH', WEETH: 'ETH', CBETH: 'ETH', MSOL: 'SOL', JITOSOL: 'SOL', WTRX: 'TRX' };

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function priceSymbol(symbol: string): string {
  const s = symbol.toUpperCase();
  return ALIAS[s] ?? s;
}

interface Kline extends Array<number | string> {}

async function binanceDaily(pair: string, fromMs: number): Promise<DayPrices> {
  const out: DayPrices = {};
  let start = fromMs;
  for (let i = 0; i < 20; i++) {
    const rows = await getJson<Kline[]>(
      `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&startTime=${start}&limit=1000`,
      { label: 'Binance (prezzi)' },
    );
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out[dayOf(Number(r[0]))] = Number(r[4]);
    if (rows.length < 1000) break;
    start = Number(rows[rows.length - 1][0]) + 86_400_000;
  }
  return out;
}

async function cryptocompareDaily(symbol: string): Promise<DayPrices> {
  const r = await getJson<{ Response?: string; Data?: { Data?: { time: number; close: number }[] } }>(
    `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${encodeURIComponent(symbol)}&tsym=EUR&allData=true`,
    { label: 'CryptoCompare (prezzi)' },
  );
  const out: DayPrices = {};
  for (const d of r.Data?.Data ?? []) if (d.close > 0) out[dayOf(d.time * 1000)] = d.close;
  return out;
}

export class PriceBook {
  private cache: Record<string, DayPrices> = {};
  private loaded = false;
  /** Simboli per cui nessuna fonte ha prezzi. */
  readonly missing = new Set<string>();
  private eurUsdt?: DayPrices;

  constructor(
    private readonly fetchers = { binanceDaily, cryptocompareDaily },
    /** File di cache; `null` per non salvare nulla (test). */
    private readonly cacheFile: string | null = CACHE_FILE,
  ) {}

  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    if (!this.cacheFile) return;
    try {
      this.cache = JSON.parse(await readFile(this.cacheFile, 'utf8'));
    } catch {
      this.cache = {};
    }
  }

  async save() {
    if (!this.cacheFile) return;
    await mkdir(join(DATA_DIR, 'cache'), { recursive: true, mode: 0o700 });
    await writeFile(this.cacheFile, JSON.stringify(this.cache), { mode: 0o600 });
  }

  /** Quanti euro vale 1 USDT, giorno per giorno. */
  private async usdtInEur(fromMs: number): Promise<DayPrices> {
    if (!this.eurUsdt) {
      const eur = await this.fetchers.binanceDaily('EURUSDT', fromMs).catch(() => ({}) as DayPrices);
      this.eurUsdt = Object.fromEntries(Object.entries(eur).map(([d, p]) => [d, p ? 1 / p : 0]));
    }
    return this.eurUsdt;
  }

  /** Carica i prezzi giornalieri di un simbolo dalla data indicata (aggiorna solo i giorni mancanti). */
  async prepare(symbols: Iterable<string>, fromMs: number) {
    await this.load();
    for (const raw of new Set([...symbols].map(priceSymbol))) {
      if (EUR_STABLE.has(raw)) continue;
      const have = this.cache[raw] ?? {};
      const days = Object.keys(have).sort();
      // Già completo fino a ieri/oggi e dalla data richiesta: niente da scaricare.
      if (days.length && days[0] <= dayOf(fromMs) && days[days.length - 1] >= dayOf(Date.now() - 86_400_000)) continue;
      const from = days.length && days[0] <= dayOf(fromMs) ? Date.parse(`${days[days.length - 1]}T00:00:00Z`) : fromMs;
      let got: DayPrices = {};
      try {
        if (USD_STABLE.has(raw)) {
          got = await this.usdtInEur(from);
        } else {
          got = await this.fetchers.binanceDaily(`${raw}EUR`, from).catch(() => ({}) as DayPrices);
          if (!Object.keys(got).length) {
            const usdt = await this.fetchers.binanceDaily(`${raw}USDT`, from).catch(() => ({}) as DayPrices);
            const fx = Object.keys(usdt).length ? await this.usdtInEur(from) : {};
            for (const [d, p] of Object.entries(usdt)) if (fx[d]) got[d] = p * fx[d];
          }
          // Le coppie in euro su Binance esistono dal 2020 circa: per i giorni precedenti, CryptoCompare.
          const first = Object.keys(got).sort()[0];
          if (!first || first > dayOf(from)) {
            const older = await this.fetchers.cryptocompareDaily(raw).catch(() => ({}) as DayPrices);
            got = { ...older, ...got };
          }
        }
      } catch {
        got = {};
      }
      if (Object.keys(got).length) this.cache[raw] = { ...have, ...got };
      else if (!days.length) this.missing.add(raw);
    }
  }

  /** Prezzo in EUR del giorno (o del giorno disponibile più vicino prima), se noto. */
  at(symbol: string, ms: number): number | undefined {
    if (EUR_STABLE.has(priceSymbol(symbol))) return 1;
    const book = this.cache[priceSymbol(symbol)];
    if (!book) return undefined;
    const day = dayOf(ms);
    if (book[day]) return book[day];
    const days = Object.keys(book).sort();
    const before = days.filter((d) => d <= day).pop();
    // Prima dell'inizio della serie: il primo prezzo disponibile è meglio di nessun prezzo.
    return before ? book[before] : days.length ? book[days[0]] : undefined;
  }

  /** Serie giornaliera in euro di un simbolo (per l'import da file nel browser). */
  series(symbol: string): Record<string, number> | undefined {
    const raw = priceSymbol(symbol);
    if (EUR_STABLE.has(raw)) return { '1970-01-01': 1 };
    return this.cache[raw];
  }

  latest(symbol: string): number | undefined {
    return this.at(symbol, Date.now());
  }

  has(symbol: string): boolean {
    return EUR_STABLE.has(priceSymbol(symbol)) || !!this.cache[priceSymbol(symbol)];
  }
}
