import { parseNumber } from '../format';
import type { SyncTx } from '../sync-types';
import type { AssetType } from '../types';

export const cellText = (v: unknown) => (v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();

/** Numero da cella: già numerico, oppure testo in formato italiano ("1.234,56") o inglese. */
export function cellNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const t = cellText(v).replace(/[€$\s]/g, '');
  if (!t) return NaN;
  return parseNumber(t);
}

/** Data da cella: "dd/mm/yyyy", "yyyy-mm-dd", "dd.mm.yyyy" o numero seriale di Excel. */
export function cellDate(v: unknown): string {
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const t = cellText(v);
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

export const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');

/** Trova la riga d'intestazione che contiene tutte le colonne richieste; restituisce indice e mappa colonne. */
export function findHeader(
  rows: unknown[][],
  required: string[],
): { index: number; col: (name: string) => number } | undefined {
  const want = required.map(norm);
  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const cells = rows[i].map((c) => norm(cellText(c)));
    if (want.every((w) => cells.includes(w))) {
      return { index: i, col: (name: string) => cells.indexOf(norm(name)) };
    }
  }
  return undefined;
}

/** Hash FNV-1a a 32 bit, per creare identificativi stabili delle righe importate. */
export function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Crea id univoci anche per righe identiche nello stesso file (es. due acquisti uguali nello stesso giorno). */
export function idMaker(prefix: string) {
  const seen = new Map<string, number>();
  return (parts: unknown[]) => {
    const h = hash(parts.map(cellText).join('|'));
    const n = (seen.get(h) ?? 0) + 1;
    seen.set(h, n);
    return `${prefix}:${h}${n > 1 ? `-${n}` : ''}`;
  };
}

const GOV = /^(\*+)?\s*(BTP|BOT|CCT|CTZ)\b/i;
const ETF = /\b(ISHARES|VANGUARD|XTRACKERS|AMUNDI|LYXOR|SPDR|INVESCO|WISDOMTREE|VANECK|UBS ETF|HSBC ETF|ETF|UCITS|ETC)\b/i;
const CERT = /\b(VON|VONTOBEL|BNP|SOCGEN|SG ISSUER|UNICREDIT|LEONTEQ|MEDIOBANCA|CITIGROUP|CERT|CERTIFICAT|EXPRESS|PHOENIX|TURBO|MINI FUT)\b/i;

/** Deduce tipo, convenzione di prezzo e aliquota da nome e ISIN. */
export function classify(name: string, isin?: string): { type: AssetType; priceMultiplier?: number; taxRate: number } {
  if (GOV.test(name)) return { type: 'obbligazione', priceMultiplier: 0.01, taxRate: 12.5 };
  if (/\b(BOND|OBBL|BTP|CORP|FRN|TF|TV)\b/i.test(name) && isin && !ETF.test(name)) {
    return { type: 'obbligazione', priceMultiplier: 0.01, taxRate: 26 };
  }
  if (ETF.test(name)) return { type: 'etf', taxRate: 26 };
  if (CERT.test(name)) return { type: 'altro', taxRate: 26 };
  return { type: 'azione', taxRate: 26 };
}

/** Movimento di liquidità speculare a un'operazione: il conto titoli resta a saldo zero. */
export function cashMirror(tx: SyncTx, multiplier = 1): SyncTx | undefined {
  let amount: number;
  if (tx.type === 'acquisto') amount = -((tx.quantity ?? 0) * (tx.price ?? 0) * multiplier + tx.fees);
  else if (tx.type === 'vendita') amount = (tx.quantity ?? 0) * (tx.price ?? 0) * multiplier - tx.fees;
  else if (tx.type === 'dividendo' || tx.type === 'interessi') amount = (tx.amount ?? 0) - tx.fees;
  else return undefined;
  if (Math.abs(amount) < 0.005) return undefined;
  return {
    externalId: `${tx.externalId}:cash`,
    date: tx.date,
    type: amount < 0 ? 'deposito' : 'prelievo',
    amount: Math.round(Math.abs(amount) * 100) / 100,
    fees: 0,
    note: amount < 0 ? 'Addebito da conto corrente (automatico)' : 'Accredito su conto corrente (automatico)',
  };
}

/** Nome di conto dal nome del file: "directa_movimenti_2026.csv" → "Directa" (salta codici e date). */
export function nameFromFile(fileName: string): string {
  const tokens = fileName.replace(/\.[^.]+$/, '').split(/[_\-\s.]+/);
  const word = tokens.find((t) => /^[a-zà-ù]{3,}$/i.test(t)) ?? 'Conto importato';
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}
