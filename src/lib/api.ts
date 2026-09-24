/** Client dell'API locale (server/). L'header X-Finanza protegge da richieste di altri siti. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`./api${path}`, {
      method: init.method ?? 'GET',
      headers: { 'X-Finanza': '1', ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error('Server locale non raggiungibile.');
  }
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    const msg = (json as { error?: string } | undefined)?.error;
    throw new Error(msg ?? `Errore ${res.status}`);
  }
  if (json === undefined) throw new Error('Risposta non valida dal server locale.');
  return json as T;
}
