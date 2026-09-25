import { describe, expect, it } from 'vitest';
import { findTransfers } from './transfers';
import { computePortfolio } from './portfolio';
import { emptyData, type AppData, type Transaction } from './types';

let n = 0;
const tx = (o: Partial<Transaction> & Pick<Transaction, 'date' | 'type' | 'accountId'>): Transaction => ({
  id: `t${++n}`,
  fees: 0,
  ...o,
});

function base(): AppData {
  const d = emptyData();
  d.accounts = [
    { id: 'tr', name: 'Trade Republic', kind: 'broker' },
    { id: 'okx', name: 'OKX', kind: 'wallet' },
    { id: 'bank', name: 'Banca', kind: 'banca' },
    { id: 'sc', name: 'Scalable', kind: 'broker' },
    { id: 'kr', name: 'Kraken', kind: 'wallet' },
  ];
  d.assets = [
    { id: 'btc-tr', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', price: 60000, taxRate: 26 },
    // Stessa moneta registrata come strumento distinto da un altro import: si riconosce dal simbolo.
    { id: 'btc-okx', symbol: 'btc', name: 'BTC', type: 'crypto', price: 60000, taxRate: 26 },
    { id: 'etf', symbol: 'VWCE', name: 'Vanguard All-World', type: 'etf', price: 130, taxRate: 26, isin: 'IE00BK5BQT80' },
  ];
  return d;
}

/** Trasferimento come lo registrano gli import: operazione + movimento speculare `:cash`. */
function transferLeg(accountId: string, assetId: string, date: string, type: 'acquisto' | 'vendita', quantity: number, price: number, id: string, note: string) {
  return [
    tx({ accountId, assetId, date, type, quantity, price, externalId: id, note }),
    tx({ accountId, date, type: type === 'acquisto' ? 'deposito' : 'prelievo', amount: Math.round(quantity * price * 100) / 100, externalId: `${id}:cash` }),
  ];
}

describe('findTransfers', () => {
  it('riconosce BTC inviati da Trade Republic e ricevuti su OKX, con commissione di rete e plusvalenza finta', () => {
    const d = base();
    d.transactions = [
      tx({ accountId: 'tr', date: '2025-01-01', type: 'deposito', amount: 3000 }),
      tx({ accountId: 'tr', assetId: 'btc-tr', date: '2025-01-02', type: 'acquisto', quantity: 0.05, price: 40000, externalId: 'tr:buy' }),
      ...transferLeg('tr', 'btc-tr', '2025-06-10', 'vendita', 0.0501, 60000, 'tr:out', 'Inviati ad altro conto'),
      ...transferLeg('okx', 'btc-okx', '2025-06-11', 'acquisto', 0.05, 60000, 'okx:f:1', 'Deposito crypto (carico al valore del giorno)'),
    ];
    // Quantità vendute oltre il posseduto vengono troncate: qui la vendita è 0,0501 contro 0,05.
    d.transactions[1].quantity = 0.0501;
    const { pairs, unmatched } = findTransfers(d, computePortfolio(d).saleGains);
    expect(unmatched).toEqual([]);
    expect(pairs).toHaveLength(1);
    const p = pairs[0];
    expect(p).toMatchObject({ kind: 'titoli', days: 1, difference: 0.0001, confidence: 'alta' });
    expect(p.out.externalId).toBe('tr:out');
    expect(p.in.externalId).toBe('okx:f:1');
    expect(p.outCash?.externalId).toBe('tr:out:cash');
    expect(p.inCash?.externalId).toBe('okx:f:1:cash');
    // 0,0501 × (60.000 − 40.000) = 1.002 € registrati oggi come guadagno realizzato.
    expect(p.recordedGain).toBeCloseTo(1002);
  });

  it('non scambia per trasferimento una vendita e un acquisto veri su due conti', () => {
    const d = base();
    d.transactions = [
      tx({ accountId: 'tr', assetId: 'etf', date: '2025-01-02', type: 'acquisto', quantity: 10, price: 100 }),
      tx({ accountId: 'tr', assetId: 'etf', date: '2025-03-02', type: 'vendita', quantity: 10, price: 120 }),
      tx({ accountId: 'sc', assetId: 'etf', date: '2025-03-03', type: 'acquisto', quantity: 10, price: 121 }),
    ];
    expect(findTransfers(d).pairs).toEqual([]);
  });

  it('abbina uno a uno i bonifici tra conti, scegliendo il più vicino', () => {
    const d = base();
    d.transactions = [
      tx({ accountId: 'bank', date: '2025-02-01', type: 'prelievo', amount: 500, note: 'Bonifico a Scalable' }),
      tx({ accountId: 'bank', date: '2025-03-01', type: 'prelievo', amount: 500, note: 'Bonifico a Scalable' }),
      tx({ accountId: 'sc', date: '2025-03-03', type: 'deposito', amount: 500 }),
      tx({ accountId: 'sc', date: '2025-02-02', type: 'deposito', amount: 500 }),
      // Pagamento qualsiasi senza controparte.
      tx({ accountId: 'bank', date: '2025-02-10', type: 'prelievo', amount: 80 }),
      // Costo del bonifico: arrivano 1,50 € in meno.
      tx({ accountId: 'bank', date: '2025-04-01', type: 'prelievo', amount: 1000 }),
      tx({ accountId: 'okx', date: '2025-04-02', type: 'deposito', amount: 998.5 }),
    ];
    const { pairs } = findTransfers(d);
    expect(pairs.map((p) => [p.out.date, p.in.date, p.days, p.difference, p.confidence])).toEqual([
      ['2025-04-01', '2025-04-02', 1, 1.5, 'media'],
      ['2025-03-01', '2025-03-03', 2, 0, 'alta'],
      ['2025-02-01', '2025-02-02', 1, 0, 'alta'],
    ]);
  });

  it('abbina un invio a un saldo iniziale stimato, con fiducia più bassa', () => {
    const d = base();
    d.transactions = [
      ...transferLeg('tr', 'btc-tr', '2025-06-10', 'vendita', 0.5, 60000, 'tr:out', 'Inviati ad altro conto'),
      tx({ accountId: 'kr', assetId: 'btc-okx', date: '2024-12-31', type: 'acquisto', quantity: 0.4995, price: 60000, externalId: 'k:adj:btc-okx:2024-12-31:1', note: 'Saldo iniziale (Kraken)' }),
    ];
    const [p] = findTransfers(d).pairs;
    expect(p.confidence).toBe('bassa');
    expect(p.reasons.join(' ')).toMatch(/stimata/);
  });

  it('segnala gli invii verso conti non collegati e ignora i movimenti automatici di Fineco', () => {
    const d = base();
    d.transactions = [
      ...transferLeg('tr', 'btc-tr', '2025-06-10', 'vendita', 0.1, 60000, 'tr:cold', 'Inviati ad altro conto'),
      // Import Fineco con "Bilancia la liquidità": acquisto + addebito automatico, non un trasferimento.
      tx({ accountId: 'sc', assetId: 'etf', date: '2025-03-03', type: 'acquisto', quantity: 10, price: 100, externalId: 'fin:1' }),
      tx({ accountId: 'sc', date: '2025-03-03', type: 'deposito', amount: 1000, externalId: 'fin:1:cash', note: 'Addebito da conto corrente (automatico)' }),
      tx({ accountId: 'bank', date: '2025-03-03', type: 'prelievo', amount: 1000 }),
    ];
    const { pairs, unmatched } = findTransfers(d);
    expect(unmatched.map((t) => t.externalId)).toEqual(['tr:cold']);
    expect(pairs).toEqual([]);
  });
});
