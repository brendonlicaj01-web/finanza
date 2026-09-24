import type { IncomingMessage, ServerResponse } from 'node:http';
import { providers } from './providers/index.ts';
import { ProviderError } from './providers/types.ts';
import { store, toInfo } from './store.ts';

type Next = (err?: unknown) => void;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, 'Richiesta troppo grande.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON non valido.');
  }
}

function secretKeys(providerId: string): Set<string> {
  const p = providers.find((x) => x.id === providerId);
  return new Set(p?.fields.filter((f) => f.secret).map((f) => f.key) ?? []);
}

function provider(id: string) {
  const p = providers.find((x) => x.id === id);
  if (!p) throw new HttpError(404, `Fonte "${id}" sconosciuta.`);
  if (!p.available) throw new HttpError(400, `${p.label} non è ancora disponibile.`);
  return p;
}

/**
 * API locale dell'app. Ogni richiesta deve avere l'header "X-Finanza": un sito esterno aperto nel
 * browser non può aggiungerlo senza un preflight CORS, che qui non viene mai autorizzato.
 */
export async function handleApi(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  try {
    if (req.headers['x-finanza'] !== '1') throw new HttpError(403, 'Richiesta non autorizzata.');
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });

    if (method === 'GET' && path === '/providers') {
      return send(
        res,
        200,
        providers.map(({ test: _t, sync: _s, ...info }) => info),
      );
    }

    if (method === 'GET' && path === '/connections') {
      const all = await store.list();
      return send(res, 200, all.map((c) => toInfo(c, secretKeys(c.provider))));
    }

    if (method === 'POST' && path === '/connections') {
      const body = await readJson(req);
      const p = provider(String(body.provider ?? ''));
      const raw = (body.credentials ?? {}) as Record<string, unknown>;
      const credentials: Record<string, string> = {};
      for (const f of p.fields) {
        const v = String(raw[f.key] ?? '').trim();
        if (!v && !f.optional) throw new HttpError(400, `Compila il campo "${f.label}".`);
        if (v) credentials[f.key] = v;
      }
      await p.test(credentials);
      const label = String(body.label ?? '').trim() || p.label;
      const saved = await store.add({ provider: p.id, label, credentials });
      return send(res, 201, toInfo(saved, secretKeys(p.id)));
    }

    const m = path.match(/^\/connections\/([\w-]+)(\/sync)?$/);
    if (m) {
      const conn = await store.get(m[1]);
      if (!conn) throw new HttpError(404, 'Collegamento non trovato.');
      if (method === 'DELETE' && !m[2]) {
        await store.remove(conn.id);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && m[2]) {
        const body = await readJson(req);
        const p = provider(conn.provider);
        const full = body.full === true;
        const result = await p.sync(conn.credentials, {
          currency: String(body.currency ?? 'EUR'),
          since: full ? undefined : conn.lastSyncAt,
        });
        const updated = await store.update(conn.id, { lastSyncAt: new Date().toISOString() });
        return send(res, 200, { result, connection: updated && toInfo(updated, secretKeys(p.id)) });
      }
    }

    next();
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e instanceof ProviderError) return send(res, 502, { error: e.message });
    console.error('[finanza-api]', e);
    send(res, 500, { error: `Errore inatteso: ${(e as Error).message}` });
  }
}
