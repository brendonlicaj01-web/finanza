import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { decodeText, detectImporter, type Sheet } from './index';
import { generic, kindOf } from './generic';
import { nameFromFile } from './util';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';
import { parseNumber } from '../format';

/** CSV di prova in stile broker italiano (separatore ";", punto decimale, segni espliciti). */
const CSV = `Data Operazione;Data Valuta;ID Operazione;Tipo Operazione;Descrizione;Quantità;Prezzo;Importo;Commissioni;Saldo Progressivo
02/01/2026;02/01/2026;9876541;Bonifico in entrata;Versamento iniziale;;;+10000.00;;10000.00
15/01/2026;19/01/2026;9876542;Compra;VANGUARD S&P 500 UCITS ETF (IE00B3XXRP09);10;85.50;-855.00;5.00;9140.00
15/01/2026;15/01/2026;9876543;Addebito;Imposta di Bollo;;;-25.00;;9115.00
20/02/2026;24/02/2026;9876544;Compra;ISHARES CORE MSCI WORLD (IE00B4L5Y983);5;75.20;-376.00;5.00;8734.00
10/03/2026;12/03/2026;9876545;Dividendo;Accredito Dividendo STMicroelectronics;;;+45.50;;8779.50
10/03/2026;10/03/2026;9876546;Ritenuta;Ritenuta Fiscale Dividendi;;;-11.83;;8767.67
18/03/2026;22/03/2026;9876547;Vendi;VANGUARD S&P 500 UCITS ETF (IE00B3XXRP09);2;90.00;+180.00;5.00;8942.67
`;

/** Come readSheets nel browser: testo decodificato e letto senza interpretare i valori. */
function fromBytes(bytes: Uint8Array): Sheet[] {
  const wb = XLSX.read(decodeText(bytes.buffer as ArrayBuffer), { type: 'string', raw: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
}
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };

describe('import CSV generico', () => {
  const sheets = fromBytes(new TextEncoder().encode(CSV));

  it('riconosce il file come CSV generico', () => {
    expect(detectImporter(sheets)?.id).toBe('generic');
  });

  it('legge date italiane, ISIN nella descrizione e tipi di operazione', () => {
    const r = generic.parse(sheets, opts);
    expect(r.transactions.map((t) => `${t.date} ${t.type} ${t.assetKey ?? '-'} ${t.quantity ?? t.amount} ${t.fees}`)).toEqual([
      '2026-01-02 deposito - 10000 0',
      '2026-01-15 acquisto IE00B3XXRP09 10 5',
      '2026-01-15 commissione - 25 0',
      '2026-02-20 acquisto IE00B4L5Y983 5 5',
      '2026-03-10 dividendo - 45.5 11.83',
      '2026-03-18 vendita IE00B3XXRP09 2 5',
    ]);
    expect(r.transactions[0].externalId).toBe('csv:9876541');
    expect(r.assets.find((a) => a.isin === 'IE00B3XXRP09')).toMatchObject({ name: 'VANGUARD S&P 500 UCITS ETF', type: 'etf', price: 90 });
    expect(r.cash).toBe(8942.67);
  });

  it('nel portafoglio la liquidità coincide con il saldo progressivo', () => {
    const { data, stats } = mergeSync(emptyData(), { id: 'file:csv-generico', label: 'Directa' }, generic.parse(sheets, opts), '2026-09-24');
    expect(stats).toMatchObject({ added: 6, newAssets: 2, adjustments: 0 });
    expect(data.accounts[0].name).toBe('Directa');
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    expect(p.cash[0].cash).toBeCloseTo(8942.67);
    const vanguard = p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.isin === 'IE00B3XXRP09')!;
    expect(vanguard.quantity).toBe(8);
    expect(vanguard.realized).toBeCloseTo(2 * 90 - 5 - (2 * (855 + 5)) / 10);
    expect(p.summary.income).toBeCloseTo(45.5 - 11.83);
  });

  it('accetta CSV salvati con la codifica di Windows', () => {
    const latin = Uint8Array.from([...CSV].map((c) => c.charCodeAt(0)));
    const r = generic.parse(fromBytes(latin), opts);
    expect(r.transactions.find((t) => t.type === 'acquisto')?.quantity).toBe(10);
  });

  it('riconosce le parole chiave più comuni', () => {
    expect(kindOf('Compravendita', '', -100)).toBe('buy');
    expect(kindOf('Compravendita', '', 100)).toBe('sell');
    expect(kindOf('Buy', '', -1)).toBe('buy');
    expect(kindOf('Prelievo', '', -50)).toBe('withdrawal');
    expect(kindOf('Bonifico', '', -50)).toBe('transfer');
    expect(kindOf('Cedola', '', 10)).toBe('dividend');
    expect(kindOf('', 'Imposta di bollo', -2)).toBe('fee');
    expect(kindOf('Boh', '', 1)).toBeUndefined();
  });
});

describe('parseNumber', () => {
  it('capisce separatori italiani e inglesi', () => {
    expect(parseNumber('1.234,56')).toBeCloseTo(1234.56);
    expect(parseNumber('1,234.56')).toBeCloseTo(1234.56);
    expect(parseNumber('+10000.00')).toBe(10000);
    expect(parseNumber('-11,83')).toBeCloseTo(-11.83);
  });
});

describe('nameFromFile', () => {
  it('ricava il nome del broker dal file', () => {
    expect(nameFromFile('directa_movimenti_2026.csv')).toBe('Directa');
    expect(nameFromFile('c159aab8-directa_prova.csv')).toBe('Directa');
    expect(nameFromFile('2026-09-24.csv')).toBe('Conto importato');
  });
});
