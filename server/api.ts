import type { IncomingMessage, ServerResponse } from 'node:http';
import { providers } from './providers/index.ts';
import { ProviderError } from './providers/types.ts';
import { randomBytes } from 'node:crypto';
import { store, toInfo, type StoredConnection } from './store.ts';
import type { Bank } from './providers/types.ts';
import { PriceBook } from './providers/wallet/prices.ts';

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

function info(c: StoredConnection) {
  const p = providers.find((x) => x.id === c.provider);
  return toInfo(c, p?.fields ?? [], p?.auth?.status(c.credentials));
}

/** Autorizzazioni bancarie in corso: state → collegamento (scadono dopo 30 minuti). */
const pending = new Map<string, { connectionId: string; expires: number }>();

function isLocalUrl(u: string) {
  try {
    const url = new URL(u);
    return ['localhost', '127.0.0.1'].includes(url.hostname) && url.protocol === 'http:';
  } catch {
    return false;
  }
}

async function completeAuth(state: string, code: string) {
  const entry = pending.get(state);
  if (!entry || entry.expires < Date.now()) {
    throw new HttpError(400, 'Autorizzazione scaduta o non riconosciuta: riavviala dall\'app.');
  }
  const conn = await store.get(entry.connectionId);
  if (!conn) throw new HttpError(404, 'Collegamento non trovato.');
  const p = provider(conn.provider);
  if (!p.auth) throw new HttpError(400, 'Questa fonte non richiede autorizzazione.');
  const extra = await p.auth.completeAuth(conn.credentials, code);
  pending.delete(state);
  const updated = await store.update(conn.id, { credentials: { ...conn.credentials, ...extra } });
  return updated!;
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

function page(res: ServerResponse, ok: boolean, message: string) {
  res.statusCode = ok ? 200 : 400;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Finanza</title><style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;padding:16px;background:#f9f9f7;color:#0b0b0b}
@media(prefers-color-scheme:dark){body{background:#0d0d0d;color:#fff}}main{max-width:420px;text-align:center}a{color:#2a78d6}</style></head>
<body><main><h1>${ok ? '✓ Banca collegata' : '✕ Collegamento non riuscito'}</h1><p>${escapeHtml(message)}</p>
<p><a href="/#collegamenti">Torna a Finanza</a></p></main>${ok ? '<script>setTimeout(()=>{window.close()},1500)</script>' : ''}</body></html>`);
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
    // Ritorno dalla banca: è una normale navigazione del browser, protetta dal parametro "state".
    if (req.method === 'GET' && path === '/oauth/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state') ?? '';
      const error = url.searchParams.get('error_description') || url.searchParams.get('error');
      if (error || !code) return page(res, false, error ? `La banca ha risposto: ${error}` : 'Codice mancante.');
      try {
        await completeAuth(state, code);
        return page(res, true, 'Accesso autorizzato. Puoi chiudere questa finestra e tornare all\'app.');
      } catch (e) {
        return page(res, false, (e as Error).message);
      }
    }

    if (req.headers['x-finanza'] !== '1') throw new HttpError(403, 'Richiesta non autorizzata.');
    const method = req.method ?? 'GET';

    if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });

    if (method === 'GET' && path === '/providers') {
      return send(
        res,
        200,
        providers.map(({ test: _t, sync: _s, auth: _a, ...rest }) => rest),
      );
    }

    // Prezzi giornalieri in euro delle crypto (fonti pubbliche, in cache), per valorizzare gli import da file
    // che non contengono i controvalori (es. Exodus).
    if (method === 'POST' && path === '/prices') {
      const body = await readJson(req);
      const symbols = (Array.isArray(body.symbols) ? body.symbols : [])
        .map((x) => String(x).toUpperCase())
        .filter((x) => /^[A-Z0-9.]{1,15}$/.test(x))
        .slice(0, 200);
      const from = Date.parse(`${String(body.from ?? '')}T00:00:00Z`);
      const book = new PriceBook();
      await book.prepare(symbols, Number.isFinite(from) ? from : Date.now() - 365 * 86_400_000);
      await book.save().catch(() => {});
      const out: Record<string, Record<string, number>> = {};
      for (const sym of symbols) {
        const series = book.series(sym);
        if (series) out[sym] = series;
      }
      return send(res, 200, out);
    }

    if (method === 'GET' && path === '/connections') {
      const all = await store.list();
      return send(res, 200, all.map(info));
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
      return send(res, 201, info(saved));
    }

    const m = path.match(/^\/connections\/([\w-]+)(\/sync|\/banks|\/authorize|\/authorize\/complete)?$/);
    if (m) {
      const conn = await store.get(m[1]);
      if (!conn) throw new HttpError(404, 'Collegamento non trovato.');
      const action = m[2];

      if (action === '/banks' && method === 'GET') {
        const p = provider(conn.provider);
        if (!p.auth) throw new HttpError(400, 'Questa fonte non richiede autorizzazione.');
        return send(res, 200, await p.auth.listBanks(conn.credentials, url.searchParams.get('country') || 'IT'));
      }

      if (action === '/authorize' && method === 'POST') {
        const p = provider(conn.provider);
        if (!p.auth) throw new HttpError(400, 'Questa fonte non richiede autorizzazione.');
        const body = await readJson(req);
        const bank = body.bank as Bank | undefined;
        const redirectUrl = String(body.redirectUrl ?? '');
        if (!bank?.name || !bank.country) throw new HttpError(400, 'Scegli una banca.');
        if (!isLocalUrl(redirectUrl)) throw new HttpError(400, 'Indirizzo di ritorno non valido.');
        const state = randomBytes(24).toString('base64url');
        for (const [k, v] of pending) if (v.expires < Date.now()) pending.delete(k);
        pending.set(state, { connectionId: conn.id, expires: Date.now() + 30 * 60_000 });
        return send(res, 200, { url: await p.auth.startAuth(conn.credentials, bank, redirectUrl, state) });
      }

      if (action === '/authorize/complete' && method === 'POST') {
        // Alternativa manuale: l'utente incolla l'indirizzo della pagina finale della banca.
        const body = await readJson(req);
        let pasted: URL;
        try {
          pasted = new URL(String(body.url ?? '').trim());
        } catch {
          throw new HttpError(400, 'Incolla l\'indirizzo completo della pagina (inizia con http).');
        }
        const code = pasted.searchParams.get('code');
        const state = pasted.searchParams.get('state') ?? '';
        if (!code) throw new HttpError(400, 'Nell\'indirizzo non c\'è il codice di autorizzazione.');
        if (pending.get(state)?.connectionId !== conn.id) {
          throw new HttpError(400, 'Questo indirizzo non corrisponde all\'autorizzazione in corso.');
        }
        return send(res, 200, info(await completeAuth(state, code)));
      }

      if (method === 'DELETE' && !action) {
        await store.remove(conn.id);
        return send(res, 200, { ok: true });
      }
      if (method === 'POST' && action === '/sync') {
        const body = await readJson(req);
        const p = provider(conn.provider);
        const full = body.full === true;
        const result = await p.sync(conn.credentials, {
          currency: String(body.currency ?? 'EUR'),
          since: full ? undefined : conn.lastSyncAt,
        });
        const updated = await store.update(conn.id, { lastSyncAt: new Date().toISOString() });
        return send(res, 200, { result, connection: updated && info(updated) });
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
