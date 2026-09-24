import type { FileImporter, Sheet } from './types';
import { fineco } from './fineco';
import { finecoConto } from './finecoConto';

export type { FileImporter, Sheet, ImportOptions } from './types';

export const importers: FileImporter[] = [finecoConto, fineco];

export function detectImporter(sheets: Sheet[]): FileImporter | undefined {
  return importers.find((i) => i.detect(sheets));
}

/** Legge un file xls/xlsx/csv nel browser (SheetJS caricato solo quando serve). */
export async function readSheets(file: File): Promise<Sheet[]> {
  if (file.size > 20 * 1024 * 1024) throw new Error('File troppo grande (massimo 20 MB).');
  const XLSX = await import('@e965/xlsx');
  const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: false });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
}
