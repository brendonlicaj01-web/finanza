import type { AppData } from './types';
import { TX_TYPES } from './types';
import { sortTransactions } from './portfolio';

function cell(v: string | number | undefined): string {
  if (v === undefined) return '';
  const s = typeof v === 'number' ? String(v).replace('.', ',') : v;
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV con separatore ";" e virgola decimale, apribile direttamente in Excel italiano. */
export function transactionsToCsv(data: AppData): string {
  const accounts = new Map(data.accounts.map((a) => [a.id, a.name]));
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const labels = new Map(TX_TYPES.map((t) => [t.value, t.label]));
  const header = ['Data', 'Tipo', 'Conto', 'Simbolo', 'Strumento', 'Quantità', 'Prezzo', 'Importo', 'Commissioni', 'Note'];
  const rows = sortTransactions(data.transactions).map((tx) => {
    const asset = tx.assetId ? assets.get(tx.assetId) : undefined;
    const amount =
      tx.type === 'acquisto' || tx.type === 'vendita' ? (tx.quantity ?? 0) * (tx.price ?? 0) : tx.amount;
    return [
      tx.date,
      labels.get(tx.type) ?? tx.type,
      accounts.get(tx.accountId) ?? '',
      asset?.symbol,
      asset?.name,
      tx.quantity,
      tx.price,
      amount,
      tx.fees,
      tx.note,
    ]
      .map(cell)
      .join(';');
  });
  return [header.join(';'), ...rows].join('\n');
}

export function download(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
