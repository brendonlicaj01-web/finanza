import { describe, expect, it } from 'vitest';
import { scalableToSync } from './scalable.ts';

/** Risposte nel formato del CLI ufficiale (`sc broker holdings/transactions/cash-breakdown --json`). */
const holdings = {
  account_id: 'acc',
  portfolio_id: 'pf',
  count: 1,
  items: [
    {
      isin: 'IE00B4L5Y983',
      name: 'iShares Core MSCI World',
      security_type: 'ETF',
      quantity: '12.5',
      fifo_price: '80.00',
      valuation: '1250.00',
      valuation_currency: 'EUR',
      quote_mid_price: '100.00',
      quote_currency: 'EUR',
    },
  ],
};
const tx = [
  { id: 't1', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-01-02T09:00:00Z', cash_transaction_type: 'DEPOSIT', amount: '2000' },
  { id: 't2', summary_type: 'BrokerSecurityTransactionSummary', status: 'FILLED', is_cancellation: false, last_event_datetime: '2026-01-05T10:00:00Z', isin: 'IE00B4L5Y983', security_transaction_type: 'SINGLE', side: 'BUY', quantity: '10', amount: '800' },
  { id: 't3', summary_type: 'BrokerSecurityTransactionSummary', status: 'FILLED', is_cancellation: false, last_event_datetime: { time: '2026-02-05T10:00:00Z' }, isin: 'IE00B4L5Y983', security_transaction_type: 'SAVINGS_PLAN', side: 'BUY', quantity: '2.5', amount: '200' },
  { id: 't4', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-03-01T10:00:00Z', cash_transaction_type: 'DISTRIBUTION', related_isin: 'IE00B4L5Y983', amount: '5.20' },
  { id: 't5', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-03-01T10:00:00Z', cash_transaction_type: 'TAX', amount: '-1.37' },
  { id: 't6', summary_type: 'BrokerSecurityTransactionSummary', status: 'CANCELLED', is_cancellation: false, last_event_datetime: '2026-03-05T10:00:00Z', isin: 'IE00B4L5Y983', side: 'BUY', quantity: '1', amount: '99' },
  { id: 't7', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-04-01T10:00:00Z', cash_transaction_type: 'INTEREST', amount: '3.10' },
  { id: 't8', summary_type: 'FutureTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-04-02T10:00:00Z' },
];

describe('Scalable CLI', () => {
  const r = scalableToSync(holdings, tx, { cash_balance: '1006.93' }, 'EUR');

  it('mappa transazioni, piani di accumulo e movimenti di cassa', () => {
    expect(r.transactions.map((t) => [t.externalId, t.date, t.type, t.quantity ?? t.amount, t.price])).toEqual([
      ['scalable:t1', '2026-01-02', 'deposito', 2000, undefined],
      ['scalable:t2', '2026-01-05', 'acquisto', 10, 80],
      ['scalable:t3', '2026-02-05', 'acquisto', 2.5, 80],
      ['scalable:t4', '2026-03-01', 'dividendo', 5.2, undefined],
      ['scalable:t5', '2026-03-01', 'commissione', 1.37, undefined],
      ['scalable:t7', '2026-04-01', 'interessi', 3.1, undefined],
    ]);
    expect(r.transactions.find((t) => t.externalId === 'scalable:t3')?.note).toBe('Piano di accumulo');
    expect(r.warnings.join(' ')).toMatch(/FutureTransactionSummary/);
  });

  it('usa posizioni, prezzo di carico FIFO, quotazione e liquidità del CLI', () => {
    expect(r.holdings).toEqual([{ assetKey: 'IE00B4L5Y983', quantity: 12.5, costPrice: 80 }]);
    expect(r.assets[0]).toMatchObject({ isin: 'IE00B4L5Y983', name: 'iShares Core MSCI World', type: 'etf', price: 100 });
    expect(r.cash).toBe(1006.93);
  });
});
