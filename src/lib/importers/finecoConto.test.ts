import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { finecoConto, unwrap } from './finecoConto';
import { fineco } from './fineco';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

/** Copia anonima dell'export "Movimenti" del conto corrente Fineco (date come seriali Excel, testo spezzato a 40 caratteri). */
const serial = (iso: string) => Math.round((Date.parse(iso) - Date.UTC(1899, 11, 30)) / 86_400_000);
const ROWS: unknown[][] = [
  ['Conto Corrente: XXX', '', '', '', '', '', '', ''],
  ['Intestazione Conto Corrente: XXX', '', '', '', '', '', '', ''],
  ['Periodo Dal: 24/09/2024 Al: 24/09/2026', '', '', '', '', '', '', ''],
  ['', '', '', '', '', '', '', ''],
  ['Saldo Finale: 0,00', '', '', '', '', '', '', ''],
  ['Nota: ...', '', '', '', '', '', '', ''],
  ['Risultati Ricerca', '', '', '', '', '', '', ''],
  ['Data_Operazione', 'Data_Valuta', 'Entrate', 'Uscite', 'Descrizione', 'Descrizione_Completa', 'Stato', ''],
  [serial('2026-07-13'), serial('2026-07-13'), '', -151.55, 'Bonifico Istantaneo', 'Beneficiario: XXX IBAN: XXX Causale: Giroconto', 'Contabilizzato', ''],
  [serial('2026-07-08'), serial('2026-06-30'), '', -3.2, 'Imposta bollo dossier titoli', 'Addebito imposta di bollo Dossier: XXX', 'Contabilizzato', ''],
  [serial('2026-06-23'), serial('2026-06-23'), '', -3000, 'Compravendita Titoli', 'Compravendita Titoli BTP-23GN31 IT SI CUM Qta/Val.nom. 3000,000000', 'Contabilizzato', ''],
  [serial('2026-06-15'), serial('2026-06-15'), 2000, '', 'Bonifico Istantaneo', 'Ordinante: XXX Causale:', 'Contabilizzato', ''],
  [serial('2026-06-12'), serial('2026-06-12'), 1000, '', 'Rimborso Titoli Italia', 'Rimborso Titoli Italia **BOT-12GN26 Qta/Val.nom. 1000,000000', 'Contabilizzato', ''],
  [serial('2026-03-03'), serial('2026-02-27'), '', -6.82, 'Imposta Sostitutiva Capit.GAIN', 'Imposta Sostitutiva Capit.GAIN NDG: XXX Mese / Anno: 01/2026', 'Contabilizzato', ''],
  [serial('2026-01-30'), serial('2026-01-30'), 26.25, '', 'Proventi Certificates Italia', 'Proventi Italia su Certificates 5,000 VO N EXPE27', 'Contabilizzato', ''],
  [serial('2025-10-03'), serial('2025-10-03'), '', -462.45, 'Compravendita Titoli', 'Compravendita Titoli VON EXPE27 Qta/Val.nom. 5,000000', 'Contabilizzato', ''],
  [serial('2025-10-01'), serial('2025-10-01'), 500, '', 'Bonifico Istantaneo', 'Ordinante: XXX', 'Contabilizzato', ''],
  [serial('2025-07-02'), serial('2025-07-02'), '', -983.98, 'Compravendita Titoli', 'Compravendita Titoli BOT-12GN26 Qta/Val.nom. 1000,000000', 'Contabilizzato', ''],
  [serial('2025-06-30'), serial('2025-06-30'), 500, '', 'Bonifico Istantaneo', 'Ordinante: XXX', 'Contabilizzato', ''],
  [serial('2025-05-30'), serial('2025-05-30'), 1000, '', 'Bonifico Istantaneo', 'Ordinante: XXX', 'In lavorazione', ''],
];

function toSheets(rows: unknown[][], type: 'xlsx' | 'biff8' = 'xlsx'): Sheet[] {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Movimenti');
  const back = XLSX.read(XLSX.write(wb, { type: 'array', bookType: type }), { type: 'array' });
  return back.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(back.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
}

const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };

describe('import Fineco conto corrente', () => {
  const sheets = toSheets(ROWS);

  it('riconosce il formato (distinto dal dossier)', () => {
    expect(detectImporter(sheets)?.id).toBe('fineco-conto');
  });

  it('ricompone il testo spezzato a 40 caratteri', () => {
    expect(unwrap('Proventi Italia su Certificates 5,000 VO N EXPE27')).toBe('Proventi Italia su Certificates 5,000 VON EXPE27');
  });

  it('classifica i movimenti e ricava operazioni sui titoli', () => {
    const r = finecoConto.parse(sheets, opts);
    expect(r.cash).toBe(0);
    const summary = r.transactions.map((t) => `${t.date} ${t.type} ${t.assetKey ?? '-'} ${t.quantity ?? t.amount}`);
    expect(summary).toEqual([
      '2025-06-30 deposito - 500',
      '2025-07-02 acquisto fineco-cc:BOT-12GN26 1000',
      '2025-10-01 deposito - 500',
      '2025-10-03 acquisto fineco-cc:VONEXPE27 5',
      '2026-01-30 dividendo fineco-cc:VONEXPE27 26.25',
      '2026-03-03 commissione - 6.82',
      '2026-06-12 vendita fineco-cc:BOT-12GN26 1000',
      '2026-06-15 deposito - 2000',
      '2026-06-23 acquisto fineco-cc:BTP-23GN31ITSICUM 3000',
      '2026-07-08 commissione - 3.2',
      '2026-07-13 prelievo - 151.55',
    ]);
    // Nessun dato personale nelle note: solo la descrizione breve.
    expect(r.transactions.every((t) => !t.note?.includes('XXX'))).toBe(true);
    const btp = r.assets.find((a) => a.symbol === 'BTP-23GN31 IT SI CUM')!;
    expect(btp).toMatchObject({ type: 'obbligazione', priceMultiplier: 0.01, taxRate: 12.5, price: 100 });
  });

  it('nel portafoglio torna con posizioni e saldo finale, anche da .xls', () => {
    const r = finecoConto.parse(toSheets(ROWS, 'biff8'), opts);
    const { data, stats } = mergeSync(emptyData(), { id: 'file:fineco', label: 'Fineco' }, r, '2026-09-24');
    // Il file (ridotto) non parte dall'apertura del conto: la liquidità mancante diventa un saldo iniziale.
    expect(stats.adjustments).toBe(1);
    expect(data.transactions.find((t) => t.note?.startsWith('Saldo iniziale'))).toMatchObject({
      type: 'deposito',
      amount: 581.75,
      date: '2025-06-29',
    });
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    expect(p.cash[0].cash).toBeCloseTo(0);
    expect(p.summary.cost).toBeCloseTo(3462.45);
    const bot = p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.symbol === 'BOT-12GN26')!;
    expect(bot.realized).toBeCloseTo(16.02);
  });

  it('non duplica i titoli se il dossier è già stato importato, e viceversa', () => {
    const dossierIds = new Set(['fineco:1a2b3c4d']);
    const r = finecoConto.parse(sheets, { ...opts, existingIds: dossierIds });
    expect(r.transactions.some((t) => t.assetKey)).toBe(false);
    expect(r.warnings[0]).toMatch(/già presenti/);

    const dossier = fineco.parse(
      [{ name: 'x', rows: [['Operazione', 'Data valuta', 'Descrizione', 'Titolo', 'ISIN', 'Segno', 'Quantita', 'Divisa', 'Prezzo', 'Controvalore'], ['16/06/2026', '23/06/2026', 'Compravendita titoli', 'BTP-23GN31 IT SI CUM', 'IT0005713539', 'A', 3000, 'EUR', 100, 3000]] }],
      { ...opts, existingIds: new Set(['fineco-cc:abcd1234']) },
    );
    expect(dossier.transactions).toEqual([]);
    expect(dossier.assets[0].isin).toBe('IT0005713539');
  });
});
