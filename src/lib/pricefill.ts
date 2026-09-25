import type { SyncResult } from './sync-types';

/** Prezzi giornalieri in euro per simbolo: { BTC: { '2025-11-21': 74000, … } }. */
export type PriceTable = Record<string, Record<string, number>>;

const symbolOf = (assetKey?: string) => (assetKey?.startsWith('crypto:') ? assetKey.slice(7).toUpperCase() : undefined);

function priceAt(table: PriceTable, symbol: string, date: string): number | undefined {
  const series = table[symbol];
  if (!series) return undefined;
  if (series[date]) return series[date];
  const days = Object.keys(series).sort();
  const before = days.filter((d) => d <= date).pop() ?? days[0];
  return before ? series[before] : undefined;
}

/** Simboli e data di partenza per cui servono prezzi. */
export function priceRequest(result: SyncResult): { symbols: string[]; from: string } | undefined {
  const symbols = new Set<string>();
  let from = '';
  for (const t of result.transactions) {
    const s = symbolOf(t.assetKey);
    if (!s) continue;
    symbols.add(s);
    if (!from || t.date < from) from = t.date;
  }
  for (const a of result.assets) if (a.type === 'crypto') symbols.add(a.symbol.toUpperCase());
  return symbols.size ? { symbols: [...symbols], from: from || new Date().toISOString().slice(0, 10) } : undefined;
}

/**
 * Aggiunge i prezzi del giorno a un import che non li contiene:
 * - operazioni senza prezzo → prezzo del giorno;
 * - scambi (`pair`) → ciò che si riceve costa quanto vale ciò che si dà;
 * - proventi in natura (dividendo con quantità) → importo = quantità × prezzo;
 * - strumenti → ultimo prezzo disponibile.
 * Le monete senza prezzo restano a zero e vengono elencate negli avvisi.
 */
export function fillPrices(result: SyncResult, table: PriceTable): SyncResult {
  const missing = new Set<string>();
  const transactions = result.transactions.map((t) => {
    const s = symbolOf(t.assetKey);
    if (!s) return t;
    const p = priceAt(table, s, t.date);
    if (!p) {
      missing.add(s);
      return t;
    }
    if (t.type === 'dividendo' && t.quantity && !t.amount) return { ...t, amount: Math.round(t.quantity * p * 100) / 100 };
    if (!t.price && t.quantity) return { ...t, price: p };
    return t;
  });
  // Scambi: valore dato in cambio → costo di ciò che si riceve (una sola moneta ricevuta).
  const groups = new Map<string, typeof transactions>();
  for (const t of transactions) if (t.pair) groups.set(t.pair, [...(groups.get(t.pair) ?? []), t]);
  for (const g of groups.values()) {
    const given = g.filter((t) => t.type === 'vendita');
    const got = g.filter((t) => t.type === 'acquisto');
    const value = given.reduce((s, t) => s + (t.price ?? 0) * (t.quantity ?? 0), 0);
    if (got.length === 1 && value > 0 && got[0].quantity) {
      const i = transactions.indexOf(got[0]);
      transactions[i] = { ...got[0], price: value / got[0].quantity };
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const assets = result.assets.map((a) => {
    if (a.type !== 'crypto' || a.price) return a;
    const p = priceAt(table, a.symbol.toUpperCase(), today);
    return p ? { ...a, price: p } : a;
  });
  const warnings = [...result.warnings];
  if (missing.size) {
    warnings.push(`Nessun prezzo di mercato per ${[...missing].join(', ')}: valori a zero, correggili a mano se servono.`);
  }
  return { ...result, transactions, assets, warnings };
}
