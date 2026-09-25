import { describe, expect, it } from 'vitest';
import { counterparts, decide, findTransfers } from './transfers';
import { reducer } from '../store';
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

describe('etichetta "Trasferimento crypto interno"', () => {
  const labeled = () => {
    const d = base();
    d.transactions = [
      tx({ accountId: 'tr', date: '2025-01-01', type: 'deposito', amount: 2001 }),
      tx({ accountId: 'tr', assetId: 'btc-tr', date: '2025-01-02', type: 'acquisto', quantity: 0.05, price: 40000, fees: 1 }),
      tx({ id: 'out', accountId: 'tr', assetId: 'btc-tr', date: '2025-06-10', type: 'trasf_uscita', quantity: 0.05, price: 60000, externalId: 'tr:out' }),
      // Registrata dal wallet un giorno prima (fuso orario): il costo arriva comunque dall'uscita.
      tx({ id: 'in', accountId: 'okx', assetId: 'btc-okx', date: '2025-06-09', type: 'trasf_entrata', quantity: 0.0499, price: 60000, externalId: 'okx:f:1' }),
    ];
    return d;
  };

  it('sposta quantità e costo di carico, senza plusvalenza né versamenti o prelievi', () => {
    const p = computePortfolio(labeled());
    const at = (acc: string) => p.positions.find((x) => x.accountId === acc)!;
    expect(at('tr')).toMatchObject({ quantity: 0, cost: 0, realized: 0 });
    // 0,0001 BTC di commissione di rete: il costo di 2.001 € resta tutto sulle monete arrivate.
    expect(at('okx').quantity).toBeCloseTo(0.0499);
    expect(at('okx').cost).toBeCloseTo(2001);
    expect(p.summary.realized).toBe(0);
    expect(p.summary.netDeposits).toBe(2001);
    expect(p.cash.find((c) => c.accountId === 'okx')?.cash ?? 0).toBe(0);
    expect(p.warnings).toEqual([]);
  });

  it('abbina le due metà etichettate e le segnala come già sistemate', () => {
    const { pairs, unmatched } = findTransfers(labeled());
    expect(unmatched).toEqual([]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ labeled: true, confidence: 'alta', recordedGain: undefined, days: -1 });
  });

  it('senza controparte: l\'uscita non genera plusvalenza, l\'entrata prende il valore del giorno', () => {
    const d = labeled();
    d.transactions[3] = { ...d.transactions[3], date: '2025-09-01' }; // troppo lontana per essere la stessa
    const p = computePortfolio(d);
    expect(p.summary.realized).toBe(0);
    expect(p.positions.find((x) => x.accountId === 'okx')!.cost).toBeCloseTo(0.0499 * 60000);
    expect(findTransfers(d).unmatched.map((t) => t.id)).toEqual(['in', 'out']);
  });
});

describe('conferma e scarto delle coppie (passo 2)', () => {
  const setup = () => {
    const d = base();
    d.transactions = [
      tx({ id: 'dep', accountId: 'tr', date: '2025-01-01', type: 'deposito', amount: 2000 }),
      tx({ id: 'buy', accountId: 'tr', assetId: 'btc-tr', date: '2025-01-02', type: 'acquisto', quantity: 0.05, price: 40000, externalId: 'tr:buy' }),
      tx({ id: 'out', accountId: 'tr', assetId: 'btc-tr', date: '2025-06-10', type: 'trasf_uscita', quantity: 0.05, price: 60000, externalId: 'tr:out' }),
      tx({ id: 'in', accountId: 'okx', assetId: 'btc-okx', date: '2025-06-11', type: 'trasf_entrata', quantity: 0.0499, price: 60000, externalId: 'okx:in' }),
      // Arrivo molto più tardi (30 giorni): nessuna regola automatica lo abbina.
      tx({ id: 'late', accountId: 'kr', assetId: 'btc-okx', date: '2025-07-10', type: 'trasf_entrata', quantity: 0.0499, price: 55000, externalId: 'kr:in' }),
    ];
    return d;
  };
  const byId = (d: AppData, id: string) => d.transactions.find((t) => t.id === id)!;

  it('una coppia scartata non viene più proposta né usata nel calcolo', () => {
    let d = setup();
    expect(findTransfers(d).pairs.map((p) => [p.out.id, p.in.id])).toEqual([['out', 'in']]);
    d = reducer(d, { type: 'decideTransfer', link: decide(byId(d, 'out'), byId(d, 'in'), 'rifiutato') });
    const a = findTransfers(d);
    expect(a.pairs).toEqual([]);
    expect(a.rejected.map((p) => [p.out.id, p.in.id, p.status])).toEqual([['out', 'in', 'rifiutato']]);
    // Senza abbinamento l'entrata su OKX prende il valore del giorno, non il costo di Trade Republic.
    const okx = computePortfolio(d).positions.find((x) => x.accountId === 'okx')!;
    expect(okx.cost).toBeCloseTo(0.0499 * 60000);
  });

  it('abbinamento a mano oltre le regole automatiche: il costo segue le monete', () => {
    let d = setup();
    const out = byId(d, 'out');
    expect(counterparts(d, out).map((t) => t.id)).toEqual(['in', 'late']);
    d = reducer(d, { type: 'decideTransfer', link: decide(out, byId(d, 'in'), 'rifiutato') });
    d = reducer(d, { type: 'decideTransfer', link: decide(out, byId(d, 'late'), 'confermato') });
    const a = findTransfers(d);
    expect(a.pairs.map((p) => [p.out.id, p.in.id, p.status, p.confidence])).toEqual([['out', 'late', 'confermato', 'alta']]);
    expect(a.unmatched.map((t) => t.id)).toEqual(['in']);
    const kr = computePortfolio(d).positions.find((x) => x.accountId === 'kr')!;
    expect(kr.cost).toBeCloseTo(2000);
    // Una metà confermata non può esserlo in due coppie: la nuova conferma sostituisce la vecchia.
    d = reducer(d, { type: 'decideTransfer', link: decide(out, byId(d, 'in'), 'confermato') });
    expect((d.transferLinks ?? []).filter((l) => l.status === 'confermato')).toHaveLength(1);
    expect(findTransfers(d).pairs.map((p) => p.in.id)).toEqual(['in']);
  });

  it('la decisione sopravvive a sincronizzazioni e reimport (identificativo della fonte)', () => {
    let d = setup();
    d = reducer(d, { type: 'decideTransfer', link: decide(byId(d, 'out'), byId(d, 'late'), 'confermato') });
    // Reimport: la transazione viene ricreata con un id interno diverso ma lo stesso identificativo della fonte.
    d = { ...d, transactions: d.transactions.map((t) => (t.id === 'late' ? { ...t, id: 'late-2', price: 56000 } : t)) };
    expect(findTransfers(d).pairs.map((p) => [p.out.id, p.in.id])).toEqual([['out', 'late-2']]);
    // Eliminando il conto spariscono anche le decisioni che lo riguardano.
    d = reducer(d, { type: 'deleteAccount', id: 'kr' });
    expect(d.transferLinks).toEqual([]);
  });

  it('funziona anche per i bonifici tra conti', () => {
    let d = base();
    d.transactions = [
      tx({ id: 'p', accountId: 'bank', date: '2025-03-01', type: 'prelievo', amount: 500 }),
      tx({ id: 'v', accountId: 'sc', date: '2025-03-20', type: 'deposito', amount: 500 }),
    ];
    expect(findTransfers(d).pairs).toEqual([]);
    expect(counterparts(d, d.transactions[0]).map((t) => t.id)).toEqual(['v']);
    d = reducer(d, { type: 'decideTransfer', link: decide(d.transactions[0], d.transactions[1], 'confermato') });
    expect(findTransfers(d).pairs).toMatchObject([{ kind: 'liquidita', status: 'confermato', days: 19 }]);
  });
});

describe('coppie vendita + acquisto confermate nel calcolo (passo 3)', () => {
  // Come negli import delle versioni precedenti: vendita + prelievo speculare, acquisto + deposito speculare.
  const setup = () => {
    const d = base();
    d.transactions = [
      tx({ id: 'dep', accountId: 'tr', date: '2025-01-01', type: 'deposito', amount: 2000 }),
      tx({ id: 'buy', accountId: 'tr', assetId: 'btc-tr', date: '2025-01-02', type: 'acquisto', quantity: 0.05, price: 40000 }),
      ...transferLeg('tr', 'btc-tr', '2025-06-10', 'vendita', 0.05, 60000, 'tr:out', 'Inviati ad altro conto'),
      ...transferLeg('okx', 'btc-okx', '2025-06-11', 'acquisto', 0.0499, 60000, 'okx:in', 'Deposito crypto (carico al valore del giorno)'),
    ];
    return d;
  };
  const leg = (d: AppData, id: string) => d.transactions.find((t) => t.externalId === id)!;

  it('prima della conferma: plusvalenza finta e versamenti/prelievi gonfiati', () => {
    const p = computePortfolio(setup());
    expect(p.summary.realized).toBeCloseTo(1000);
    expect(p.years[0]).toMatchObject({ deposits: 2000 + 2994, withdrawals: 3000 });
  });

  it('dopo la conferma: nessuna plusvalenza, il costo passa a OKX, spariscono i movimenti speculari', () => {
    let d = setup();
    d = reducer(d, { type: 'decideTransfer', link: decide(leg(d, 'tr:out'), leg(d, 'okx:in'), 'confermato') });
    const p = computePortfolio(d);
    expect(p.summary.realized).toBe(0);
    expect(p.warnings).toEqual([]);
    const at = (acc: string) => p.positions.find((x) => x.accountId === acc)!;
    expect(at('tr')).toMatchObject({ quantity: 0, cost: 0, realized: 0 });
    expect(at('okx').quantity).toBeCloseTo(0.0499);
    expect(at('okx').cost).toBeCloseTo(2000);
    // Liquidità: su TR restano i 2000 − 2000 spesi; su OKX nulla. Solo il versamento vero nei report.
    expect(p.cash.find((c) => c.accountId === 'tr')?.cash).toBeCloseTo(0);
    expect(p.cash.find((c) => c.accountId === 'okx')?.cash ?? 0).toBeCloseTo(0);
    expect(p.years[0]).toMatchObject({ deposits: 2000, withdrawals: 0 });
    expect(p.summary.netDeposits).toBe(2000);
    // Nella pagina la coppia risulta confermata e non più "vendita + acquisto" con plusvalenza.
    const pair = findTransfers(d, p.saleGains).pairs[0];
    expect(pair.status).toBe('confermato');
    expect(pair.recordedGain).toBeUndefined();
  });

  it('annullando la conferma torna tutto come prima', () => {
    let d = setup();
    const link = decide(leg(d, 'tr:out'), leg(d, 'okx:in'), 'confermato');
    d = reducer(d, { type: 'decideTransfer', link });
    d = reducer(d, { type: 'undoTransfer', id: link.id });
    expect(computePortfolio(d).summary.realized).toBeCloseTo(1000);
  });

  it('le coppie solo proposte (non confermate) non cambiano il calcolo', () => {
    const d = setup();
    const pair = findTransfers(d).pairs[0];
    expect(pair.status).toBeUndefined();
    expect(pair.labeled).toBe(false);
    expect(computePortfolio(d).summary.realized).toBeCloseTo(1000);
  });
});

describe('bonifici tra conti confermati (passo 4)', () => {
  const setup = () => {
    const d = base();
    d.transactions = [
      tx({ id: 'stip', accountId: 'bank', date: '2025-01-01', type: 'deposito', amount: 10000, note: 'Stipendio' }),
      tx({ id: 'b1', accountId: 'bank', date: '2025-03-01', type: 'prelievo', amount: 1000, note: 'Bonifico a OKX', externalId: 'bank:1' }),
      tx({ id: 'o1', accountId: 'okx', date: '2025-03-03', type: 'deposito', amount: 998.5, externalId: 'okx:1' }),
      // Prelievo vero (spesa): resta un prelievo.
      tx({ id: 'spesa', accountId: 'bank', date: '2025-04-01', type: 'prelievo', amount: 200, note: 'Affitto' }),
    ];
    return d;
  };

  it('prima: il bonifico conta come prelievo e versamento', () => {
    const p = computePortfolio(setup());
    expect(p.years[0]).toMatchObject({ deposits: 10998.5, withdrawals: 1200 });
  });

  it('dopo la conferma: non è né versamento né prelievo, il costo del bonifico è una commissione', () => {
    let d = setup();
    d = reducer(d, { type: 'decideTransfer', link: decide(d.transactions[1], d.transactions[2], 'confermato') });
    const p = computePortfolio(d);
    expect(p.years[0]).toMatchObject({ deposits: 10000, withdrawals: 200, fees: 1.5 });
    expect(p.summary.netDeposits).toBe(9800);
    // La liquidità si sposta comunque: 10000 − 1000 − 200 in banca, 998,50 su OKX.
    const cash = (acc: string) => p.cash.find((c) => c.accountId === acc)!.cash;
    expect(cash('bank')).toBeCloseTo(8800);
    expect(cash('okx')).toBeCloseTo(998.5);
    // Patrimonio = capitale versato − commissione.
    expect(p.summary.netWorth).toBeCloseTo(9798.5);
    expect(p.summary.totalGain).toBeCloseTo(-1.5);
  });

  it('i bonifici solo proposti non cambiano i report', () => {
    const d = setup();
    expect(findTransfers(d).pairs).toMatchObject([{ kind: 'liquidita' }]);
    expect(computePortfolio(d).years[0]).toMatchObject({ deposits: 10998.5, withdrawals: 1200 });
  });
});
