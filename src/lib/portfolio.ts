import type { Account, AppData, Asset, AssetType, Transaction } from './types';
import { multiplierOf } from './types';

/** Tolleranza per confronti tra quantità frazionarie (crypto, ETF frazionati). */
const EPS = 1e-9;

export interface Position {
  accountId: string;
  assetId: string;
  quantity: number;
  /** Costo di carico totale (metodo del costo medio ponderato, commissioni incluse). */
  cost: number;
  avgPrice: number;
  marketValue: number;
  unrealized: number;
  unrealizedPct: number;
  realized: number;
  income: number;
  fees: number;
}

export interface AccountCash {
  accountId: string;
  cash: number;
  deposits: number;
  withdrawals: number;
}

export interface YearReport {
  year: number;
  realized: number;
  income: number;
  interest: number;
  fees: number;
  deposits: number;
  withdrawals: number;
}

export interface Summary {
  marketValue: number;
  cost: number;
  unrealized: number;
  unrealizedPct: number;
  realized: number;
  income: number;
  fees: number;
  cash: number;
  netWorth: number;
  netDeposits: number;
  /** Guadagno complessivo: latente + realizzato + proventi − costi extra. */
  totalGain: number;
  estimatedTax: number;
}

export interface PortfolioResult {
  /** Posizioni per conto × strumento, comprese quelle chiuse (quantità 0). */
  positions: Position[];
  cash: AccountCash[];
  years: YearReport[];
  summary: Summary;
  warnings: string[];
}

const key = (accountId: string, assetId: string) => `${accountId}::${assetId}`;

/** Ordina per data, mantenendo l'ordine di inserimento a parità di data. */
export function sortTransactions(txs: Transaction[]): Transaction[] {
  return txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || a.i - b.i)
    .map(({ tx }) => tx);
}

export function computePortfolio(data: AppData): PortfolioResult {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const positions = new Map<string, Position>();
  const cash = new Map<string, AccountCash>();
  const years = new Map<number, YearReport>();
  const warnings: string[] = [];
  let standaloneFees = 0;
  let interest = 0;

  const cashOf = (accountId: string) => {
    let c = cash.get(accountId);
    if (!c) {
      c = { accountId, cash: 0, deposits: 0, withdrawals: 0 };
      cash.set(accountId, c);
    }
    return c;
  };
  const yearOf = (date: string) => {
    const y = Number(date.slice(0, 4));
    let r = years.get(y);
    if (!r) {
      r = { year: y, realized: 0, income: 0, interest: 0, fees: 0, deposits: 0, withdrawals: 0 };
      years.set(y, r);
    }
    return r;
  };
  const positionOf = (accountId: string, assetId: string) => {
    const k = key(accountId, assetId);
    let p = positions.get(k);
    if (!p) {
      p = {
        accountId,
        assetId,
        quantity: 0,
        cost: 0,
        avgPrice: 0,
        marketValue: 0,
        unrealized: 0,
        unrealizedPct: 0,
        realized: 0,
        income: 0,
        fees: 0,
      };
      positions.set(k, p);
    }
    return p;
  };

  for (const tx of sortTransactions(data.transactions)) {
    const c = cashOf(tx.accountId);
    const yr = yearOf(tx.date);
    const fees = tx.fees || 0;
    yr.fees += fees;

    switch (tx.type) {
      case 'acquisto': {
        if (!tx.assetId) break;
        const p = positionOf(tx.accountId, tx.assetId);
        const qty = tx.quantity ?? 0;
        const gross = qty * (tx.price ?? 0) * multiplierOf(assets.get(tx.assetId));
        p.quantity += qty;
        p.cost += gross + fees;
        p.fees += fees;
        c.cash -= gross + fees;
        break;
      }
      case 'vendita': {
        if (!tx.assetId) break;
        const p = positionOf(tx.accountId, tx.assetId);
        let qty = tx.quantity ?? 0;
        if (qty > p.quantity + EPS) {
          const name = assets.get(tx.assetId)?.symbol ?? tx.assetId;
          warnings.push(
            `Vendita del ${tx.date} di ${qty} ${name}: quantità superiore a quella posseduta (${round(p.quantity)}).`,
          );
          qty = p.quantity;
        }
        const gross = qty * (tx.price ?? 0) * multiplierOf(assets.get(tx.assetId));
        const avg = p.quantity > EPS ? p.cost / p.quantity : 0;
        const costOut = avg * qty;
        const gain = gross - fees - costOut;
        p.quantity -= qty;
        p.cost -= costOut;
        if (p.quantity < EPS) {
          p.quantity = 0;
          p.cost = 0;
        }
        p.realized += gain;
        p.fees += fees;
        yr.realized += gain;
        c.cash += gross - fees;
        break;
      }
      case 'dividendo': {
        const amount = (tx.amount ?? 0) - fees;
        if (tx.assetId) positionOf(tx.accountId, tx.assetId).income += amount;
        yr.income += amount;
        c.cash += amount;
        break;
      }
      case 'interessi': {
        const amount = (tx.amount ?? 0) - fees;
        interest += amount;
        yr.interest += amount;
        c.cash += amount;
        break;
      }
      case 'deposito': {
        const amount = tx.amount ?? 0;
        c.deposits += amount;
        yr.deposits += amount;
        c.cash += amount - fees;
        standaloneFees += fees;
        break;
      }
      case 'prelievo': {
        const amount = tx.amount ?? 0;
        c.withdrawals += amount;
        yr.withdrawals += amount;
        c.cash -= amount + fees;
        standaloneFees += fees;
        break;
      }
      case 'commissione': {
        const amount = (tx.amount ?? 0) + fees;
        standaloneFees += amount;
        yr.fees += tx.amount ?? 0;
        c.cash -= amount;
        break;
      }
    }
  }

  let marketValue = 0;
  let cost = 0;
  let realized = 0;
  let income = 0;
  let fees = 0;
  let estimatedTax = 0;

  for (const p of positions.values()) {
    const asset = assets.get(p.assetId);
    const price = asset?.price ?? 0;
    const mult = multiplierOf(asset);
    // Prezzo medio nella stessa unità del prezzo di mercato (es. % per le obbligazioni).
    p.avgPrice = p.quantity > EPS ? p.cost / p.quantity / mult : 0;
    p.marketValue = p.quantity * price * mult;
    p.unrealized = p.quantity > EPS ? p.marketValue - p.cost : 0;
    p.unrealizedPct = p.cost > EPS ? p.unrealized / p.cost : 0;
    marketValue += p.marketValue;
    cost += p.cost;
    realized += p.realized;
    income += p.income;
    fees += p.fees;
    if (p.unrealized > 0 && asset) estimatedTax += (p.unrealized * asset.taxRate) / 100;
  }
  // Dividendi registrati senza strumento associato.
  for (const tx of data.transactions) {
    if (tx.type === 'dividendo' && !tx.assetId) income += (tx.amount ?? 0) - (tx.fees || 0);
  }

  const cashList = [...cash.values()];
  const totalCash = data.settings.trackCash ? cashList.reduce((s, c) => s + c.cash, 0) : 0;
  const netDeposits = cashList.reduce((s, c) => s + c.deposits - c.withdrawals, 0);
  const unrealized = marketValue - cost;

  return {
    positions: [...positions.values()],
    cash: cashList,
    years: [...years.values()].sort((a, b) => b.year - a.year),
    warnings,
    summary: {
      marketValue,
      cost,
      unrealized,
      unrealizedPct: cost > EPS ? unrealized / cost : 0,
      realized,
      income: income + interest,
      fees: fees + standaloneFees,
      cash: totalCash,
      netWorth: marketValue + totalCash,
      netDeposits,
      totalGain: unrealized + realized + income + interest - standaloneFees,
      estimatedTax,
    },
  };
}

/** Quantità posseduta di uno strumento in un conto a una certa data (inclusa). */
export function quantityAt(
  txs: Transaction[],
  accountId: string,
  assetId: string,
  date: string,
  excludeId?: string,
): number {
  let q = 0;
  for (const tx of txs) {
    if (tx.id === excludeId || tx.accountId !== accountId || tx.assetId !== assetId || tx.date > date)
      continue;
    if (tx.type === 'acquisto') q += tx.quantity ?? 0;
    if (tx.type === 'vendita') q -= tx.quantity ?? 0;
  }
  return round(q);
}

export interface AggregatedPosition {
  asset: Asset;
  quantity: number;
  cost: number;
  avgPrice: number;
  marketValue: number;
  unrealized: number;
  unrealizedPct: number;
  realized: number;
  income: number;
  weight: number;
  accounts: Account[];
}

/** Unisce le posizioni dello stesso strumento detenute in conti diversi. */
export function aggregateByAsset(result: PortfolioResult, data: AppData): AggregatedPosition[] {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const byAsset = new Map<string, AggregatedPosition>();
  for (const p of result.positions) {
    const asset = assets.get(p.assetId);
    if (!asset) continue;
    let agg = byAsset.get(p.assetId);
    if (!agg) {
      agg = {
        asset,
        quantity: 0,
        cost: 0,
        avgPrice: 0,
        marketValue: 0,
        unrealized: 0,
        unrealizedPct: 0,
        realized: 0,
        income: 0,
        weight: 0,
        accounts: [],
      };
      byAsset.set(p.assetId, agg);
    }
    agg.quantity += p.quantity;
    agg.cost += p.cost;
    agg.marketValue += p.marketValue;
    agg.unrealized += p.unrealized;
    agg.realized += p.realized;
    agg.income += p.income;
    const account = accounts.get(p.accountId);
    if (account && p.quantity > EPS) agg.accounts.push(account);
  }
  const total = result.summary.marketValue;
  return [...byAsset.values()]
    .map((a) => ({
      ...a,
      avgPrice: a.quantity > EPS ? a.cost / a.quantity / multiplierOf(a.asset) : 0,
      unrealizedPct: a.cost > EPS ? a.unrealized / a.cost : 0,
      weight: total > EPS ? a.marketValue / total : 0,
    }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

export interface Slice {
  key: string;
  label: string;
  value: number;
  share: number;
}

function toSlices(map: Map<string, { label: string; value: number }>): Slice[] {
  const total = [...map.values()].reduce((s, v) => s + v.value, 0);
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, label: v.label, value: v.value, share: total > EPS ? v.value / total : 0 }))
    .filter((s) => s.value > EPS)
    .sort((a, b) => b.value - a.value);
}

/** Allocazione per tipo di strumento, con la liquidità come voce separata. */
export function allocationByType(
  result: PortfolioResult,
  data: AppData,
  labels: Record<AssetType, string>,
): Slice[] {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const map = new Map<string, { label: string; value: number }>();
  for (const p of result.positions) {
    const type = assets.get(p.assetId)?.type ?? 'altro';
    const cur = map.get(type) ?? { label: labels[type], value: 0 };
    cur.value += p.marketValue;
    map.set(type, cur);
  }
  if (result.summary.cash > EPS) map.set('liquidita', { label: 'Liquidità', value: result.summary.cash });
  return toSlices(map);
}

/** Allocazione per conto (investimenti + liquidità). */
export function allocationByAccount(result: PortfolioResult, data: AppData): Slice[] {
  const map = new Map<string, { label: string; value: number }>();
  for (const a of data.accounts) map.set(a.id, { label: a.name, value: 0 });
  for (const p of result.positions) {
    const cur = map.get(p.accountId);
    if (cur) cur.value += p.marketValue;
  }
  if (data.settings.trackCash) {
    for (const c of result.cash) {
      const cur = map.get(c.accountId);
      if (cur && c.cash > 0) cur.value += c.cash;
    }
  }
  return toSlices(map);
}

export function round(n: number, digits = 8): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
