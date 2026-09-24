import type { FileImporter, Sheet } from './types';
import { fineco } from './fineco';
import { finecoConto } from './finecoConto';
import { generic } from './generic';

export type { FileImporter, Sheet, ImportOptions } from './types';

/** In ordine di priorità: i formati specifici prima, il generico per ultimo. */
export const importers: FileImporter[] = [finecoConto, fineco, generic];

export function detectImporter(sheets: Sheet[]): FileImporter | undefined {
  return importers.find((i) => i.detect(sheets));
}

/** UTF-8 se valido, altrimenti Windows-1252 (tipico dei CSV esportati da Excel in italiano). */
export function decodeText(buf: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Legge un file xls/xlsx/csv nel browser (SheetJS caricato solo quando serve). */
export async function readSheets(file: File): Promise<Sheet[]> {
  if (file.size > 20 * 1024 * 1024) throw new Error('File troppo grande (massimo 20 MB).');
  const XLSX = await import('@e965/xlsx');
  const buf = await file.arrayBuffer();
  const isText = /\.(csv|txt|tsv)$/i.test(file.name) || file.type.startsWith('text/');
  const wb = isText
    ? // CSV: letto come testo senza interpretare i valori (le date italiane non diventano americane).
      XLSX.read(decodeText(buf), { type: 'string', raw: true })
    : XLSX.read(buf, { type: 'array', cellDates: false });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
}
