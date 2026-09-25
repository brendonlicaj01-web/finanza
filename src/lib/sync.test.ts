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

describe('mergeSync con strumenti senza nome', () => {
  it('sostituisce l\'ISIN usato come nome e il tipo "Altro" quando arrivano i dati veri', () => {
    const base = emptyData();
    base.assets = [{ id: 'a1', symbol: 'IE00BF11F565', name: 'IE00BF11F565', type: 'altro', price: 5, taxRate: 26, isin: 'IE00BF11F565' }];
    const r: SyncResult = {
      accountName: 'Scalable Capital',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [{ key: 'IE00BF11F565', symbol: 'iShares Core MSCI World', name: 'iShares Core MSCI World', type: 'etf', isin: 'IE00BF11F565' }],
      transactions: [],
      warnings: [],
    };
    const { data } = mergeSync(base, { id: 'c', label: 'Scalable Capital' }, r, '2026-09-25');
    expect(data.assets[0]).toMatchObject({ id: 'a1', symbol: 'iShares Core MSCI World', type: 'etf' });
    // Un nome scelto dall'utente non viene sovrascritto.
    base.assets[0] = { ...base.assets[0], symbol: 'Il mio ETF', name: 'Il mio ETF', type: 'etf' };
    expect(mergeSync(base, { id: 'c', label: 'x' }, r, '2026-09-25').data.assets[0].symbol).toBe('Il mio ETF');
  });
});

describe('mergeSync con dati più completi dalla fonte', () => {
  const sc = { id: 'sc', label: 'Scalable Capital' };
  const asset = { key: 'IE00BK5BQT80', symbol: 'VWCE', name: 'Vanguard All-World', type: 'etf' as const, isin: 'IE00BK5BQT80', price: 130 };
  const holdings = [{ assetKey: 'IE00BK5BQT80', quantity: 20, costPrice: 90 }];
  // Come nelle versioni precedenti: prezzo ricavato dall'importo, niente commissioni, nessuna versione.
  const oldTx = [
    { externalId: 'scalable:d1', date: '2025-01-15', type: 'deposito' as const, amount: 2004, fees: 0 },
    { externalId: 'scalable:b1', date: '2025-02-01', type: 'acquisto' as const, assetKey: 'IE00BK5BQT80', quantity: 20, price: 100.1, fees: 0 },
  ];
  const newTx = [
    { ...oldTx[0], rev: 1 },
    { ...oldTx[1], price: 100, fees: 2, rev: 2 },
    { externalId: 'scalable:b1:tax', date: '2025-02-01', type: 'commissione' as const, amount: 2, fees: 0, rev: 2 },
  ];
  const r = (transactions: SyncResult['transactions'], complete = false): SyncResult => ({
    accountName: 'Scalable Capital',
    accountKind: 'broker',
    currency: 'EUR',
    assets: [asset],
    transactions,
    holdings,
    cash: 5,
    complete,
    warnings: [],
  });

  // Stato dell'utente: prima una sincronizzazione senza transazioni (saldo iniziale a oggi), poi le transazioni
  // arrivate "a metà" (allineamenti che vendono il doppione), infine la versione con dettagli e storico completo.
  const legacy = () => {
    let data = mergeSync(emptyData(), sc, r([]), '2026-09-20').data;
    data = mergeSync(data, sc, r(oldTx), '2026-09-24').data;
    return data;
  };

  it('aggiorna le transazioni importate senza dettagli e ricalcola gli allineamenti', () => {
    const before = legacy();
    expect(before.transactions.some((t) => t.note?.startsWith('Allineamento al saldo'))).toBe(true);

    const { data, stats } = mergeSync(before, sc, r(newTx, true), '2026-09-25');
    expect(stats).toMatchObject({ added: 1, updated: 2 });
    const buy = data.transactions.find((t) => t.externalId === 'scalable:b1')!;
    expect(buy).toMatchObject({ price: 100, fees: 2, rev: 2 });
    expect(buy.id).toBe(before.transactions.find((t) => t.externalId === 'scalable:b1')!.id);
    // Nessun saldo iniziale o allineamento rimasto: le transazioni spiegano tutto.
    // Resta solo la liquidità che le transazioni non spiegano, come saldo iniziale prima della prima operazione.
    expect(data.transactions.filter((t) => t.externalId?.startsWith('sc:adj'))).toMatchObject([
      { type: 'deposito', amount: 5, date: '2025-01-14', note: 'Saldo iniziale liquidità (Scalable Capital)' },
    ]);
    expect(data.transactions).toHaveLength(4);

    const p = computePortfolio(data);
    expect(p.positions[0]).toMatchObject({ quantity: 20 });
    expect(p.positions[0].cost).toBeCloseTo(2002);
    expect(p.cash[0].cash).toBeCloseTo(5);

    // Una seconda sincronizzazione identica non cambia nulla (l'allineamento della liquidità resta quello).
    const again = mergeSync(data, sc, r(newTx, true), '2026-09-26');
    expect(again.stats).toMatchObject({ added: 0, updated: 0, adjustments: 0 });
    expect(again.data.transactions).toEqual(data.transactions);
  });

  it('non tocca le transazioni modificate a mano', () => {
    const before = legacy();
    const edited = before.transactions.map((t) => (t.externalId === 'scalable:b1' ? { ...t, price: 99, edited: true } : t));
    const { data } = mergeSync({ ...before, transactions: edited }, sc, r(newTx, true), '2026-09-25');
    expect(data.transactions.find((t) => t.externalId === 'scalable:b1')).toMatchObject({ price: 99, fees: 0 });
  });

  it('senza versione più alta le transazioni esistenti restano come sono', () => {
    const before = legacy();
    const { stats } = mergeSync(before, sc, r(oldTx), '2026-09-25');
    expect(stats.updated).toBe(0);
  });
});
