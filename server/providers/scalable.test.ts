import { describe, expect, it } from 'vitest';
import { assetType, needsDetails, parseScOutput, scalableToSync } from './scalable.ts';

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

/** Output reale del CLI: busta macchina {ok, data} e, dentro, il contenitore {account_id, ..., result}. */
const wrap = (result: unknown, machine = true) => {
  const payload = { account_id: 'acc', portfolio_id: 'pf', resolution: { account: 'session', portfolio: 'context' }, result };
  return machine
    ? JSON.stringify({ ok: true, command: 'broker.transactions', data: payload })
    : JSON.stringify(payload, null, 2); // anche stampato su più righe
};

describe('parseScOutput', () => {
  it('estrae i dati dal contenitore "result", con o senza busta {ok, data}', () => {
    const tr = { cursor: null, total: 1, count: 1, items: [tx[0]] };
    expect(parseScOutput(wrap(tr))).toMatchObject({ items: [{ id: 't1' }] });
    expect(parseScOutput(wrap(tr, false))).toMatchObject({ items: [{ id: 't1' }] });
    expect(parseScOutput(JSON.stringify({ ok: true, command: 'whoami', data: { user: 'x' } }))).toEqual({ user: 'x' });
  });

  it('segnala errori e sessione mancante', () => {
    expect(() => parseScOutput('{"ok":false,"command":"x","error":{"code":"NO_SESSION","message":"No saved session"}}')).toThrow(/sc login/);
    expect(() => parseScOutput('{"ok":false,"command":"x","error":{"code":"BROKER_INPUT_INVALID","message":"bad"}}')).toThrow(/bad/);
    expect(() => parseScOutput('non json')).toThrow(/risposta non valida/);
  });

  it('con l\'output reale le transazioni arrivano (prima risultavano 0)', () => {
    const tr = parseScOutput(wrap({ cursor: null, items: tx }));
    const h = parseScOutput(wrap(holdings));
    const c = parseScOutput(wrap({ cash_balance: '1006.93' }));
    const r = scalableToSync(h, tr.items as never, c, 'EUR');
    expect(r.transactions).toHaveLength(6);
    expect(r.holdings).toHaveLength(1);
    expect(r.cash).toBe(1006.93);
  });
});

describe('Scalable con dettagli delle transazioni', () => {
  // Riepiloghi reali: niente nome del titolo, niente commissioni.
  const items = [
    { id: 'b1', summary_type: 'BrokerSecurityTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-02-10T10:00:00Z', isin: 'US8610121027', side: 'BUY', quantity: '4', amount: '400.99', security_transaction_type: 'SINGLE' },
    { id: 's1', summary_type: 'BrokerSecurityTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-05-10T10:00:00Z', isin: 'US8610121027', side: 'SELL', quantity: '4', amount: '470.00', security_transaction_type: 'SINGLE' },
    { id: 'd1', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-03-15T10:00:00Z', cash_transaction_type: 'DISTRIBUTION', related_isin: 'IE00BF11F565', amount: '7.36' },
    { id: 'b2', summary_type: 'BrokerSecurityTransactionSummary', status: 'SETTLED', is_cancellation: false, last_event_datetime: '2026-01-10T10:00:00Z', isin: 'US67066G1040', side: 'BUY', quantity: '1', amount: '120' },
  ];
  // Dettagli (`sc broker transaction details`), già estratti dal contenitore "result".
  const details = new Map<string, Record<string, unknown>>([
    ['b1', { id: 'b1', detail_type: 'security_trade', security: { isin: 'US8610121027', name: 'Stonex Group', security_type: 'EQUITY' }, security_trade: { side: 'BUY', number_of_shares: { filled: '4', total: '4' }, average_price: { amount: '100.00', currency: 'EUR' }, trade_transaction_amounts: { market_valuation: '400.00', transaction_fee: '0.99', venue_fee: '0', crypto_spread_fee: null, tax_amount: '0' } } }],
    ['s1', { id: 's1', detail_type: 'security_trade', security: { isin: 'US8610121027', name: 'Stonex Group', security_type: 'EQUITY' }, security_trade: { side: 'SELL', number_of_shares: { filled: '4', total: '4' }, trade_transaction_amounts: { market_valuation: '480.00', transaction_fee: '0.99' }, aggregated_transaction_taxes: { total_tax: '9.01' } } }],
    ['d1', { id: 'd1', detail_type: 'cash', cash: { cash_transaction_type: 'DISTRIBUTION', amount: '7.36', tax_details: { gross_amount: '10.00', tax_amount: '2.64' } } }],
  ]);
  const lookup = new Map([['US67066G1040', { name: 'NVIDIA', type: 'STOCK' }], ['IE00BF11F565', { name: 'iShares Core MSCI World', type: 'ETF' }]]);
  const r = scalableToSync({ items: [] }, items, { cash_balance: '0' }, 'EUR', details, lookup);
  const byId = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));

  it('usa nome e tipo veri (non l\'ISIN e "Altro")', () => {
    const names = Object.fromEntries(r.assets.map((a) => [a.isin, [a.name, a.type]]));
    expect(names).toEqual({
      US8610121027: ['Stonex Group', 'azione'],
      IE00BF11F565: ['iShares Core MSCI World', 'etf'],
      US67066G1040: ['NVIDIA', 'azione'],
    });
  });

  it('prende prezzo, commissioni e imposte dal dettaglio', () => {
    expect(byId['scalable:b1']).toMatchObject({ type: 'acquisto', quantity: 4, price: 100, fees: 0.99 });
    expect(byId['scalable:s1']).toMatchObject({ type: 'vendita', quantity: 4, price: 120, fees: 0.99 });
    expect(byId['scalable:s1:tax']).toMatchObject({ type: 'commissione', amount: 9.01 });
    expect(byId['scalable:d1']).toMatchObject({ type: 'dividendo', amount: 10, fees: 2.64, assetKey: 'IE00BF11F565' });
    // Senza dettaglio: prezzo dall'importo, con avviso.
    expect(byId['scalable:b2']).toMatchObject({ price: 120, fees: 0 });
    expect(r.warnings.join(' ')).toMatch(/1 operazioni senza dettaglio/);
  });

  it('segna la versione dei dati e lo storico completo, per correggere gli import precedenti', () => {
    expect(byId['scalable:b1'].rev).toBe(2);
    expect(byId['scalable:s1:tax'].rev).toBe(2);
    expect(byId['scalable:b2'].rev).toBe(1);
    expect(r.complete).toBe(true);
  });

  it('chiede i dettagli solo per operazioni concluse e proventi', () => {
    expect(needsDetails(items[0])).toBe(true);
    expect(needsDetails(items[2])).toBe(true);
    expect(needsDetails({ ...items[0], status: 'CANCELLED' })).toBe(false);
    expect(needsDetails({ id: 'x', summary_type: 'BrokerCashTransactionSummary', status: 'SETTLED', cash_transaction_type: 'DEPOSIT' })).toBe(false);
  });

  it('riconosce i tipi di strumento', () => {
    expect(assetType('EQUITY')).toBe('azione');
    expect(assetType('ETF')).toBe('etf');
    expect(assetType('', 'Vanguard FTSE All-World UCITS ETF', 'IE00BK5BQT80')).toBe('etf');
    expect(assetType('', 'Bitcoin', 'XF000BTC0017')).toBe('crypto');
    expect(assetType('')).toBe('altro');
  });
});
