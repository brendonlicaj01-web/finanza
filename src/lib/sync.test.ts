import { describe, expect, it } from 'vitest';
import { mergeSync } from './sync';
import { computePortfolio } from './portfolio';
import { emptyData } from './types';
import type { SyncResult } from './sync-types';

const conn = { id: 'c1', label: 'Broker X' };

const result = (over: Partial<SyncResult> = {}): SyncResult => ({
  accountName: 'Broker X',
  accountKind: 'broker',
  currency: 'EUR',
  assets: [
    { key: 'IE00BK5BQT80', symbol: 'VWCE', name: 'Vanguard All-World', type: 'etf', isin: 'IE00BK5BQT80', price: 130 },
  ],
  transactions: [
    { externalId: 'x:1', date: '2025-02-01', type: 'acquisto', assetKey: 'IE00BK5BQT80', quantity: 10, price: 100, fees: 1 },
    { externalId: 'x:2', date: '2025-03-01', type: 'vendita', assetKey: 'IE00BK5BQT80', quantity: 15, price: 120, fees: 1 },
    { externalId: 'x:3', date: '2025-04-01', type: 'dividendo', assetKey: 'IE00BK5BQT80', amount: 5, fees: 0 },
  ],
  holdings: [{ assetKey: 'IE00BK5BQT80', quantity: 20, costPrice: 90 }],
  cash: 1000,
  warnings: [],
  ...over,
});

describe('mergeSync', () => {
  it('prima sincronizzazione: crea conto e strumento, e un saldo iniziale coerente', () => {
    const { data, stats } = mergeSync(emptyData(), conn, result(), '2025-06-01');
    expect(data.accounts).toHaveLength(1);
    expect(data.accounts[0]).toMatchObject({ name: 'Broker X', connectionId: 'c1' });
    expect(data.assets[0]).toMatchObject({ symbol: 'VWCE', isin: 'IE00BK5BQT80', price: 130 });
    expect(stats).toMatchObject({ added: 3, newAssets: 1, adjustments: 2 });

    // 20 posseduti oggi = iniziale + 10 − 15 → saldo iniziale di 25 al prezzo di carico del broker.
    const opening = data.transactions.find((t) => t.note?.startsWith('Saldo iniziale (') && t.type === 'acquisto')!;
    expect(opening).toMatchObject({ date: '2025-01-31', quantity: 25, price: 90 });

    const r = computePortfolio(data);
    expect(r.warnings).toEqual([]);
    expect(r.positions[0].quantity).toBe(20);
    expect(r.cash[0].cash).toBeCloseTo(1000);
  });

  it('non duplica le transazioni e non crea rettifiche se i saldi coincidono', () => {
    const first = mergeSync(emptyData(), conn, result(), '2025-06-01').data;
    const again = mergeSync(first, conn, result(), '2025-06-02');
    expect(again.stats).toMatchObject({ added: 0, newAssets: 0, adjustments: 0 });
    expect(again.data.transactions).toHaveLength(first.transactions.length);
  });

  it('aggiunge le nuove operazioni e allinea le differenze alla data odierna', () => {
    const first = mergeSync(emptyData(), conn, result(), '2025-06-01').data;
    const next = result({
      transactions: [
        ...result().transactions,
        { externalId: 'x:4', date: '2025-06-10', type: 'acquisto', assetKey: 'IE00BK5BQT80', quantity: 5, price: 130, fees: 1 },
      ],
      holdings: [{ assetKey: 'IE00BK5BQT80', quantity: 26 }],
      cash: 1000 - 651,
      assets: [{ ...result().assets[0], price: 135 }],
    });
    const { data, stats } = mergeSync(first, conn, next, '2025-06-15');
    expect(stats).toMatchObject({ added: 1, adjustments: 2 });
    const adj = data.transactions.filter((t) => t.date === '2025-06-15');
    expect(adj.map((t) => t.type).sort()).toEqual(['acquisto', 'deposito']);
    expect(adj.find((t) => t.type === 'acquisto')).toMatchObject({ quantity: 1, price: 135 });
    const r = computePortfolio(data);
    expect(r.positions[0].quantity).toBe(26);
    expect(r.cash[0].cash).toBeCloseTo(349);
    expect(data.assets[0].price).toBe(135);
  });

  it('riconosce uno strumento già esistente per ISIN o simbolo', () => {
    const base = emptyData();
    base.assets = [{ id: 'mine', symbol: 'vwce', name: 'Mio VWCE', type: 'etf', price: 1, taxRate: 26 }];
    const { data, stats } = mergeSync(base, conn, result(), '2025-06-01');
    expect(stats.newAssets).toBe(0);
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0]).toMatchObject({ id: 'mine', name: 'Mio VWCE', isin: 'IE00BK5BQT80', price: 130 });
    expect(data.transactions.every((t) => !t.assetId || t.assetId === 'mine')).toBe(true);
  });

  it('chiude posizioni che la fonte non riporta più', () => {
    const first = mergeSync(emptyData(), conn, result(), '2025-06-01').data;
    const { data } = mergeSync(first, conn, result({ holdings: [], cash: undefined }), '2025-07-01');
    const sell = data.transactions.find((t) => t.date === '2025-07-01')!;
    expect(sell).toMatchObject({ type: 'vendita', quantity: 20 });
    expect(computePortfolio(data).positions[0].quantity).toBe(0);
  });
});

describe('mergeSync con obbligazioni in percentuale', () => {
  it('valorizza quantità nominale × prezzo % e converte tra convenzioni diverse', () => {
    const bond: SyncResult = {
      accountName: 'Fineco',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [
        { key: 'IT0005713539', symbol: 'BTP-23GN31', name: 'BTP', type: 'obbligazione', isin: 'IT0005713539', priceMultiplier: 0.01, taxRate: 12.5 },
      ],
      transactions: [
        { externalId: 'f:1', date: '2026-06-16', type: 'acquisto', assetKey: 'IT0005713539', quantity: 3000, price: 100, fees: 0 },
      ],
      warnings: [],
    };
    let { data } = mergeSync(emptyData(), { id: 'file:fineco', label: 'Fineco' }, bond, '2026-09-24');
    expect(data.assets[0]).toMatchObject({ priceMultiplier: 0.01, taxRate: 12.5 });
    data = { ...data, assets: data.assets.map((a) => ({ ...a, price: 100.03 })) };
    let r = computePortfolio(data);
    expect(r.positions[0].cost).toBeCloseTo(3000);
    expect(r.positions[0].avgPrice).toBeCloseTo(100);
    expect(r.positions[0].marketValue).toBeCloseTo(3000.9);

    // Un'altra fonte riporta lo stesso titolo con prezzo per unità (1,0005): viene convertito in %.
    const perUnit: SyncResult = {
      ...bond,
      assets: [{ key: 'IT0005713539', symbol: 'BTP-23GN31', name: 'BTP', type: 'obbligazione', isin: 'IT0005713539', price: 1.0005 }],
      transactions: [
        { externalId: 'x:1', date: '2026-07-01', type: 'acquisto', assetKey: 'IT0005713539', quantity: 1000, price: 0.99, fees: 0 },
      ],
    };
    data = mergeSync(data, { id: 'ibkr', label: 'IBKR' }, perUnit, '2026-09-24').data;
    expect(data.assets).toHaveLength(1);
    expect(data.assets[0].price).toBeCloseTo(100.05);
    expect(data.transactions.find((t) => t.externalId === 'x:1')!.price).toBeCloseTo(99);
    r = computePortfolio(data);
    expect(r.summary.marketValue).toBeCloseTo(4000 * 1.0005);
  });
});
