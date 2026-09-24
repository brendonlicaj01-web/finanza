import { describe, expect, it } from 'vitest';
import { etoroToTxs, parseClosed, parsePosition } from './etoro.ts';

describe('eToro', () => {
  it('legge posizioni in camelCase e PascalCase', () => {
    expect(
      parsePosition({ PositionID: 7, InstrumentID: 1001, IsBuy: true, Leverage: 1, Units: 2.5, OpenRate: 180, OpenDateTime: '2025-02-03T10:00:00Z' }),
    ).toEqual({ positionId: '7', instrumentId: 1001, isBuy: true, leverage: 1, units: 2.5, openRate: 180, openDate: '2025-02-03' });
    expect(
      parseClosed({ positionId: 8, instrumentId: 1001, isBuy: true, leverage: 1, openRate: 100, amount: 500, closeRate: 120, closeTimestamp: '2025-06-01T09:00:00Z', openTimestamp: '2025-01-01T09:00:00Z', netProfit: 95 }),
    ).toMatchObject({ units: 5, closeDate: '2025-06-01', openDate: '2025-01-01', netProfit: 95 });
  });

  it('converte in euro, calcola i costi dalla differenza lordo/netto ed esclude i CFD', () => {
    const warnings: string[] = [];
    const fx = (date?: string) => (date === '2025-01-01' ? 0.95 : date === '2025-06-01' ? 0.9 : 0.92);
    const { transactions, holdings } = etoroToTxs(
      [
        { positionId: '1', instrumentId: 1001, isBuy: true, leverage: 1, units: 2, openRate: 100, openDate: '2025-01-01' },
        { positionId: '2', instrumentId: 1001, isBuy: true, leverage: 1, units: 1, openRate: 110, openDate: '2025-06-01' },
        { positionId: '3', instrumentId: 1002, isBuy: false, leverage: 1, units: 1, openRate: 50, openDate: '2025-06-01' },
        { positionId: '4', instrumentId: 1002, isBuy: true, leverage: 5, units: 1, openRate: 50, openDate: '2025-06-01' },
      ],
      [
        { positionId: '9', instrumentId: 1003, isBuy: true, leverage: 1, units: 5, openRate: 100, openDate: '2025-01-01', closeRate: 120, closeDate: '2025-06-01', netProfit: 95 },
      ],
      fx,
      warnings,
    );
    const byId = Object.fromEntries(transactions.map((t) => [t.externalId, t]));
    expect(byId['etoro:open:9']).toMatchObject({ type: 'acquisto', quantity: 5, price: 95, date: '2025-01-01' });
    expect(byId['etoro:close:9']).toMatchObject({ type: 'vendita', quantity: 5, price: 108, fees: 4.5 });
    expect(byId['etoro:open:1']).toMatchObject({ quantity: 2, price: 95 });
    expect(byId['etoro:open:3']).toBeUndefined();
    expect(byId['etoro:open:4']).toBeUndefined();
    expect(holdings).toEqual([{ assetKey: 'etoro:1001', quantity: 3, costPrice: (2 * 95 + 99) / 3 }]);
    expect(warnings[0]).toMatch(/2 posizioni con leva o short/);
  });
});
