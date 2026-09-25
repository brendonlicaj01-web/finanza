import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AssetType } from '../../src/lib/types.ts';
import { classify } from '../../src/lib/importers/util.ts';
import { cryptoTicker } from '../../src/lib/assets.ts';
import { DATA_DIR } from '../store.ts';
import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

type Obj = Record<string, unknown>;

/** Solo comandi di lettura: l'app non può mai eseguire ordini o modifiche. */
const READ_COMMANDS = new Set([
  'whoami',
  'broker holdings',
  'broker transactions',
  'broker transaction details',
  'broker cash-breakdown',
  'broker search',
]);

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

/** Tipo di strumento dal tipo Scalable, con ripiego sul nome (ETF, obbligazioni, certificati…). */
export function assetType(t: string, name = '', isin = ''): AssetType {
  const u = t.toUpperCase();
  if (/CRYPTO|COIN/.test(u) || /^XF000/.test(isin)) return 'crypto';
  if (/ETF|ETP|ETC|ETN|EXCHANGE_TRADED/.test(u)) return 'etf';
  if (/BOND|FIXED_INCOME|ANLEIHE/.test(u)) return 'obbligazione';
  if (/FUND|ELTIF/.test(u)) return 'fondo';
  if (/STOCK|EQUITY|^EQ$|SHARE|AKTIE/.test(u)) return 'azione';
  if (/WARRANT|KNOCK|CERTIFICATE|DERIVATIVE|TURBO/.test(u)) return 'altro';
  return name ? classify(name, isin).type : 'altro';
}

const DONE = new Set(['FILLED', 'PARTIAL_FILLED', 'SETTLED', 'CONFIRMED']);
const r2 = (n: number) => Math.round(n * 100) / 100;
const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

/** Dettaglio di una transazione (`sc broker transaction details`), già estratto dal contenitore. */
export type Details = Obj;

/** Transazioni per cui servono i dettagli: operazioni sui titoli e proventi (lordo e ritenute). */
export function needsDetails(t: Obj): boolean {
  const kind = str(t.summary_type);
  if (t.is_cancellation === true) return false;
  const status = str(t.status).toUpperCase();
  if (status && !DONE.has(status)) return false;
  if (kind === 'BrokerSecurityTransactionSummary' || kind === 'BrokerNonTradeSecurityTransactionSummary' || kind === 'BrokerEltifTransactionSummary') return true;
  return kind === 'BrokerCashTransactionSummary' && /DISTRIBUTION/.test(str(t.cash_transaction_type).toUpperCase());
}

/**
 * Converte le risposte del CLI nel formato comune.
 * - `details`: dettagli per id transazione (prezzo, quote eseguite, commissioni, imposte, nome del titolo);
 * - `lookup`: nome e tipo per ISIN (dalla ricerca), per i titoli senza dettagli.
 */
export function scalableToSync(
  holdingsData: Obj,
  transactionItems: Obj[],
  cashData: Obj | undefined,
  currency: string,
  details: Map<string, Details> = new Map(),
  lookup: Map<string, { name: string; type: string }> = new Map(),
): SyncResult {
  const warnings: string[] = [];
  const assets = new Map<string, SyncAsset>();
  /** Crea o completa lo strumento: un nome vero sostituisce l'ISIN usato come segnaposto. */
  const touch = (isin: string, name?: string, type?: string) => {
    const known = lookup.get(isin);
    const nm = name || known?.name || '';
    const tp = type || known?.type || '';
    const a = assets.get(isin);
    if (!a) {
      const type = assetType(tp, nm, isin);
      // Crypto: il simbolo è il ticker (BTC, non "Bitcoin"), come sugli exchange e nei wallet.
      const symbol = cryptoTicker({ symbol: nm || isin, name: nm, type, isin }) ?? (nm || isin);
      assets.set(isin, { key: isin, symbol, name: nm || isin, type, isin, taxRate: 26 });
    } else {
      if (nm && a.name === isin) {
        a.name = nm;
        a.symbol = cryptoTicker({ symbol: nm, name: nm, type: a.type, isin }) ?? nm;
      }
      if (a.type === 'altro' && (tp || nm)) a.type = assetType(tp, nm, isin);
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
    const quote = num(h.quote_mid_price);
    const valuation = num(h.valuation);
    if (str(h.quote_currency || currency) === currency && quote > 0) a.price = quote;
    else if (str(h.valuation_currency || currency) === currency && valuation > 0) a.price = valuation / qty;
    const fifo = num(h.fifo_price);
    holdings.push({ assetKey: isin, quantity: qty, costPrice: fifo > 0 ? fifo : undefined });
  }

  // ---- Transazioni ----
  const transactions: SyncTx[] = [];
  const remove: string[] = [];
  const unknown = new Map<string, number>();
  const skippedStatus = new Map<string, number>();
  let cancellations = 0;
  let withoutDetails = 0;

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
    const txId = str(t.id);
    const id = `scalable:${txId}`;
    const d = details.get(txId);
    // Versione dei dati: con il dettaglio (prezzo, commissioni, imposte) sostituisce un import precedente senza.
    const rev = d ? 2 : 1;
    const date = day(t.last_event_datetime) || day(d?.last_event_datetime);
    if (!date) continue;
    const amount = Math.abs(num(t.amount)) || 0;
    const kind = str(t.summary_type);
    const sec = (d?.security ?? {}) as Obj;

    if (kind === 'BrokerSecurityTransactionSummary' || kind === 'BrokerEltifTransactionSummary') {
      const isin = str(t.isin) || str(sec.isin);
      const trade = (d?.security_trade ?? d?.eltif ?? {}) as Obj;
      const shares = (trade.number_of_shares ?? {}) as Obj;
      const qty =
        pos(num(shares.filled)) ||
        pos(num(trade.eltif_quantity)) ||
        Math.abs(num(kind === 'BrokerEltifTransactionSummary' ? t.eltif_quantity : t.quantity));
      if (!isin || !qty) continue;
      if (!d) withoutDetails++;
      const sell = str(t.side || trade.side).toUpperCase() === 'SELL';
      const tta = (trade.trade_transaction_amounts ?? {}) as Obj;
      // Prezzo: controvalore di mercato ÷ quote; altrimenti prezzo medio; altrimenti importo ÷ quote.
      const market = pos(num(tta.market_valuation));
      const price = market ? market / qty : pos(num(trade.average_price)) || pos(num(trade.execution_price)) || amount / qty;
      // Commissioni: voci dettagliate se presenti, altrimenti commissione complessiva.
      const detailed = [tta.transaction_fee, tta.venue_fee, tta.crypto_spread_fee].map((v) => Math.abs(num(v)) || 0);
      const fees = detailed.some(Boolean)
        ? detailed.reduce((a, b) => a + b, 0)
        : (Math.abs(num(trade.fee)) || 0) + (Math.abs(num(trade.transactional_fee)) || 0);
      const taxesObj = (trade.aggregated_transaction_taxes ?? {}) as Obj;
      const taxes = Math.abs(num(taxesObj.total_tax)) || Math.abs(num(tta.tax_amount)) || Math.abs(num(trade.taxes)) || 0;
      const plan = /SAVINGS_PLAN/i.test(str(t.security_transaction_type));
      transactions.push({
        externalId: id,
        date,
        type: sell ? 'vendita' : 'acquisto',
        assetKey: touch(isin, str(sec.name), str(sec.security_type)),
        quantity: qty,
        price,
        fees: r2(fees),
        note: plan ? 'Piano di accumulo' : undefined,
        rev,
      });
      if (taxes >= 0.01) {
        transactions.push({ externalId: `${id}:tax`, date, type: 'commissione', amount: r2(taxes), fees: 0, note: `Imposte su ${sell ? 'vendita' : 'acquisto'}`, rev });
      }
      continue;
    }

    if (kind === 'BrokerNonTradeSecurityTransactionSummary') {
      const nt = (d?.non_trade_security ?? {}) as Obj;
      const isin = str(t.isin) || str(nt.isin) || str(sec.isin);
      const qty = Math.abs(num(t.quantity)) || Math.abs(num(nt.quantity));
      if (!isin || !qty) continue;
      const kindNt = str(t.non_trade_security_transaction_type || nt.non_trade_security_transaction_type);
      const inflow = /_IN$|RECEIPT|DELIVERY_IN|BONUS|SPLIT_IN/i.test(kindNt);
      const value = amount || Math.abs(num(nt.total_amount)) || qty * (Math.abs(num(nt.average_price)) || 0);
      const key = touch(isin, str(sec.name), str(sec.security_type));
      if (assets.get(key)?.type === 'crypto') {
        // Crypto da/verso un altro conto o wallet: trasferimento interno, non compravendita. Sostituisce
        // acquisto/vendita con movimento di liquidità speculare delle versioni precedenti.
        transactions.push({
          externalId: id,
          date,
          type: inflow ? 'trasf_entrata' : 'trasf_uscita',
          assetKey: key,
          quantity: qty,
          price: value / qty,
          fees: 0,
          note: inflow ? 'Ricevute da altro conto o wallet' : 'Inviate ad altro conto o wallet',
          rev: rev + 2,
        });
        remove.push(`${id}:cash`);
        continue;
      }
      if (value) {
        transactions.push({ externalId: `${id}:cash`, date, type: inflow ? 'deposito' : 'prelievo', amount: r2(value), fees: 0, note: inflow ? 'Titoli trasferiti in entrata' : 'Titoli trasferiti in uscita', rev });
      }
      transactions.push({ externalId: id, date, type: inflow ? 'acquisto' : 'vendita', assetKey: key, quantity: qty, price: value / qty, fees: 0, note: kindNt.toLowerCase().replace(/_/g, ' '), rev });
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
        case 'REINVESTMENT_DISTRIBUTION': {
          // Dal dettaglio: importo lordo e imposte trattenute.
          const tax = ((d?.cash as Obj)?.tax_details ?? {}) as Obj;
          const gross = Math.abs(num(tax.gross_amount));
          const withheld = Math.abs(num(tax.tax_amount));
          transactions.push({
            externalId: id,
            date,
            type: 'dividendo',
            assetKey: isin ? touch(isin) : undefined,
            amount: gross > 0 ? r2(gross) : amount,
            fees: gross > 0 && withheld ? r2(withheld) : 0,
            note: 'Dividendo / distribuzione',
            rev,
          });
          break;
        }
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
  if (withoutDetails) warnings.push(`${withoutDetails} operazioni senza dettaglio: prezzo ricavato dall'importo, commissioni non disponibili.`);
  for (const [t, n] of unknown) warnings.push(`${n} transazioni Scalable di tipo ${t} non riconosciute: ignorate.`);
  const unnamed = [...assets.values()].filter((a) => a.name === a.isin).length;
  if (unnamed) warnings.push(`${unnamed} strumenti senza nome da Scalable: mostrati con l'ISIN.`);

  const cash = num(cashData?.cash_balance);
  return {
    accountName: 'Scalable Capital',
    accountKind: 'broker',
    currency,
    assets: [...assets.values()],
    transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
    holdings,
    cash: Number.isFinite(cash) ? r2(cash) : undefined,
    complete: true,
    remove,
    warnings,
  };
}

/** Cache locale dei dettagli delle transazioni concluse (non cambiano più): evita di richiederli ogni volta. */
const CACHE_FILE = join(DATA_DIR, 'cache', 'scalable-details.json');

async function readCache(): Promise<Record<string, Details>> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

async function writeCache(cache: Record<string, Details>) {
  await mkdir(join(DATA_DIR, 'cache'), { recursive: true, mode: 0o700 });
  await writeFile(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
}

/** Esegue `fn` sugli elementi con al massimo `limit` esecuzioni in parallelo. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export const scalable: Provider = {
  id: 'scalable',
  label: 'Scalable Capital',
  category: 'broker',
  description: 'Posizioni, transazioni con commissioni e imposte, e liquidità tramite il CLI ufficiale di Scalable (Agentic Investing), in sola lettura.',
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
    'Torna qui e premi "Collega e sincronizza". La prima sincronizzazione legge il dettaglio di ogni operazione e può richiedere qualche minuto; le successive sono rapide.',
  ],
  async test({ bin }) {
    await sc(bin, 'whoami');
  },
  // Legge sempre tutto lo storico (ignora `since`): le pagine sono leggere e i dettagli già letti sono in cache,
  // così le operazioni importate in passato con dati incompleti vengono corrette a ogni sincronizzazione.
  async sync({ bin, portfolioId }, { currency }) {
    const ctx = portfolioId ? ['--portfolio-id', portfolioId] : [];
    const [holdings, cash] = await Promise.all([
      sc(bin, 'broker holdings', ctx),
      sc(bin, 'broker cash-breakdown', ctx).catch(() => undefined),
    ]);

    const items: Obj[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 500; page++) {
      const r = await sc(bin, 'broker transactions', [...ctx, '--page-size', '100', ...(cursor ? ['--cursor', cursor] : [])]);
      const pageItems = (r.items as Obj[]) ?? [];
      items.push(...pageItems);
      cursor = str(r.cursor) || undefined;
      if (!cursor || !pageItems.length) break;
    }

    // Dettagli (prezzo, commissioni, imposte, nome del titolo), dalla cache o dal CLI.
    const cache = await readCache();
    const details = new Map<string, Details>();
    const missing: string[] = [];
    for (const t of items) {
      if (!needsDetails(t)) continue;
      const id = str(t.id);
      if (cache[id]) details.set(id, cache[id]);
      else missing.push(id);
    }
    let failed = 0;
    await pool(missing, 4, async (id) => {
      try {
        const d = await sc(bin, 'broker transaction details', [...ctx, '--transaction-id', id]);
        details.set(id, d);
        cache[id] = d;
      } catch {
        failed++;
      }
    });
    if (missing.length) await writeCache(cache).catch(() => {});

    // Nome e tipo per gli ISIN ancora senza nome (es. titoli venduti senza dettaglio).
    const named = new Set<string>();
    for (const h of ((holdings.items as Obj[]) ?? [])) if (str(h.name)) named.add(str(h.isin));
    for (const d of details.values()) if (str((d.security as Obj)?.name)) named.add(str((d.security as Obj).isin));
    const lookup = new Map<string, { name: string; type: string }>();
    const relevant = items.filter((t) => DONE.has(str(t.status).toUpperCase()) && t.is_cancellation !== true);
    const isins = [...new Set(relevant.map((t) => str(t.isin) || str(t.related_isin)).filter((i) => i && !named.has(i)))];
    let lookedUp = false;
    await pool(isins, 4, async (isin) => {
      const cached = cache[`isin:${isin}`] as { name: string; type: string } | undefined;
      if (cached?.name) {
        lookup.set(isin, cached);
        return;
      }
      try {
        const r = await sc(bin, 'broker search', [isin, ...ctx]);
        const hit = ((r.items as Obj[]) ?? []).find((x) => str(x.isin) === isin);
        if (hit && str(hit.name)) {
          const found = { name: str(hit.name), type: str(hit.security_type) };
          lookup.set(isin, found);
          cache[`isin:${isin}`] = found;
          lookedUp = true;
        }
      } catch {
        // resta l'ISIN come nome
      }
    });
    if (lookedUp) await writeCache(cache).catch(() => {});

    const result = scalableToSync(holdings, items, cash, currency, details, lookup);
    result.warnings.unshift(
      `Dal CLI: ${items.length} transazioni, ${((holdings.items as Obj[]) ?? []).length} posizioni, ${details.size} dettagli; importabili ${result.transactions.length} movimenti.`,
    );
    if (failed) result.warnings.push(`${failed} dettagli non disponibili dal CLI: per quelle operazioni prezzo ricavato dall'importo.`);
    if (!cash) result.warnings.push('Liquidità non disponibile dal CLI: non allineata.');
    return result;
  },
};
