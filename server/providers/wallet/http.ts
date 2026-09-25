import { ProviderError } from '../types.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Richiesta JSON a un'API pubblica, con timeout e nuovi tentativi quando il servizio limita le richieste (429)
 * o è momentaneamente non disponibile.
 */
export async function getJson<T = unknown>(
  url: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string>; label?: string } = {},
): Promise<T> {
  const label = init.label ?? new URL(url).host;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
        headers: {
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      if (attempt < 2) {
        await sleep(1000 * (attempt + 1));
        continue;
      }
      throw new ProviderError(`${label} non raggiungibile: ${(e as Error).message}`);
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * 2 ** attempt;
      await sleep(Math.min(wait, 20_000));
      continue;
    }
    if (res.status === 404) throw new HttpNotFound(`${label}: risorsa non trovata.`);
    if (!res.ok) throw new ProviderError(`${label} ha risposto con errore ${res.status}.`);
    return (await res.json()) as T;
  }
}

export class HttpNotFound extends ProviderError {}

/** Esegue `fn` sugli elementi con al massimo `limit` esecuzioni in parallelo. */
export async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

/** Numero da una quantità intera nelle unità minime (satoshi, wei, lamport…). */
export function fromUnits(value: string | number | bigint | undefined | null, decimals: number): number {
  if (value === undefined || value === null || value === '') return 0;
  const s = String(value).trim();
  if (!/^-?\d+$/.test(s)) return Number(s) || 0;
  const neg = s.startsWith('-');
  const digits = (neg ? s.slice(1) : s).padStart(decimals + 1, '0');
  const n = Number(`${digits.slice(0, digits.length - decimals)}.${digits.slice(digits.length - decimals) || '0'}`);
  return neg ? -n : n;
}
