let currency = 'EUR';

export function setCurrency(c: string) {
  currency = c;
}

const moneyFmt = new Map<string, Intl.NumberFormat>();

export function money(n: number, opts: { sign?: boolean; digits?: number } = {}): string {
  const digits = opts.digits ?? 2;
  const k = `${currency}|${digits}|${opts.sign ? 1 : 0}`;
  let f = moneyFmt.get(k);
  if (!f) {
    f = new Intl.NumberFormat('it-IT', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: opts.sign ? 'exceptZero' : 'auto',
    });
    moneyFmt.set(k, f);
  }
  return f.format(Object.is(n, -0) ? 0 : n);
}

/** Prezzo unitario: 2 decimali, fino a 4 per prezzi bassi (es. 4,8825 €). */
export function price(n: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: Math.abs(n) >= 1000 ? 2 : 4,
  }).format(n);
}

/** Importo compatto per assi e tile: 12,9 k€ / 4,2 Mln €. */
export function compactMoney(n: number): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'currency',
    currency,
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(n);
}

export function pct(n: number, opts: { sign?: boolean } = {}): string {
  return new Intl.NumberFormat('it-IT', {
    style: 'percent',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
    signDisplay: opts.sign ? 'exceptZero' : 'auto',
  }).format(n);
}

export function qty(n: number): string {
  return new Intl.NumberFormat('it-IT', { maximumFractionDigits: 8 }).format(n);
}

export function date(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString('it-IT', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Converte input con virgola decimale italiana ("1.234,56" o "1234,56") in numero. */
export function parseNumber(s: string): number {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return NaN;
  const normalized = t.includes(',') ? t.replace(/\./g, '').replace(',', '.') : t;
  return Number(normalized);
}

export function toneOf(n: number): 'pos' | 'neg' | 'neutral' {
  if (n > 0.005) return 'pos';
  if (n < -0.005) return 'neg';
  return 'neutral';
}
