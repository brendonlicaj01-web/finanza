import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { tradeRepublic } from './traderepublic';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

const H = '"datetime","date","account_type","category","type","asset_class","name","symbol","shares","price","amount","fee","tax","currency","original_amount","original_currency","fx_rate","description","transaction_id","counterparty_name","counterparty_iban","payment_reference","mcc_code"';
const row = (o: Record<string, string>) =>
  H.split(',')
    .map((h) => `"${o[h.replace(/"/g, '')] ?? ''}"`)
    .join(',');

/** Export sintetico nel formato Trade Republic, con dati personali finti da non far trapelare. */
const CSV = [
  H,
  row({ datetime: '2026-01-05T09:00:00Z', date: '2026-01-05', category: 'CASH', type: 'TRANSFER_INSTANT_INBOUND', amount: '2000', currency: 'EUR', description: 'Da MARIO SEGRETO', transaction_id: 't1', counterparty_name: 'MARIO SEGRETO', counterparty_iban: 'IT00SEGRETO' }),
  row({ datetime: '2026-01-06T09:00:00Z', date: '2026-01-06', category: 'CASH', type: 'CUSTOMER_INPAYMENT', amount: '10.10', fee: '-0.10', currency: 'EUR', description: 'Card Top up with ****9999', transaction_id: 't2' }),
  row({ datetime: '2026-01-07T09:00:00Z', date: '2026-01-07', category: 'TRADING', type: 'BUY', asset_class: 'FUND', name: 'FTSE All-World USD (Acc)', symbol: 'IE000716YHJ7', shares: '100', price: '7', amount: '-700', fee: '-1', currency: 'EUR', transaction_id: 't3' }),
  row({ datetime: '2026-01-10T12:00:00Z', date: '2026-01-10', category: 'CASH', type: 'CARD_TRANSACTION', amount: '-25.50', currency: 'EUR', description: 'SUPERMERCATO SEGRETO', transaction_id: 'c1', counterparty_name: 'SUPERMERCATO SEGRETO', mcc_code: '5411' }),
  row({ datetime: '2026-01-20T12:00:00Z', date: '2026-01-20', category: 'CASH', type: 'CARD_TRANSACTION_INTERNATIONAL', amount: '-4.50', fee: '0', currency: 'EUR', description: 'BAR SEGRETO', transaction_id: 'c2', mcc_code: '5812' }),
  row({ datetime: '2026-02-01T01:00:00Z', date: '2026-02-01', category: 'CASH', type: 'BENEFITS_SAVEBACK', asset_class: 'FUND', name: 'FTSE All-World USD (Acc)', symbol: 'IE000716YHJ7', amount: '3', currency: 'EUR', description: 'Your Saveback payment', transaction_id: 't4' }),
  row({ datetime: '2026-02-02T08:00:00Z', date: '2026-02-02', category: 'TRADING', type: 'BUY', asset_class: 'FUND', name: 'FTSE All-World USD (Acc)', symbol: 'IE000716YHJ7', shares: '0.4', price: '7.5', amount: '-3', currency: 'EUR', description: 'Savings plan execution', transaction_id: 't5' }),
  row({ datetime: '2026-02-01T01:00:00Z', date: '2026-02-01', category: 'CASH', type: 'INTEREST_PAYMENT', amount: '4', tax: '-1.04', currency: 'EUR', description: 'Interest payment', transaction_id: 't6' }),
  row({ datetime: '2026-02-10T08:00:00Z', date: '2026-02-10', category: 'TRADING', type: 'BUY', asset_class: 'CRYPTO', name: 'Bitcoin', symbol: 'BTC', shares: '0.01', price: '80000', amount: '-800', fee: '-1', currency: 'EUR', transaction_id: 't7' }),
  row({ datetime: '2026-02-15T10:00:00Z', date: '2026-02-15', category: 'CASH', type: 'CARD_TRANSACTION', amount: '-70', currency: 'EUR', description: 'NEGOZIO SEGRETO', transaction_id: 'c3', mcc_code: '5999' }),
  row({ datetime: '2026-03-01T10:00:00Z', date: '2026-03-01', category: 'DELIVERY', type: 'FREE_DELIVERY', asset_class: 'CRYPTO', name: 'Bitcoin', symbol: 'BTC', shares: '-0.01', transaction_id: 't8' }),
  row({ datetime: '2026-03-01T10:00:01Z', date: '2026-03-01', category: 'CASH', type: 'FEE', amount: '0', fee: '-0.30', currency: 'EUR', transaction_id: 't9' }),
  row({ datetime: '2026-03-10T10:00:00Z', date: '2026-03-10', category: 'CASH', type: 'DIVIDEND', asset_class: 'FUND', name: 'FTSE All-World USD (Acc)', symbol: 'IE000716YHJ7', shares: '100', amount: '5', tax: '-1.30', currency: 'EUR', transaction_id: 't10' }),
  row({ datetime: '2026-03-12T10:00:00Z', date: '2026-03-12', category: 'CASH', type: 'TAX_OPTIMIZATION', amount: '0', tax: '-0.96', currency: 'EUR', description: 'Stamp Duty Tax (Portfolio)', transaction_id: 't11' }),
  row({ datetime: '2026-03-15T10:00:00Z', date: '2026-03-15', category: 'CASH', type: 'TRANSFER_INSTANT_OUTBOUND', name: 'MARIO SEGRETO', amount: '-100', currency: 'EUR', description: 'A MARIO SEGRETO', transaction_id: 't12', counterparty_name: 'MARIO SEGRETO', counterparty_iban: 'IT00SEGRETO', payment_reference: 'causale segreta' }),
  row({ datetime: '2026-03-20T10:00:00Z', date: '2026-03-20', category: 'CASH', type: 'CARD_TRANSACTION', amount: '-12', currency: 'EUR', description: 'MESE IN CORSO SEGRETO', transaction_id: 'c4', mcc_code: '5411' }),
].join('\n');

const sheets = (): Sheet[] => {
  const wb = XLSX.read(CSV, { type: 'string', raw: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
};
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };

describe('import Trade Republic', () => {
  it('riconosce il formato prima del CSV generico', () => {
    expect(detectImporter(sheets())?.id).toBe('traderepublic');
  });

  it('esclude i pagamenti con carta e non importa mai dati personali', () => {
    const r = tradeRepublic.parse(sheets(), opts);
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/SEGRETO|segreta|9999|5411|c1|c2|c3/);
    expect(r.transactions.some((t) => t.externalId.startsWith('tr:c'))).toBe(false);
    expect(r.warnings[0]).toMatch(/4 pagamenti con carta esclusi/);
    expect(r.transactions.find((t) => t.externalId === 'tr:t1')).toMatchObject({ type: 'deposito', amount: 2000, note: 'Bonifico in entrata' });
    expect(r.transactions.find((t) => t.externalId === 'tr:t12')).toMatchObject({ type: 'prelievo', amount: 100, note: 'Bonifico in uscita' });
  });

  it('in alternativa riduce le carte a totali mensili, escluso il mese in corso', () => {
    const r = tradeRepublic.parse(sheets(), { ...opts, flags: { cardMonthly: true } });
    const cards = r.transactions.filter((t) => t.externalId.startsWith('tr:card:'));
    expect(cards.map((t) => [t.externalId, t.type, t.amount])).toEqual([
      ['tr:card:2026-01', 'prelievo', 30],
      ['tr:card:2026-02', 'prelievo', 70],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/SEGRETO|5411/);
  });

  it('calcola posizioni, proventi e costi', () => {
    const r = tradeRepublic.parse(sheets(), opts);
    const { data } = mergeSync(emptyData(), { id: 'file:trade-republic', label: 'Trade Republic' }, r, '2026-09-24');
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    const pos = (sym: string) => p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.symbol === sym)!;
    expect(data.assets.find((a) => a.isin === 'IE000716YHJ7')).toMatchObject({ symbol: 'FTSE All-World USD (Acc)', type: 'etf' });
    expect(pos('FTSE All-World USD (Acc)').quantity).toBeCloseTo(100.4);
    expect(pos('FTSE All-World USD (Acc)').cost).toBeCloseTo(704);
    expect(pos('FTSE All-World USD (Acc)').income).toBeCloseTo(3.7);
    // BTC inviato ad altro conto: esce al prezzo dell'ultimo acquisto, costi a parte.
    expect(pos('BTC').quantity).toBe(0);
    // Saveback 3 + interessi 4 − 1,04 di ritenuta + dividendo 5 − 1,30.
    expect(p.summary.income).toBeCloseTo(3 + 2.96 + 3.7);
    // Liquidità senza carte (il trasferimento del BTC è neutro: vendita +800, uscita −800):
    // 2000 + 10 − 701 + 3 − 3 + 2,96 − 801 − 0,30 + 3,70 − 0,96 − 100
    expect(p.cash[0].cash).toBeCloseTo(413.4);
  });
});
