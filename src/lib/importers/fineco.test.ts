import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { fineco } from './fineco';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

/** Copia anonima dell'export "Movimenti Dossier Titoli" di Fineco, con la stessa struttura. */
const ROWS: unknown[][] = [
  ['Dossier n. XXX', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Intestazione Dossier: XXX', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['RISULTATO RICERCA MOVIMENTI TITOLI', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
  ['Operazione', 'Data valuta', 'Descrizione', 'Titolo', 'ISIN', 'Segno', 'Quantita', 'Divisa', 'Prezzo', 'Cambio', 'Controvalore', 'Commissioni Fondi Sw/Ingr/Uscita', 'Commissioni Fondi Banca Corrispondente', 'Spese Fondi Sgr', 'Commissioni amministrato'],
  ['16/06/2026', '23/06/2026', 'Compravendita \ntitoli', 'BTP-23GN31 IT SI CUM', 'IT0005713539', 'A', 3000, 'EUR', 100, 1, 3000, 0, '', '', ''],
  ['12/06/2026', '12/06/2026', 'Rimborso', '**BOT-12GN26', 'IT0005655037', '', 1000, 'EUR', 0, 1, 1000, 0, '', '', ''],
  ['30/01/2026', '30/01/2026', 'Dividendo', 'VON EXPE27', 'DE000VK2YTQ2', '', 5, 'EUR', 0, 1, 26.25, 0, '', '', ''],
  ['28/11/2025', '28/11/2025', 'Rimborso', '**BOT-28NV25', 'IT0005652554', '', 1000, 'EUR', 0, 1, 1000, 0, '', '', ''],
  ['31/10/2025', '31/10/2025', 'Dividendo', 'VON EXPE27', 'DE000VK2YTQ2', '', 5, 'EUR', 0, 1, 8.75, 0, '', '', ''],
  ['01/10/2025', '03/10/2025', 'Compravendita \ntitoli', 'VON EXPE27', 'DE000VK2YTQ2', 'A', 5, 'EUR', 92.49, 1, 462.45, 2.95, '', '', ''],
  ['30/06/2025', '02/07/2025', 'Compravendita \ntitoli', 'BOT-12GN26', 'IT0005655037', 'A', 1000, 'EUR', 98.39792, 1, 983.98, 0, '', '', ''],
  ['04/06/2025', '06/06/2025', 'Compravendita \ntitoli', 'BOT-28NV25', 'IT0005652554', 'A', 1000, 'EUR', 99.17223, 1, 991.72, 0, '', '', ''],
];

/** Passa per un vero file .xls, come quello scaricato da Fineco. */
function roundTrip(rows: unknown[][]): Sheet[] {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Movimenti Dossier Titoli');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'biff8' });
  const back = XLSX.read(buf, { type: 'array' });
  return back.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(back.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
}

describe('import Fineco', () => {
  const sheets = roundTrip(ROWS);

  it('riconosce il formato', () => {
    expect(detectImporter(sheets)?.id).toBe('fineco');
    expect(detectImporter([{ name: 'x', rows: [['a', 'b']] }])).toBeUndefined();
  });

  it('legge compravendite, rimborsi e proventi', () => {
    const r = fineco.parse(sheets, { balanceCash: false, existingIds: new Set(), knownSymbols: [] });
    expect(r.transactions).toHaveLength(8);
    const btp = r.assets.find((a) => a.isin === 'IT0005713539')!;
    expect(btp).toMatchObject({ type: 'obbligazione', priceMultiplier: 0.01, taxRate: 12.5, name: 'BTP-23GN31 IT SI CUM', price: 100, priceDate: '2026-06-16' });
    expect(r.assets.find((a) => a.isin === 'IT0005655037')!.name).toBe('BOT-12GN26');
    expect(r.assets.find((a) => a.isin === 'DE000VK2YTQ2')!.type).toBe('altro');

    const bot = r.transactions.filter((t) => t.assetKey === 'IT0005655037');
    expect(bot.map((t) => [t.date, t.type, t.quantity, Number(t.price!.toFixed(4))])).toEqual([
      ['2025-06-30', 'acquisto', 1000, 98.3979],
      ['2026-06-12', 'vendita', 1000, 100],
    ]);
    const cert = r.transactions.filter((t) => t.assetKey === 'DE000VK2YTQ2');
    expect(cert.map((t) => [t.type, t.amount ?? t.quantity, t.fees])).toEqual([
      ['acquisto', 5, 2.95],
      ['dividendo', 8.75, 0],
      ['dividendo', 26.25, 0],
    ]);
  });

  it('nel portafoglio: posizioni, plusvalenze dei BOT e liquidità bilanciata', () => {
    const r = fineco.parse(sheets, { balanceCash: true, existingIds: new Set(), knownSymbols: [] });
    const { data, stats } = mergeSync(emptyData(), { id: 'file:fineco', label: 'Fineco' }, r, '2026-09-24');
    expect(stats.newAssets).toBe(4);
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    const byIsin = (isin: string) => p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.isin === isin)!;
    expect(byIsin('IT0005713539')).toMatchObject({ quantity: 3000 });
    expect(byIsin('IT0005713539').marketValue).toBeCloseTo(3000);
    expect(byIsin('IT0005713539').avgPrice).toBeCloseTo(100);
    expect(byIsin('DE000VK2YTQ2').cost).toBeCloseTo(465.4);
    expect(byIsin('IT0005655037').realized).toBeCloseTo(16.02);
    expect(byIsin('IT0005652554').realized).toBeCloseTo(8.28);
    // Con il bilanciamento il conto titoli non ha liquidità negativa.
    expect(p.cash[0].cash).toBeCloseTo(0);
    expect(p.summary.income).toBeCloseTo(35);
  });

  it('reimportare lo stesso file non crea doppioni', () => {
    const r = fineco.parse(sheets, { balanceCash: true, existingIds: new Set(), knownSymbols: [] });
    const first = mergeSync(emptyData(), { id: 'file:fineco', label: 'Fineco' }, r, '2026-09-24').data;
    const again = mergeSync(first, { id: 'file:fineco', label: 'Fineco' }, fineco.parse(roundTrip(ROWS), { balanceCash: true, existingIds: new Set(), knownSymbols: [] }), '2026-09-25');
    expect(again.stats).toMatchObject({ added: 0, newAssets: 0, adjustments: 0 });
  });
});
