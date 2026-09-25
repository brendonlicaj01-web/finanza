import { execFile } from 'node:child_process';
import type { AssetType } from '../../src/lib/types.ts';
import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

type Obj = Record<string, unknown>;

/** Solo comandi di lettura: l'app non può mai eseguire ordini o modifiche. */
const READ_COMMANDS = new Set(['whoami', 'broker holdings', 'broker transactions', 'broker cash-breakdown']);

const num = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return NaN;
  if (typeof v === 'object') return num((v as Obj).amount ?? (v as Obj).value);
  return Number(v);
};
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const day = (v: unknown) => {
  const s = typeof v === 'object' && v ? str((v as Obj).time) : str(v);
  return s.slice(0, 10);
};

/**
 * Interpreta l'output JSON del CLI. I dati possono essere dentro due contenitori:
 * la busta macchina `{ ok, command, data }` e, per i comandi broker, `{ account_id, portfolio_id, resolution, result }`.
 */
export function parseScOutput(stdout: string): Obj {
  let parsed: Obj | undefined;
  const text = stdout.trim();
  try {
    parsed = JSON.parse(text);
  } catch {
    // Più righe di log prima del JSON: prova l'ultima riga.
    try {
      parsed = JSON.parse(text.split('\n').filter(Boolean).pop() ?? '');
    } catch {
      parsed = undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new ProviderError('Scalable CLI: risposta non valida.');
  if (parsed.ok === false) {
    const e = (parsed.error ?? {}) as Obj;
    const code = str(e.code);
    if (/session|auth|login|token/i.test(code + str(e.message))) {
      throw new ProviderError('Scalable: sessione assente o scaduta. Nel terminale esegui "sc login --local-read-only" e riprova.');
    }
    throw new ProviderError(`Scalable: ${str(e.message) || code || 'errore del CLI'}`);
  }
  let data: unknown = 'ok' in parsed && 'data' in parsed ? parsed.data : parsed;
  if (data && typeof data === 'object' && 'result' in (data as Obj) && typeof (data as Obj).result === 'object') {
    data = (data as Obj).result;
  }
  return (data ?? {}) as Obj;
}

/** Esegue `sc <comando> --json` e restituisce i dati (gestisce sia l'output semplice sia la busta {ok, data}). */
function sc(bin: string, command: string, args: string[] = []): Promise<Obj> {
  if (!READ_COMMANDS.has(command)) return Promise.reject(new ProviderError(`Comando Scalable non consentito: ${command}`));
  return new Promise((resolve, reject) => {
    execFile(
      bin || 'sc',
      [...command.split(' '), ...args, '--json'],
      { timeout: 120_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          return reject(
            new ProviderError(
              'Scalable CLI non trovato: installalo da github.com/ScalableCapital/scalable-cli (o indica il percorso del comando "sc").',
            ),
          );
        }
        try {
          resolve(parseScOutput(stdout));
        } catch (e) {
          if (e instanceof ProviderError && /risposta non valida/.test(e.message) && (stderr || err)) {
            return reject(new ProviderError(`${e.message} ${(stderr || err?.message || '').slice(0, 200)}`));
          }
          reject(e);
        }
      },
    );
  });
}

function assetType(t: string): AssetType {
  const u = t.toUpperCase();
  if (/STOCK|EQ|SHARE/.test(u)) return 'azione';
  if (/ETF|ETP|ETC|ETN/.test(u)) return 'etf';
  if (/BOND/.test(u)) return 'obbligazione';
  if (/FUND|ELTIF/.test(u)) return 'fondo';
  if (/CRYPTO/.test(u)) return 'crypto';
  return 'altro';
}

const DONE = new Set(['FILLED', 'PARTIAL_FILLED', 'SETTLED', 'CONFIRMED']);

/** Converte le risposte JSON del CLI (holdings, transazioni, liquidità) nel formato comune. */
export function scalableToSync(
  holdingsData: Obj,
  transactionItems: Obj[],
  cashData: Obj | undefined,
  currency: string,
): SyncResult {
  const warnings: string[] = [];
  const assets = new Map<string, SyncAsset>();
  const touch = (isin: string, name?: string, type?: string) => {
    if (!assets.has(isin)) {
      assets.set(isin, { key: isin, symbol: name || isin, name: name || isin, type: assetType(type ?? ''), isin, taxRate: 26 });
    }
    return isin;
  };

  // ---- Posizioni attuali ----
  const holdings: SyncHolding[] = [];
  for (const h of ((holdingsData.items as Obj[]) ?? [])) {
    const isin = str(h.isin);
    const qty = num(h.quantity);
    if (!isin || !(qty > 0)) continue;
    touch(isin, str(h.name), str(h.security_type));
    const a = assets.get(isin)!;
    // Prezzo: quotazione se in EUR, altrimenti valorizzazione / quantità.
    const quote = num(h.quote_mid_price);
    const valuation = num(h.valuation);
    if (str(h.quote_currency || currency) === currency && quote > 0) a.price = quote;
    else if (str(h.valuation_currency || currency) === currency && valuation > 0) a.price = valuation / qty;
    const fifo = num(h.fifo_price);
    holdings.push({ assetKey: isin, quantity: qty, costPrice: fifo > 0 ? fifo : undefined });
  }

  // ---- Transazioni ----
  const transactions: SyncTx[] = [];
  const unknown = new Map<string, number>();
  let cancellations = 0;
  const skippedStatus = new Map<string, number>();
  for (const t of transactionItems) {
    const status = str(t.status).toUpperCase();
    if (status && !DONE.has(status)) {
      skippedStatus.set(status, (skippedStatus.get(status) ?? 0) + 1);
      continue;
    }
    if (t.is_cancellation === true) {
      cancellations++;
      continue;
    }
    const id = `scalable:${str(t.id)}`;
    const date = day(t.last_event_datetime);
    if (!date) continue;
    const amount = Math.abs(num(t.amount)) || 0;
    const kind = str(t.summary_type);

    if (kind === 'BrokerSecurityTransactionSummary' || kind === 'BrokerEltifTransactionSummary') {
      const isin = str(t.isin);
      const qty = Math.abs(num(kind === 'BrokerEltifTransactionSummary' ? t.eltif_quantity : t.quantity));
      if (!isin || !qty) continue;
      const sell = str(t.side).toUpperCase() === 'SELL';
      const plan = /SAVINGS_PLAN/i.test(str(t.security_transaction_type));
      transactions.push({
        externalId: id,
        date,
        type: sell ? 'vendita' : 'acquisto',
        assetKey: touch(isin),
        quantity: qty,
        price: amount / qty,
        fees: 0,
        note: plan ? 'Piano di accumulo' : undefined,
      });
      continue;
    }

    if (kind === 'BrokerNonTradeSecurityTransactionSummary') {
      const isin = str(t.isin);
      const qty = Math.abs(num(t.quantity));
      if (!isin || !qty) continue;
      const inflow = /_IN$|RECEIPT|DELIVERY_IN/i.test(str(t.non_trade_security_transaction_type));
      const key = touch(isin);
      if (amount) {
        transactions.push({ externalId: `${id}:cash`, date, type: inflow ? 'deposito' : 'prelievo', amount, fees: 0, note: inflow ? 'Titoli trasferiti in entrata' : 'Titoli trasferiti in uscita' });
      }
      transactions.push({ externalId: id, date, type: inflow ? 'acquisto' : 'vendita', assetKey: key, quantity: qty, price: amount / qty, fees: 0, note: str(t.non_trade_security_transaction_type).toLowerCase().replace(/_/g, ' ') });
      continue;
    }

    if (kind === 'BrokerCashTransactionSummary') {
      if (!amount) continue;
      const type = str(t.cash_transaction_type).toUpperCase();
      const isin = str(t.related_isin);
      switch (type) {
        case 'DEPOSIT':
        case 'CASH_TRANSFER_IN':
        case 'POCKET_MONEY':
          transactions.push({ externalId: id, date, type: 'deposito', amount, fees: 0, note: 'Deposito' });
          break;
        case 'WITHDRAWAL':
        case 'CASH_TRANSFER_OUT':
          transactions.push({ externalId: id, date, type: 'prelievo', amount, fees: 0, note: 'Prelievo' });
          break;
        case 'DISTRIBUTION':
        case 'REINVESTMENT_DISTRIBUTION':
          transactions.push({ externalId: id, date, type: 'dividendo', assetKey: isin ? touch(isin) : undefined, amount, fees: 0, note: 'Dividendo / distribuzione' });
          break;
        case 'INTEREST':
          transactions.push({ externalId: id, date, type: 'interessi', amount, fees: 0, note: 'Interessi' });
          break;
        case 'FEE':
          transactions.push({ externalId: id, date, type: 'commissione', amount, fees: 0, note: 'Commissione' });
          break;
        case 'TAX':
          transactions.push({ externalId: id, date, type: 'commissione', amount, fees: 0, note: 'Imposte' });
          break;
        case 'TAX_RETURN':
          transactions.push({ externalId: id, date, type: 'commissione', amount: -amount, fees: 0, note: 'Rimborso imposte' });
          break;
        default:
          unknown.set(type || '?', (unknown.get(type || '?') ?? 0) + 1);
      }
      continue;
    }
    unknown.set(kind || '?', (unknown.get(kind || '?') ?? 0) + 1);
  }

  for (const [s, n] of skippedStatus) warnings.push(`${n} transazioni con stato ${s} (non eseguite o annullate) ignorate.`);
  if (cancellations) warnings.push(`${cancellations} storni ignorati: le quantità sono comunque allineate alle posizioni reali.`);
  for (const [t, n] of unknown) warnings.push(`${n} transazioni Scalable di tipo ${t} non riconosciute: ignorate.`);

  const cash = num(cashData?.cash_balance);
  return {
    accountName: 'Scalable Capital',
    accountKind: 'broker',
    currency,
    assets: [...assets.values()],
    transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
    holdings,
    cash: Number.isFinite(cash) ? Math.round(cash * 100) / 100 : undefined,
    warnings,
  };
}

export const scalable: Provider = {
  id: 'scalable',
  label: 'Scalable Capital',
  category: 'broker',
  description: 'Posizioni, transazioni e liquidità tramite il CLI ufficiale di Scalable (Agentic Investing), in sola lettura.',
  available: true,
  docsUrl: 'https://github.com/ScalableCapital/scalable-cli',
  fields: [
    { key: 'bin', label: 'Percorso del comando "sc" (facoltativo)', placeholder: 'sc', optional: true },
    { key: 'portfolioId', label: 'ID portafoglio (facoltativo, se ne hai più di uno)', optional: true },
  ],
  guide: [
    'Sul sito Scalable (versione web): Profilo → Sicurezza → Agentic Investing → attiva "Scalable CLI". Non serve attivare "Scalable MCP".',
    'Installa il CLI ufficiale dalla pagina "Releases" di github.com/ScalableCapital/scalable-cli (su Mac anche con Homebrew: brew install scalable-cli).',
    'Apri il Terminale ed esegui: sc login --local-read-only — completa tu l\'accesso nel browser. Così il CLI resta in sola lettura anche sul tuo computer.',
    'Torna qui e premi "Collega e sincronizza". L\'app esegue solo comandi di lettura (posizioni, transazioni, liquidità): non può inviare ordini.',
  ],
  async test({ bin }) {
    await sc(bin, 'whoami');
  },
  async sync({ bin, portfolioId }, { currency, since }) {
    const ctx = portfolioId ? ['--portfolio-id', portfolioId] : [];
    const [holdings, cash] = await Promise.all([
      sc(bin, 'broker holdings', ctx),
      sc(bin, 'broker cash-breakdown', ctx).catch(() => undefined),
    ]);
    const items: Obj[] = [];
    let cursor: string | undefined;
    const from = since ? ['--from-time', new Date(Date.parse(since) - 7 * 86_400_000).toISOString()] : [];
    for (let page = 0; page < 500; page++) {
      const r = await sc(bin, 'broker transactions', [...ctx, '--page-size', '100', ...from, ...(cursor ? ['--cursor', cursor] : [])]);
      const pageItems = (r.items as Obj[]) ?? [];
      items.push(...pageItems);
      cursor = str(r.cursor) || undefined;
      if (!cursor || !pageItems.length) break;
    }
    const result = scalableToSync(holdings, items, cash, currency);
    // Riepilogo diagnostico, visibile negli avvisi del collegamento.
    result.warnings.unshift(
      `Dal CLI: ${items.length} transazioni${since ? ' recenti' : ''}, ${((holdings.items as Obj[]) ?? []).length} posizioni; importabili ${result.transactions.length} movimenti.`,
    );
    if (!cash) result.warnings.push('Liquidità non disponibile dal CLI: non allineata.');
    return result;
  },
};
