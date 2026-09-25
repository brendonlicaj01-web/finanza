import { describe, expect, it } from 'vitest';
import { cryptoTicker, findDuplicates, identityKey, mergeAssets } from './assets';
import { findTransfers } from './transfers';
import { computePortfolio } from './portfolio';
import { mergeSync } from './sync';
import { emptyData, type AppData, type Asset } from './types';
import type { SyncResult } from './sync-types';

const crypto = (id: string, symbol: string, name = symbol, isin?: string): Asset => ({ id, symbol, name, type: 'crypto', price: 0, taxRate: 26, ...(isin ? { isin } : {}) });

describe('identità delle crypto', () => {
  it('ricava il ticker da ISIN crypto, nome esteso o simbolo', () => {
    expect(cryptoTicker(crypto('a', 'Bitcoin', 'Bitcoin', 'XF000BTC0017'))).toBe('BTC');
    expect(cryptoTicker(crypto('a', 'XF000ETH0019', '', 'XF000ETH0019'))).toBe('ETH');
    expect(cryptoTicker(crypto('a', 'Bitcoin Cash'))).toBe('BCH');
    expect(cryptoTicker(crypto('a', 'Ethereum'))).toBe('ETH');
    expect(cryptoTicker(crypto('a', 'btc'))).toBe('BTC');
    // Token diversi restano diversi.
    expect(cryptoTicker(crypto('a', 'WBTC'))).toBe('WBTC');
    expect(cryptoTicker({ symbol: 'VWCE', name: 'Vanguard', type: 'etf' })).toBeUndefined();
    expect(identityKey({ id: 'x', symbol: 'VWCE', name: 'Vanguard', type: 'etf', price: 0, taxRate: 26, isin: 'IE00BK5BQT80' })).toBe('isin:IE00BK5BQT80');
  });
});

describe('strumenti doppi', () => {
  const data = (): AppData => {
    const d = emptyData();
    d.accounts = [
      { id: 'sc', name: 'Scalable', kind: 'broker' },
      { id: 'tr', name: 'Trade Republic', kind: 'broker' },
    ];
    d.assets = [
      { ...crypto('sc-btc', 'Bitcoin', 'Bitcoin', 'XF000BTC0017'), price: 90000, priceUpdatedAt: '2026-09-25' },
      { ...crypto('tr-btc', 'BTC', 'Bitcoin'), price: 88000, priceUpdatedAt: '2026-09-20' },
      crypto('eth', 'ETH'),
    ];
    d.transactions = [
      { id: 't1', date: '2025-01-02', type: 'acquisto', accountId: 'sc', assetId: 'sc-btc', quantity: 0.1, price: 40000, fees: 0 },
      { id: 't2', date: '2025-06-10', type: 'trasf_uscita', accountId: 'sc', assetId: 'sc-btc', quantity: 0.1, price: 60000, fees: 0, externalId: 'scalable:o' },
      { id: 't3', date: '2025-06-11', type: 'trasf_entrata', accountId: 'tr', assetId: 'tr-btc', quantity: 0.1, price: 60000, fees: 0, externalId: 'tr:i' },
    ];
    return d;
  };

  it('i trasferimenti tra "Bitcoin" di Scalable e "BTC" di Trade Republic si abbinano anche prima di unire', () => {
    const d = data();
    expect(findTransfers(d).pairs).toMatchObject([{ labeled: true, confidence: 'alta' }]);
    const tr = computePortfolio(d).positions.find((p) => p.accountId === 'tr')!;
    expect(tr.cost).toBeCloseTo(4000);
  });

  it('propone di unire, tenendo il simbolo BTC; unendo, le transazioni passano allo strumento principale', () => {
    const d = data();
    const [g] = findDuplicates(d);
    expect(findDuplicates(d)).toHaveLength(1);
    expect(g.primary.id).toBe('tr-btc');
    expect(g.others.map((a) => a.id)).toEqual(['sc-btc']);
    const m = mergeAssets(d, g.primary.id, g.others.map((a) => a.id));
    expect(m.assets.map((a) => a.id)).toEqual(['tr-btc', 'eth']);
    // Prende l'ISIN e il prezzo più recente dallo strumento eliminato.
    expect(m.assets[0]).toMatchObject({ symbol: 'BTC', isin: 'XF000BTC0017', price: 90000, priceUpdatedAt: '2026-09-25' });
    expect(new Set(m.transactions.map((t) => t.assetId))).toEqual(new Set(['tr-btc']));
    expect(findDuplicates(m)).toEqual([]);
    // Una sola posizione BTC, con il costo intatto.
    const btc = computePortfolio(m).positions.filter((p) => p.quantity > 0);
    expect(btc).toHaveLength(1);
    expect(btc[0].cost).toBeCloseTo(4000);
  });

  it('dopo l\'unione, la sincronizzazione di Scalable ritrova lo strumento BTC (per ISIN o ticker)', () => {
    const merged = mergeAssets(data(), 'tr-btc', ['sc-btc']);
    merged.accounts[0].connectionId = 'scal';
    const r: SyncResult = {
      accountName: 'Scalable',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [{ key: 'XF000BTC0017', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', isin: 'XF000BTC0017', price: 91000 }],
      transactions: [],
      warnings: [],
    };
    const { data: after, stats } = mergeSync(merged, { id: 'scal', label: 'Scalable' }, r, '2026-09-26');
    expect(stats.newAssets).toBe(0);
    expect(after.assets.filter((a) => cryptoTicker(a) === 'BTC')).toHaveLength(1);
    // Anche una crypto nuova senza ISIN trova lo strumento esistente per ticker.
    const plain = mergeSync(emptyData(), { id: 'x', label: 'x' }, { ...r, assets: [{ key: 'b', symbol: 'Bitcoin', name: 'Bitcoin', type: 'crypto' }] }, '2026-09-26').data;
    const again = mergeSync(plain, { id: 'y', label: 'y' }, { ...r, assets: [{ key: 'c', symbol: 'BTC', name: 'BTC', type: 'crypto' }] }, '2026-09-26');
    expect(again.stats.newAssets).toBe(0);
  });
});
