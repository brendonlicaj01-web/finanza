import { describe, expect, it } from 'vitest';
import { aggregateByAsset, computePortfolio, quantityAt } from './portfolio';
import { emptyData, type AppData, type Transaction } from './types';
import { demoData } from './demo';
import { parseNumber } from './format';

function make(txs: Partial<Transaction>[], price = 12): AppData {
  const data = emptyData();
  data.accounts = [{ id: 'acc', name: 'Broker', kind: 'broker' }];
  data.assets = [{ id: 'x', symbol: 'X', name: 'X', type: 'etf', price, taxRate: 26 }];
  data.transactions = txs.map((t, i) => ({ id: `t${i}`, accountId: 'acc', fees: 0, date: '2025-01-01', type: 'acquisto', ...t }) as Transaction);
  return data;
}

describe('computePortfolio', () => {
  it('calcola prezzo medio ponderato con commissioni', () => {
    const r = computePortfolio(
      make([
        { date: '2025-01-01', assetId: 'x', quantity: 10, price: 10, fees: 2 },
        { date: '2025-02-01', assetId: 'x', quantity: 10, price: 12, fees: 2 },
      ]),
    );
    const p = r.positions[0];
    expect(p.quantity).toBe(20);
    expect(p.cost).toBeCloseTo(224);
    expect(p.avgPrice).toBeCloseTo(11.2);
    expect(p.marketValue).toBeCloseTo(240);
    expect(p.unrealized).toBeCloseTo(16);
    expect(r.summary.estimatedTax).toBeCloseTo(16 * 0.26);
  });

  it('realizza P&L sulla vendita al costo medio', () => {
    const r = computePortfolio(
      make([
        { date: '2025-01-01', assetId: 'x', quantity: 10, price: 10 },
        { date: '2025-01-02', assetId: 'x', quantity: 10, price: 20 },
        { date: '2025-03-01', type: 'vendita', assetId: 'x', quantity: 5, price: 18, fees: 1 },
      ]),
    );
    const p = r.positions[0];
    expect(p.quantity).toBe(15);
    expect(p.avgPrice).toBeCloseTo(15);
    expect(p.realized).toBeCloseTo(5 * 18 - 1 - 5 * 15);
    expect(r.years[0]).toMatchObject({ year: 2025 });
    expect(r.years[0].realized).toBeCloseTo(14);
  });

  it('azzera il costo quando la posizione viene chiusa', () => {
    const r = computePortfolio(
      make([
        { assetId: 'x', quantity: 3, price: 10 },
        { type: 'vendita', assetId: 'x', quantity: 3, price: 9 },
      ]),
    );
    expect(r.positions[0]).toMatchObject({ quantity: 0, cost: 0, marketValue: 0, unrealized: 0 });
    expect(r.positions[0].realized).toBeCloseTo(-3);
  });

  it('segnala vendite superiori alla quantità posseduta', () => {
    const r = computePortfolio(
      make([
        { assetId: 'x', quantity: 1, price: 10 },
        { type: 'vendita', assetId: 'x', quantity: 2, price: 10 },
      ]),
    );
    expect(r.warnings).toHaveLength(1);
    expect(r.positions[0].quantity).toBe(0);
  });

  it('ordina per data prima di calcolare', () => {
    const r = computePortfolio(
      make([
        { date: '2025-05-01', type: 'vendita', assetId: 'x', quantity: 1, price: 15 },
        { date: '2025-01-01', assetId: 'x', quantity: 2, price: 10 },
      ]),
    );
    expect(r.warnings).toHaveLength(0);
    expect(r.positions[0].realized).toBeCloseTo(5);
  });

  it('traccia la liquidità e il guadagno complessivo', () => {
    const r = computePortfolio(
      make([
        { type: 'deposito', amount: 1000 },
        { assetId: 'x', quantity: 50, price: 10, fees: 5 },
        { type: 'dividendo', assetId: 'x', amount: 20, fees: 5 },
        { type: 'commissione', amount: 2 },
      ]),
    );
    const s = r.summary;
    expect(s.cash).toBeCloseTo(1000 - 505 + 15 - 2);
    expect(s.marketValue).toBeCloseTo(600);
    expect(s.netWorth).toBeCloseTo(1108);
    expect(s.netDeposits).toBe(1000);
    // Il guadagno complessivo coincide con patrimonio − versato.
    expect(s.totalGain).toBeCloseTo(s.netWorth - s.netDeposits);
  });

  it('non conta la liquidità se il tracciamento è disattivato', () => {
    const data = make([{ assetId: 'x', quantity: 1, price: 10 }]);
    data.settings.trackCash = false;
    expect(computePortfolio(data).summary.netWorth).toBeCloseTo(12);
  });

  it('i dati di esempio sono coerenti', () => {
    const data = demoData('2026-09-24');
    const r = computePortfolio(data);
    expect(r.warnings).toEqual([]);
    expect(r.cash.every((c) => c.cash >= 0)).toBe(true);
    expect(r.summary.totalGain).toBeCloseTo(r.summary.netWorth - r.summary.netDeposits);
    const agg = aggregateByAsset(r, data);
    expect(agg.reduce((s, a) => s + a.weight, 0)).toBeCloseTo(1);
  });
});

describe('quantityAt', () => {
  it('considera solo le transazioni fino alla data, escludendo quella in modifica', () => {
    const txs = make([
      { id: 'a', date: '2025-01-01', assetId: 'x', quantity: 5, price: 1 },
      { id: 'b', date: '2025-02-01', type: 'vendita', assetId: 'x', quantity: 2, price: 1 },
      { id: 'c', date: '2025-03-01', assetId: 'x', quantity: 4, price: 1 },
    ]).transactions;
    expect(quantityAt(txs, 'acc', 'x', '2025-02-15')).toBe(3);
    expect(quantityAt(txs, 'acc', 'x', '2025-02-15', 'b')).toBe(5);
    expect(quantityAt(txs, 'acc', 'x', '2025-12-31')).toBe(7);
  });
});

describe('parseNumber', () => {
  it('accetta il formato italiano', () => {
    expect(parseNumber('1.234,56')).toBeCloseTo(1234.56);
    expect(parseNumber('12,5')).toBe(12.5);
    expect(parseNumber('0.045')).toBe(0.045);
    expect(parseNumber('')).toBeNaN();
  });
});
