import { emptyData, type AppData } from './types';

const KEY = 'finanza:data:v1';

export function loadData(): AppData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return emptyData();
    return parseData(raw);
  } catch {
    return emptyData();
  }
}

export function saveData(data: AppData): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Valida e normalizza un backup JSON. Lancia un errore se il formato non è riconosciuto. */
export function parseData(raw: string): AppData {
  const obj = JSON.parse(raw);
  if (!obj || typeof obj !== 'object' || obj.version !== 1) {
    throw new Error('Formato del file non riconosciuto.');
  }
  for (const k of ['accounts', 'assets', 'transactions'] as const) {
    if (!Array.isArray(obj[k])) throw new Error(`Campo "${k}" mancante o non valido.`);
  }
  const base = emptyData();
  return {
    version: 1,
    accounts: obj.accounts,
    assets: obj.assets,
    transactions: obj.transactions,
    snapshots: Array.isArray(obj.snapshots) ? obj.snapshots : [],
    settings: { ...base.settings, ...(obj.settings ?? {}) },
  };
}
