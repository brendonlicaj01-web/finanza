import { randomUUID } from 'node:crypto';
import type { AssetType } from '../../src/lib/types.ts';
import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

const API = 'https://public-api.etoro.com/api/v1';

type Obj = Record<string, unknown>;

/** L'API eToro usa a volte camelCase, a volte PascalCase: leggiamo entrambi. */
function pick(o: Obj | undefined, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null) return o[k];
    const pascal = k[0].toUpperCase() + k.slice(1);
    if (o[pascal] !== undefined && o[pascal] !== null) return o[pascal];
  }
  return undefined;
}
const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const day = (v: unknown) => str(v).slice(0, 10);

/** Tipi strumento eToro (instrumentTypeID). */
function assetType(typeId: number): AssetType {
  switch (typeId) {
    case 5:
      return 'azione';
    case 6:
      return 'etf';
    case 10:
      return 'crypto';
    case 2:
      return 'materia_prima';
    default:
      return 'altro';
  }
}

export interface EtoroPosition {
  positionId: string;
  instrumentId: number;
  isBuy: boolean;
  leverage: number;
  units: number;
  openRate: number;
  openDate: string;
}

export interface EtoroClosed extends EtoroPosition {
  closeRate: number;
  closeDate: string;
  netProfit: number;
}

export function parsePosition(p: Obj): EtoroPosition {
  return {
    positionId: str(pick(p, 'positionID', 'positionId')),
    instrumentId: num(pick(p, 'instrumentID', 'instrumentId')),
    isBuy: pick(p, 'isBuy') !== false,
    leverage: num(pick(p, 'leverage')) || 1,
    units: num(pick(p, 'units')),
    openRate: num(pick(p, 'openRate')),
    openDate: day(pick(p, 'openDateTime', 'openTimestamp')),
  };
}

export function parseClosed(p: Obj): EtoroClosed {
  const base = parsePosition(p);
  const closeRate = num(pick(p, 'closeRate'));
  const netProfit = num(pick(p, 'netProfit'));
  let units = base.units;
  // Se le unità mancano, le ricaviamo dall'importo investito.
  if (!units) {
    const invested = num(pick(p, 'investment', 'amount', 'initialInvestment'));
    if (invested && base.openRate) units = (invested * base.leverage) / base.openRate;
  }
  return { ...base, units, closeRate, closeDate: day(pick(p, 'closeTimestamp', 'closeDateTime')), netProfit };
}

/**
 * Trasforma posizioni eToro (in USD) in transazioni. Solo posizioni "reali": acquisti senza leva.
 * Le posizioni con leva o short sono CFD e vengono segnalate e ignorate.
 * `fx(date)` restituisce la valuta base per 1 USD a quella data.
 */
export function etoroToTxs(
  open: EtoroPosition[],
  closed: EtoroClosed[],
  fx: (date?: string) => number,
  warnings: string[],
): { transactions: SyncTx[]; holdings: SyncHolding[] } {
  const transactions: SyncTx[] = [];
  const skipped = new Set<string>();
  const real = (p: EtoroPosition) => {
    if (p.isBuy && p.leverage <= 1) return true;
    skipped.add(p.positionId);
    return false;
  };
  const key = (id: number) => `etoro:${id}`;

  for (const c of closed.filter(real)) {
    if (!c.units || !c.openDate || !c.closeDate) {
      warnings.push(`Posizione chiusa ${c.positionId}: dati incompleti, ignorata.`);
      continue;
    }
    transactions.push({
      externalId: `etoro:open:${c.positionId}`,
      date: c.openDate,
      type: 'acquisto',
      assetKey: key(c.instrumentId),
      quantity: c.units,
      price: c.openRate * fx(c.openDate),
      fees: 0,
    });
    // I costi (commissioni, costi overnight) sono la differenza tra utile lordo e netto.
    const grossUsd = (c.closeRate - c.openRate) * c.units;
    const feesUsd = c.netProfit ? Math.max(0, grossUsd - c.netProfit) : 0;
    transactions.push({
      externalId: `etoro:close:${c.positionId}`,
      date: c.closeDate,
      type: 'vendita',
      assetKey: key(c.instrumentId),
      quantity: c.units,
      price: c.closeRate * fx(c.closeDate),
      fees: Math.round(feesUsd * fx(c.closeDate) * 100) / 100,
    });
  }

  const perAsset = new Map<string, { quantity: number; cost: number }>();
  for (const p of open.filter(real)) {
    if (!p.units) continue;
    const price = p.openRate * fx(p.openDate);
    transactions.push({
      externalId: `etoro:open:${p.positionId}`,
      date: p.openDate,
      type: 'acquisto',
      assetKey: key(p.instrumentId),
      quantity: p.units,
      price,
      fees: 0,
    });
    const h = perAsset.get(key(p.instrumentId)) ?? { quantity: 0, cost: 0 };
    h.quantity += p.units;
    h.cost += p.units * price;
    perAsset.set(key(p.instrumentId), h);
  }

  if (skipped.size) {
    warnings.push(
      `${skipped.size} posizioni con leva o short (CFD) non importate: l'app segue solo investimenti reali.`,
    );
  }
  const holdings = [...perAsset].map(([assetKey, h]) => ({
    assetKey,
    quantity: h.quantity,
    costPrice: h.cost / h.quantity,
  }));
  return { transactions, holdings };
}

class Client {
  constructor(
    private apiKey: string,
    private userKey: string,
  ) {}

  async get<T = Obj>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${API}${path}`, {
        headers: { 'x-api-key': this.apiKey, 'x-user-key': this.userKey, 'x-request-id': randomUUID() },
      });
    } catch (e) {
      throw new ProviderError(`eToro non raggiungibile: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new ProviderError('eToro: chiavi non valide o senza accesso in lettura al conto reale.');
    }
    if (res.status === 429) throw new ProviderError('eToro: troppe richieste, riprova tra un minuto.');
    if (!res.ok) throw new ProviderError(`eToro ha risposto con errore ${res.status}.`);
    return (await res.json()) as T;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Id eToro della coppia EUR/USD, cercata una volta (1 è il valore storico). */
async function eurUsdId(c: Client): Promise<number> {
  try {
    const r = await c.get<Obj>('/market-data/search?internalSymbolFull=EURUSD');
    const items = (pick(r, 'items') as Obj[]) ?? [];
    const hit = items.find((i) => str(pick(i, 'internalSymbolFull', 'symbolFull')).toUpperCase() === 'EURUSD');
    const id = num(pick(hit, 'instrumentId', 'instrumentID'));
    if (id) return id;
  } catch {
    // ripiega sull'id storico
  }
  return 1;
}

async function rates(c: Client, ids: number[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const r = await c.get<Obj>(`/market-data/instruments/rates?instrumentIds=${chunk.join(',')}`);
    for (const rate of ((pick(r, 'rates') as Obj[]) ?? [])) {
      const v = num(pick(rate, 'lastExecution')) || (num(pick(rate, 'bid')) + num(pick(rate, 'ask'))) / 2;
      if (v) out.set(num(pick(rate, 'instrumentID', 'instrumentId')), v);
    }
  }
  return out;
}

async function instruments(c: Client, ids: number[], warnings: string[]): Promise<Map<number, Obj>> {
  const out = new Map<number, Obj>();
  const read = (r: Obj) => {
    for (const d of ((pick(r, 'instrumentDisplayDatas') as Obj[]) ?? [])) {
      out.set(num(pick(d, 'instrumentID', 'instrumentId')), d);
    }
  };
  for (let i = 0; i < ids.length; i += 50) {
    read(await c.get<Obj>(`/market-data/instruments?instrumentIds=${ids.slice(i, i + 50).join(',')}`));
  }
  // Alcune versioni dell'API rispondono a un id per volta: completiamo i mancanti.
  for (const id of ids.filter((x) => !out.has(x))) {
    try {
      read(await c.get<Obj>(`/market-data/instruments?instrumentIds=${id}`));
      await sleep(100);
    } catch {
      warnings.push(`Dati dello strumento eToro ${id} non disponibili.`);
    }
  }
  return out;
}

/** Cambi storici giornalieri EUR/USD dalle candele eToro (fino a ~3 anni). */
async function fxHistory(c: Client, id: number): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const r = await c.get<Obj>(`/market-data/instruments/${id}/history/candles/desc/OneDay/1000`);
    let list: unknown = pick(r, 'candles');
    if (Array.isArray(list) && list.length && (list[0] as Obj) && pick(list[0] as Obj, 'candles')) {
      list = pick(list[0] as Obj, 'candles');
    }
    for (const k of (Array.isArray(list) ? list : []) as Obj[]) {
      const d = day(pick(k, 'fromDate', 'date'));
      const close = num(pick(k, 'close'));
      if (d && close) out.set(d, close);
    }
  } catch {
    // senza storico si usa il cambio attuale
  }
  return out;
}

export const etoro: Provider = {
  id: 'etoro',
  label: 'eToro',
  category: 'broker',
  description: 'Posizioni reali, operazioni chiuse, liquidità e prezzi tramite l\'API pubblica ufficiale.',
  available: true,
  docsUrl: 'https://builders.etoro.com/learn/authentication-and-api-keys',
  fields: [
    { key: 'apiKey', label: 'Public API key (x-api-key)', secret: true },
    { key: 'userKey', label: 'User key (x-user-key)', secret: true },
  ],
  guide: [
    'Il conto eToro deve essere verificato. Vai su eToro → Impostazioni → Trading → API (o builders.etoro.com).',
    'Crea una chiave per l\'ambiente "Real" con permesso di sola lettura (Read). Non abilitare il trading.',
    'Copia la Public API key e la User key e incollale qui.',
    'Importati: azioni, ETF e crypto reali (acquisti senza leva), anche delle copie CopyTrader. Le posizioni con leva o short (CFD) sono escluse. eToro lavora in dollari: tutto viene convertito in euro al cambio del giorno.',
  ],
  async test({ apiKey, userKey }) {
    await new Client(apiKey, userKey).get('/trading/info/portfolio');
  },
  async sync({ apiKey, userKey }, { currency, since }): Promise<SyncResult> {
    const c = new Client(apiKey, userKey);
    const warnings: string[] = [];

    const portfolio = await c.get<Obj>('/trading/info/portfolio');
    const cp = (pick(portfolio, 'clientPortfolio') as Obj) ?? portfolio;
    const rawOpen = [...(((pick(cp, 'positions') as Obj[]) ?? []))];
    let credit = num(pick(cp, 'credit'));
    for (const m of ((pick(cp, 'mirrors') as Obj[]) ?? [])) {
      rawOpen.push(...(((pick(m, 'positions') as Obj[]) ?? [])));
      credit += num(pick(m, 'availableAmount'));
    }
    const open = rawOpen.map(parsePosition);

    // Storico operazioni chiuse, paginato.
    const minDate = since ? day(new Date(Date.parse(since) - 7 * 86_400_000).toISOString()) : '2010-01-01';
    const closed: EtoroClosed[] = [];
    for (let page = 1; page <= 200; page++) {
      const r = await c.get<Obj | Obj[]>(`/trading/info/trade/history?minDate=${minDate}&page=${page}&pageSize=100`);
      const items = Array.isArray(r)
        ? r
        : ((pick(r, 'publicHistoryPositions', 'items', 'closedPositions') as Obj[]) ?? []);
      closed.push(...items.map(parseClosed));
      if (items.length < 100) break;
    }

    // Cambio USD → valuta base.
    let fx: (date?: string) => number = () => 1;
    if (currency !== 'USD') {
      if (currency !== 'EUR') {
        warnings.push(`eToro lavora in USD: conversione disponibile solo verso EUR, importi lasciati in USD.`);
      } else {
        const id = await eurUsdId(c);
        const now = (await rates(c, [id])).get(id);
        if (!now) throw new ProviderError('eToro: impossibile ottenere il cambio EUR/USD.');
        const hist = await fxHistory(c, id);
        let warned = false;
        fx = (date) => {
          if (date) {
            // Cerca il cambio del giorno o dei giorni precedenti (fine settimana, festivi).
            const d = new Date(`${date}T12:00:00Z`);
            for (let i = 0; i < 7; i++) {
              const v = hist.get(d.toISOString().slice(0, 10));
              if (v) return 1 / v;
              d.setUTCDate(d.getUTCDate() - 1);
            }
            if (!warned) {
              warned = true;
              warnings.push('Cambio EUR/USD storico non disponibile per alcune date: usato quello attuale.');
            }
          }
          return 1 / now;
        };
      }
    }

    const { transactions, holdings } = etoroToTxs(open, closed, fx, warnings);

    const ids = [...new Set([...open, ...closed].map((p) => p.instrumentId).filter(Boolean))];
    const [meta, prices] = await Promise.all([instruments(c, ids, warnings), rates(c, ids)]);
    const assets: SyncAsset[] = ids
      .filter((id) => transactions.some((t) => t.assetKey === `etoro:${id}`))
      .map((id) => {
        const m = meta.get(id);
        const price = prices.get(id);
        return {
          key: `etoro:${id}`,
          symbol: str(pick(m, 'symbolFull', 'internalSymbolFull')) || `ETORO-${id}`,
          name: str(pick(m, 'instrumentDisplayName', 'displayname')) || `Strumento eToro ${id}`,
          type: assetType(num(pick(m, 'instrumentTypeID', 'instrumentTypeId'))),
          price: price ? price * fx() : undefined,
        };
      });

    return {
      accountName: 'eToro',
      accountKind: 'broker',
      currency,
      assets,
      transactions,
      holdings,
      cash: Math.round(credit * fx() * 100) / 100,
      warnings,
    };
  },
};
