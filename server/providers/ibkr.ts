import { XMLParser } from 'fast-xml-parser';
import type { AssetType } from '../../src/lib/types.ts';
import type { SyncAsset, SyncHolding, SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Provider } from './types.ts';

const BASE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
const UA = 'Finanza/1.0 (+app personale)';

type Attrs = Record<string, string | undefined>;

const ARRAYS = new Set([
  'FlexStatement',
  'Trade',
  'CashTransaction',
  'OpenPosition',
  'CashReportCurrency',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => ARRAYS.has(name),
});

const num = (v?: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Le date Flex arrivano come "20250115", "2025-01-15", "20250115;093000" o "2025-01-15, 09:30:00". */
export function flexDate(v?: string): string {
  const digits = (v ?? '').replace(/[^0-9]/g, '').slice(0, 8);
  if (digits.length !== 8) return '';
  return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
}

function assetType(a: Attrs): AssetType {
  const cat = (a.assetCategory ?? '').toUpperCase();
  const sub = (a.subCategory ?? '').toUpperCase();
  if (cat === 'STK') return sub === 'ETF' ? 'etf' : 'azione';
  if (cat === 'FUND') return 'fondo';
  if (cat === 'BOND' || cat === 'BILL') return 'obbligazione';
  if (cat === 'CRYPTO') return 'crypto';
  if (cat === 'CMDTY') return 'materia_prima';
  return 'altro';
}

const assetKey = (a: Attrs) => a.isin || (a.conid ? `conid:${a.conid}` : a.symbol ? `sym:${a.symbol}` : '');

/** Converte un estratto Flex Query (XML) nel formato comune di sincronizzazione. */
export function parseFlexStatement(xml: string, currency: string): SyncResult {
  const doc = parser.parse(xml);
  const statements: Record<string, unknown>[] = doc?.FlexQueryResponse?.FlexStatements?.FlexStatement ?? [];
  if (!statements.length) throw new ProviderError('Il report Flex non contiene alcun estratto conto.');

  const warnings: string[] = [];
  const assets = new Map<string, SyncAsset>();
  const transactions: SyncTx[] = [];
  const holdings: SyncHolding[] = [];
  let cash: number | undefined;
  const accountIds: string[] = [];

  if (statements.length > 1) {
    warnings.push('Il report contiene più conti IBKR: vengono uniti in un unico conto nell\'app.');
  }

  const touchAsset = (a: Attrs, price?: number) => {
    const key = assetKey(a);
    if (!key) return '';
    const existing = assets.get(key);
    const next: SyncAsset = existing ?? {
      key,
      symbol: a.symbol || a.isin || key,
      name: a.description || a.symbol || key,
      type: assetType(a),
      isin: a.isin || undefined,
    };
    if (price !== undefined && price > 0) next.price = price;
    assets.set(key, next);
    return key;
  };

  for (const st of statements) {
    const stAttrs = st as Attrs;
    if (stAttrs.accountId) accountIds.push(stAttrs.accountId);
    const info = (st.AccountInformation ?? {}) as Attrs;
    const base = info.currency;
    if (base && base !== currency) {
      warnings.push(
        `La valuta base del conto IBKR è ${base}, quella dell'app è ${currency}: gli importi sono in ${base}.`,
      );
    }

    // ---- Operazioni ----
    const allTrades: Attrs[] = ((st.Trades as Record<string, unknown>)?.Trade as Attrs[]) ?? [];
    const hasExec = allTrades.some((t) => t.levelOfDetail === 'EXECUTION');
    const trades = allTrades.filter((t) =>
      hasExec ? t.levelOfDetail === 'EXECUTION' : !t.levelOfDetail || t.levelOfDetail === 'ORDER',
    );
    for (const t of trades) {
      const cat = (t.assetCategory ?? '').toUpperCase();
      if (cat === 'CASH') continue; // conversioni valutarie: neutre in valuta base
      const qty = Math.abs(num(t.quantity));
      if (!qty) continue;
      const fx = num(t.fxRateToBase) || 1;
      const proceeds = Math.abs(num(t.proceeds));
      const unit = proceeds > 0 ? proceeds / qty : Math.abs(num(t.tradePrice)) * (num(t.multiplier) || 1);
      const commFx = t.ibCommissionCurrency && t.ibCommissionCurrency === base ? 1 : fx;
      const fees = Math.abs(num(t.ibCommission)) * commFx + Math.abs(num(t.taxes)) * fx;
      const key = touchAsset(t);
      const sell = (t.buySell ?? '').toUpperCase().startsWith('SELL') || num(t.quantity) < 0;
      const id = t.transactionID || t.tradeID || `${t.ibOrderID}-${t.dateTime}`;
      if (['OPT', 'FOP', 'FUT', 'WAR'].includes(cat)) {
        warnings.push(`Derivato ${t.symbol} importato come "Altro": verifica i valori.`);
      }
      transactions.push({
        externalId: `ibkr:trade:${id}`,
        date: flexDate(t.tradeDate || t.dateTime),
        type: sell ? 'vendita' : 'acquisto',
        assetKey: key,
        quantity: qty,
        price: unit * fx,
        fees: round2(fees),
      });
    }

    // ---- Movimenti di cassa ----
    const allCash: Attrs[] =
      ((st.CashTransactions as Record<string, unknown>)?.CashTransaction as Attrs[]) ?? [];
    const hasDetail = allCash.some((c) => c.levelOfDetail === 'DETAIL');
    const cashTx = allCash.filter((c) => (hasDetail ? c.levelOfDetail === 'DETAIL' : c.levelOfDetail !== 'SUMMARY'));
    const withholding: Attrs[] = [];
    for (const c of cashTx) {
      const kind = (c.type ?? '').toLowerCase();
      const amount = num(c.amount) * (num(c.fxRateToBase) || 1);
      const date = flexDate(c.dateTime || c.settleDate || c.reportDate);
      const id = c.transactionID || `${date}-${kind}-${c.amount}-${c.symbol ?? ''}`;
      const externalId = `ibkr:cash:${id}`;
      const note = c.description || undefined;
      if (!amount || !date) continue;

      if (kind.includes('withholding')) {
        withholding.push(c);
      } else if (kind.includes('dividend') || kind.includes('payment in lieu') || kind.includes('bond interest')) {
        const key = c.symbol || c.isin ? touchAsset(c) : undefined;
        transactions.push({ externalId, date, type: 'dividendo', assetKey: key, amount: round2(amount), fees: 0, note });
      } else if (kind.includes('deposit') || kind.includes('withdraw')) {
        transactions.push({
          externalId,
          date,
          type: amount > 0 ? 'deposito' : 'prelievo',
          amount: round2(Math.abs(amount)),
          fees: 0,
          note,
        });
      } else if (kind.includes('interest') && amount > 0) {
        transactions.push({ externalId, date, type: 'interessi', amount: round2(amount), fees: 0, note });
      } else {
        // Interessi passivi, commissioni, altri costi (importo negativo) o rimborsi (positivo).
        transactions.push({ externalId, date, type: 'commissione', amount: round2(-amount), fees: 0, note });
      }
    }
    // Le ritenute vengono sottratte al dividendo corrispondente (stesso titolo e data), se c'è.
    for (const w of withholding) {
      const amount = num(w.amount) * (num(w.fxRateToBase) || 1);
      const date = flexDate(w.dateTime || w.settleDate || w.reportDate);
      const key = assetKey(w);
      const div = transactions.find(
        (t) => t.type === 'dividendo' && t.assetKey === key && t.date === date,
      );
      if (div) div.fees = round2(div.fees - amount);
      else
        transactions.push({
          externalId: `ibkr:cash:${w.transactionID || `${date}-wht-${w.amount}-${w.symbol ?? ''}`}`,
          date,
          type: 'commissione',
          amount: round2(-amount),
          fees: 0,
          note: w.description || 'Ritenuta',
        });
    }

    // ---- Posizioni aperte (saldi reali e prezzi correnti) ----
    const positions: Attrs[] =
      ((st.OpenPositions as Record<string, unknown>)?.OpenPosition as Attrs[]) ?? [];
    for (const p of positions.filter((x) => !x.levelOfDetail || x.levelOfDetail === 'SUMMARY')) {
      const qty = num(p.position);
      if (qty <= 0) {
        if (qty < 0) warnings.push(`Posizione short su ${p.symbol} non supportata: ignorata.`);
        continue;
      }
      const fx = num(p.fxRateToBase) || 1;
      const value = Math.abs(num(p.positionValue));
      const price = (value > 0 ? value / qty : num(p.markPrice) * (num(p.multiplier) || 1)) * fx;
      const costMoney = Math.abs(num(p.costBasisMoney));
      const key = touchAsset(p, price);
      holdings.push({ assetKey: key, quantity: qty, costPrice: costMoney > 0 ? (costMoney / qty) * fx : undefined });
    }

    // ---- Liquidità ----
    const cashReport: Attrs[] =
      ((st.CashReport as Record<string, unknown>)?.CashReportCurrency as Attrs[]) ?? [];
    const summary = cashReport.find((c) => c.currency === 'BASE_SUMMARY');
    if (summary?.endingCash !== undefined) cash = (cash ?? 0) + num(summary.endingCash);
  }

  if (!transactions.length && !holdings.length) {
    warnings.push(
      'Il report non contiene operazioni né posizioni: controlla che la Flex Query includa Trades, Cash Transactions e Open Positions.',
    );
  }

  return {
    accountName: `Interactive Brokers${accountIds.length ? ` ${accountIds.join(', ')}` : ''}`,
    accountKind: 'broker',
    currency,
    assets: [...assets.values()],
    transactions: transactions.filter((t) => t.date),
    holdings,
    cash: cash === undefined ? undefined : round2(cash),
    warnings,
  };
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function flexGet(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA } });
  } catch (e) {
    throw new ProviderError(`Impossibile contattare Interactive Brokers: ${(e as Error).message}`);
  }
  if (!res.ok) throw new ProviderError(`Interactive Brokers ha risposto con errore ${res.status}.`);
  return res.text();
}

interface FlexStatus {
  Status?: string;
  ReferenceCode?: string;
  Url?: string;
  ErrorCode?: string;
  ErrorMessage?: string;
}

async function requestStatement(token: string, queryId: string) {
  const reqXml = await flexGet(`${BASE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  const status: FlexStatus = parser.parse(reqXml)?.FlexStatementResponse ?? {};
  if (status.Status !== 'Success' || !status.ReferenceCode) {
    throw new ProviderError(
      `Interactive Brokers: ${status.ErrorMessage ?? 'richiesta rifiutata'}${status.ErrorCode ? ` (codice ${status.ErrorCode})` : ''}. Controlla token e ID della Flex Query.`,
    );
  }
  return { url: status.Url || `${BASE}/GetStatement`, ref: status.ReferenceCode };
}

/** Richiede il report e attende che sia pronto (IBKR lo genera in modo asincrono). */
async function fetchStatement(token: string, queryId: string): Promise<string> {
  const { url, ref } = await requestStatement(token, queryId);
  for (let attempt = 0; attempt < 12; attempt++) {
    const xml = await flexGet(`${url}?t=${encodeURIComponent(token)}&q=${ref}&v=3`);
    if (xml.includes('<FlexQueryResponse')) return xml;
    const s: FlexStatus = parser.parse(xml)?.FlexStatementResponse ?? {};
    // 1019: report in generazione; 1018: troppe richieste. In entrambi i casi si riprova.
    if (s.ErrorCode === '1019' || s.ErrorCode === '1018' || s.Status === 'Warn') {
      await sleep(attempt < 3 ? 2000 : 5000);
      continue;
    }
    throw new ProviderError(`Interactive Brokers: ${s.ErrorMessage ?? 'report non disponibile'}.`);
  }
  throw new ProviderError('Interactive Brokers non ha generato il report in tempo: riprova tra qualche minuto.');
}

export const ibkr: Provider = {
  id: 'ibkr',
  label: 'Interactive Brokers',
  category: 'broker',
  description: 'Operazioni, dividendi, movimenti, posizioni e prezzi tramite il Flex Web Service ufficiale.',
  available: true,
  docsUrl: 'https://www.ibkrguides.com/orgportal/performanceandstatements/flex-web-service.htm',
  fields: [
    { key: 'token', label: 'Token Flex Web Service', secret: true, placeholder: 'es. 1234567890123456789012' },
    { key: 'queryId', label: 'ID della Flex Query', placeholder: 'es. 987654' },
  ],
  guide: [
    'Accedi al Portale Clienti IBKR → Performance e report → Flex Query.',
    'Crea una "Activity Flex Query" con le sezioni: Account Information, Trades (livello Execution), Cash Transactions, Open Positions (Summary) e Cash Report.',
    'Formato: XML. Periodo: "Last 365 Calendar Days". Formato data: yyyyMMdd. Salva e annota l\'ID della query.',
    'In "Flex Web Service Configuration" attiva il servizio e genera un token (scegli la durata massima).',
    'Incolla qui token e ID. Alla prima sincronizzazione le posizioni aperte da prima del periodo vengono importate con il prezzo di carico indicato da IBKR.',
  ],
  async test({ token, queryId }) {
    await requestStatement(token, queryId);
  },
  async sync({ token, queryId }, { currency }) {
    return parseFlexStatement(await fetchStatement(token, queryId), currency);
  },
};
