import { describe, expect, it } from 'vitest';
import { makeRates, normalizeCode, tradesToTxs } from './crypto.ts';
import { bitpandaToTxs } from './bitpanda.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2025, 2, 10, 12);

describe('tradesToTxs', () => {
  const rate = async (cur: string) => ({ EUR: 1, USDT: 0.9, BTC: 60000, BNB: 500 })[cur] ?? 0;

  it('valorizza in EUR e crea la contropartita per le coppie crypto/crypto', async () => {
    const warnings: string[] = [];
    const txs = await tradesToTxs(
      'binance',
      [
        { id: '2', timestamp: T0 + DAY, symbol: 'ETH/USDT', side: 'buy', amount: 2, price: 2000, cost: 4000, fee: { cost: 0.01, currency: 'BNB' } },
        { id: '1', timestamp: T0, symbol: 'BTC/EUR', side: 'sell', amount: 0.1, price: 59000, cost: 5900 },
        { id: '3', timestamp: T0, symbol: 'BTC/USDT:USDT', side: 'buy', amount: 1, price: 1 },
        { id: '4', timestamp: T0, symbol: 'EUR/USD', side: 'buy', amount: 1, price: 1.1 },
      ],
      'EUR',
      rate,
      warnings,
    );
    expect(txs).toEqual([
      { externalId: 'binance:trade:1', date: '2025-03-10', type: 'vendita', assetKey: 'crypto:BTC', quantity: 0.1, price: 59000, fees: 0 },
      { externalId: 'binance:trade:2', date: '2025-03-11', type: 'acquisto', assetKey: 'crypto:ETH', quantity: 2, price: 1800, fees: 5 },
      { externalId: 'binance:trade:2:q', date: '2025-03-11', type: 'vendita', assetKey: 'crypto:USDT', quantity: 4000, price: 0.9, fees: 0, note: 'Contropartita ETH/USDT' },
    ]);
    expect(warnings).toEqual([]);
  });

  it('segnala le operazioni senza cambio disponibile', async () => {
    const warnings: string[] = [];
    const txs = await tradesToTxs('kraken', [{ id: 'x', timestamp: T0, symbol: 'FOO/BAR', side: 'buy', amount: 1, price: 1 }], 'EUR', rate, warnings);
    expect(txs).toEqual([]);
    expect(warnings[0]).toMatch(/BAR\/EUR/);
  });
});

describe('makeRates', () => {
  const ex = {
    has: {},
    currencies: {},
    markets: { 'BTC/EUR': {}, 'EUR/USDT': {}, 'SOL/USDT': {} },
    async fetchTicker(s: string) {
      return { last: ({ 'BTC/EUR': 60000, 'EUR/USDT': 1.1, 'SOL/USDT': 150 } as Record<string, number>)[s] };
    },
    async fetchOHLCV(s: string): Promise<number[][]> {
      if (s === 'SOL/USDT') throw new Error('no history');
      return [[0, 0, 0, 0, s === 'BTC/EUR' ? 50000 : 1.25]];
    },
  } as never;

  it('usa coppie dirette, inverse e intermedie, con fallback al cambio attuale', async () => {
    const warnings: string[] = [];
    const rate = makeRates(ex, 'EUR', warnings);
    expect(await rate('EUR')).toBe(1);
    expect(await rate('BTC', T0)).toBe(50000);
    expect(await rate('USDT', T0)).toBeCloseTo(0.8);
    expect(await rate('USDT')).toBeCloseTo(1 / 1.1);
    expect(await rate('SOL', T0)).toBeCloseTo(150 / 1.1);
    expect(warnings).toEqual(['Cambio storico SOL/EUR non disponibile: usato quello attuale.']);
    expect(await rate('XYZ')).toBe(0);
  });
});

describe('normalizeCode', () => {
  it('riconduce i saldi in staking di Kraken alla moneta', () => {
    expect(normalizeCode('ETH.F')).toBe('ETH');
    expect(normalizeCode('BTC')).toBe('BTC');
  });
});

describe('bitpandaToTxs', () => {
  it('converte operazioni e movimenti fiat', () => {
    const warnings: string[] = [];
    const txs = bitpandaToTxs(
      [
        { id: 't1', attributes: { status: 'finished', type: 'buy', cryptocoin_id: '1', amount_fiat: '100', amount_cryptocoin: '0.002', fiat_to_eur_rate: '1', time: { date_iso8601: '2025-01-05T10:00:00+01:00' } } },
        { id: 't2', attributes: { status: 'pending', type: 'buy', cryptocoin_id: '1', amount_fiat: '5', amount_cryptocoin: '1', time: { unix: '1736000000' } } },
        { id: 't3', attributes: { type: 'sell', cryptocoin_id: '99', amount_fiat: '5', amount_cryptocoin: '1', time: { unix: '1736000000' } } },
      ],
      [
        { id: 'f1', attributes: { type: 'deposit', status: 'finished', amount: '500', fee: '0', time: { unix: '1735689600' } } },
        { id: 'f2', attributes: { type: 'transfer', status: 'finished', amount: '1', time: { unix: '1735689600' } } },
      ],
      new Map([['1', 'BTC']]),
      warnings,
    );
    expect(txs).toEqual([
      { externalId: 'bitpanda:trade:t1', date: '2025-01-05', type: 'acquisto', assetKey: 'crypto:BTC', quantity: 0.002, price: 50000, fees: 0 },
      { externalId: 'bitpanda:fiat:f1', date: '2025-01-01', type: 'deposito', amount: 500, fees: 0 },
    ]);
    expect(warnings).toHaveLength(1);
  });
});
