import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { degiro, degiroKind } from './degiro';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

const H = ['Data', 'Ora', 'Data Valore', 'Prodotto', 'ISIN', 'Descrizione', 'Borsa', 'Variazioni', '', 'Saldo', '', 'ID Ordine'];
/** Estratto conto DEGIRO (ordine dal più recente, come nell'export reale). */
const ROWS: unknown[][] = [
  H,
  ['01-08-2023', '14:05', '01-08-2023', '', '', 'Processed Flatex Withdrawal', '', 'EUR', 254.45, 'EUR', -0.42, ''],
  ['02-08-2023', '09:21', '02-08-2023', '', '', 'Processed Flatex Withdrawal', '', 'EUR', 254.45, 'EUR', -0.42, ''],
  ['02-08-2023', '09:21', '02-08-2023', '', '', 'Prelievo flatex', '', 'EUR', -254.45, 'EUR', -254.87, ''],
  ['01-08-2023', '17:19', '01-08-2023', 'FLATEX EURO BANKACCOUNT', 'NLFLATEXACNT', 'Degiro Cash Sweep Transfer', '', 'EUR', -254.46, 'EUR', -254.88, ''],
  ['01-08-2023', '14:02', '01-08-2023', 'STST SPDR RUSSELL 2000', 'IE00BJ38QD84', 'DEGIRO costi di transazione e/o di terze parti', '', 'EUR', -3, 'EUR', 254.46, 'o2'],
  ['01-08-2023', '14:02', '01-08-2023', 'STST SPDR RUSSELL 2000', 'IE00BJ38QD84', 'Vendita 6 StSt SPDR Russell 2000 US Small Cap UCITS ETF Acc@51,64 EUR (IE00BJ38QD84)', '', 'EUR', 309.84, 'EUR', 257.46, 'o2'],
  ['28-07-2023', '16:58', '28-07-2023', '', '', 'Prelievo rifiutato', '', 'EUR', 212.88, 'EUR', 114.19, ''],
  ['28-07-2023', '09:27', '28-07-2023', '', '', 'Prelievo rifiutato', '', 'EUR', -212.88, 'EUR', -98.69, ''],
  ['11-07-2023', '09:38', '11-07-2023', 'STST SPDR RUSSELL 2000', 'IE00BJ38QD84', 'DEGIRO costi di transazione e/o di terze parti', '', 'EUR', -3, 'EUR', 34.19, 'o1'],
  ['11-07-2023', '09:38', '11-07-2023', 'STST SPDR RUSSELL 2000', 'IE00BJ38QD84', 'Acquisto 6 StSt SPDR Russell 2000 US Small Cap UCITS ETF Acc@48,88 EUR (IE00BJ38QD84)', '', 'EUR', -293.28, 'EUR', 37.19, 'o1'],
  ['27-06-2023', '21:49', '27-06-2023', 'TESLA INC', 'US88160R1014', 'Prelievo FX', 1.0989, 'USD', -249.96, 'USD', 0, 'o4'],
  ['27-06-2023', '21:49', '27-06-2023', 'TESLA INC', 'US88160R1014', 'Credito FX', '', 'EUR', 227.46, 'EUR', 275.65, 'o4'],
  ['27-06-2023', '21:49', '27-06-2023', 'TESLA INC', 'US88160R1014', 'DEGIRO costi di transazione e/o di terze parti', '', 'EUR', -2, 'EUR', 48.19, 'o4'],
  ['27-06-2023', '21:49', '27-06-2023', 'TESLA INC', 'US88160R1014', 'Vendita 1 Tesla Inc@249,96 USD (US88160R1014)', '', 'USD', 249.96, 'USD', 249.96, 'o4'],
  ['25-05-2023', '15:57', '25-05-2023', 'TESLA INC', 'US88160R1014', 'Credito FX', 1.0685, 'USD', 183.72, 'USD', 0, 'o3'],
  ['25-05-2023', '15:57', '25-05-2023', 'TESLA INC', 'US88160R1014', 'Prelievo FX', '', 'EUR', -171.94, 'EUR', 50.79, 'o3'],
  ['25-05-2023', '15:57', '25-05-2023', 'TESLA INC', 'US88160R1014', 'DEGIRO costi di transazione e/o di terze parti', '', 'EUR', -2, 'EUR', 222.73, 'o3'],
  ['25-05-2023', '15:57', '25-05-2023', 'TESLA INC', 'US88160R1014', 'Acquisto 1 Tesla Inc@183,72 USD (US88160R1014)', '', 'USD', -183.72, 'USD', -183.72, 'o3'],
  ['23-05-2023', '11:31', '23-05-2023', '', '', 'Deposito flatex', '', 'EUR', 500, 'EUR', 500, ''],
  ['02-01-2024', '17:10', '02-01-2024', '', '', 'Flatex Interest Income', '', 'EUR', 0, 'EUR', -0.44, ''],
  ['23-01-2024', '11:28', '22-01-2024', '', '', 'DEGIRO Compensazione', '', 'EUR', 3, 'EUR', 4.56, ''],
  ['01-06-2023', '14:52', '31-05-2023', '', '', 'DEGIRO Costi di connessione 2023 (Nasdaq - NDQ)', '', 'EUR', -0.6, 'EUR', 50.19, ''],
];

const toSheets = (rows: unknown[][]): Sheet[] => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Estratto conto');
  const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }), { type: 'array' });
  return back.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(back.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
};
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };

describe('import DEGIRO', () => {
  it('riconosce l\'estratto conto', () => {
    expect(detectImporter(toSheets(ROWS))?.id).toBe('degiro');
  });

  it('classifica le descrizioni', () => {
    expect(degiroKind('Degiro Cash Sweep Transfer')).toBe('sweep');
    expect(degiroKind('Trasferisci dal tuo conto deposito presso flatexDEGIRO Bank: 4,56 EUR')).toBe('sweep');
    expect(degiroKind('Deposito flatex')).toBe('deposit');
    expect(degiroKind('Prelievo flatex')).toBe('withdrawal');
    expect(degiroKind('Processed Flatex Withdrawal')).toBe('withdrawal-noise');
    expect(degiroKind('Prelievo FX')).toBe('fx');
    expect(degiroKind('Credito FX')).toBe('fx');
    expect(degiroKind('Dividendo')).toBe('dividend');
    expect(degiroKind('Ritenuta sul dividendo')).toBe('dividend-tax');
    expect(degiroKind('Buy 3 Apple Inc@150 USD (US0378331005)')).toBe('trade');
  });

  it('unisce le righe di un ordine: commissioni e cambio in EUR', () => {
    const r = degiro.parse(toSheets(ROWS), opts);
    const byId = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(byId['degiro:order:o1']).toMatchObject({ type: 'acquisto', quantity: 6, price: 48.88, fees: 3, date: '2023-07-11' });
    expect(byId['degiro:order:o3']).toMatchObject({ type: 'acquisto', quantity: 1, price: 171.94, fees: 2 });
    expect(byId['degiro:order:o4']).toMatchObject({ type: 'vendita', quantity: 1, price: 227.46, fees: 2 });
    expect(r.assets.find((a) => a.isin === 'IE00BJ38QD84')).toMatchObject({ type: 'etf', name: 'StSt SPDR Russell 2000 US Small Cap UCITS ETF Acc' });
  });

  it('conta i prelievi una volta sola e ignora i trasferimenti interni', () => {
    const r = degiro.parse(toSheets(ROWS), opts);
    const cash = r.transactions.filter((t) => t.type === 'deposito' || t.type === 'prelievo');
    expect(cash.map((t) => [t.type, t.amount])).toEqual([
      ['deposito', 500],
      ['prelievo', 254.45],
    ]);
  });

  it('nel portafoglio: realizzato corretto e liquidità coerente', () => {
    const r = degiro.parse(toSheets(ROWS), opts);
    const { data } = mergeSync(emptyData(), { id: 'file:degiro', label: 'DEGIRO' }, { ...r, cash: undefined }, '2026-09-24');
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    const tesla = p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.isin === 'US88160R1014')!;
    expect(tesla.realized).toBeCloseTo(227.46 - 2 - (171.94 + 2));
    // 500 − 171,94 − 2 + 227,46 − 2 − 0,60 − 293,28 − 3 + 309,84 − 3 − 254,45 + 3
    expect(p.cash[0].cash).toBeCloseTo(310.03);
  });
});
