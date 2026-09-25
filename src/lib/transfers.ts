import {
  INFLOW_QTY,
  OUTFLOW_QTY,
  TRANSFER_TX,
  type AppData,
  type Asset,
  type Transaction,
  type TransferLink,
  type TxRef,
} from './types';
import { uid } from './id';

/**
 * Riconoscimento dei trasferimenti tra i propri conti.
 *
 * Ogni conto vede solo la sua metà del movimento: chi invia registra un'uscita (vendita, prelievo o trasferimento
 * in uscita), chi riceve un'entrata. Qui si cercano le coppie uscita/entrata che con buona probabilità sono lo
 * stesso trasferimento. Le decisioni dell'utente (`AppData.transferLinks`) hanno la precedenza: una coppia
 * confermata vale sempre, una scartata non viene più proposta.
 */

export type Confidence = 'alta' | 'media' | 'bassa';

export interface TransferPair {
  kind: 'titoli' | 'liquidita';
  out: Transaction;
  in: Transaction;
  /** Movimenti di liquidità "speculari" creati dagli import insieme alle due metà (se presenti). */
  outCash?: Transaction;
  inCash?: Transaction;
  /** Giorni tra uscita ed entrata (negativo se l'entrata risulta prima). */
  days: number;
  /** Quantità (titoli) o importo (liquidità) partito e non arrivato: tipicamente commissioni. */
  difference: number;
  confidence: Confidence;
  reasons: string[];
  /** Plus/minusvalenza che oggi l'app registra sulla "vendita" di chi invia. */
  recordedGain?: number;
  /**
   * Entrambe le metà hanno già l'etichetta "Trasferimento crypto interno": il calcolo sposta quantità e costo di
   * carico da un conto all'altro, senza vendite né versamenti.
   */
  labeled?: boolean;
  /** Decisione dell'utente su questa coppia, se c'è. */
  status?: TransferLink['status'];
  linkId?: string;
}

export interface TransferAnalysis {
  /** Coppie confermate e proposte (quelle scartate sono in `rejected`). */
  pairs: TransferPair[];
  rejected: TransferPair[];
  /** Movimenti che le fonti indicano come trasferimenti ma senza controparte tra i conti dell'app. */
  unmatched: Transaction[];
}

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY);

/** Parole con cui gli import descrivono un trasferimento di titoli o crypto. */
const TRANSFER_NOTE = /trasfer|transfer|ricevut|inviat|deposito crypto|prelievo crypto|wallet|delivery|receipt/i;
/** Parole tipiche dei bonifici tra conti. */
const CASH_NOTE = /bonific|giroconto|transfer|trasfer|sepa|ricarica/i;
/** Movimenti speculari automatici (import Fineco con "Bilancia la liquidità"): non sono trasferimenti. */
const AUTO_MIRROR = /\(automatico\)/i;

const isAdjustment = (t: Transaction) => !!t.externalId && /:adj:/.test(t.externalId);
const isCashAdjustment = (t: Transaction) => !!t.externalId && /:adjcash:/.test(t.externalId);

/** Chiave che identifica lo stesso strumento anche se registrato due volte (es. BTC su due exchange). */
function assetKey(a: Asset | undefined, id: string) {
  if (!a) return `id:${id}`;
  if (a.type === 'crypto') return `crypto:${a.symbol.trim().toUpperCase()}`;
  return a.isin ? `isin:${a.isin}` : `id:${a.id}`;
}

const confidence = (score: number, high: number, mid: number): Confidence =>
  score >= high ? 'alta' : score >= mid ? 'media' : 'bassa';

/** Abbinamento uno a uno: prima le coppie più probabili, poi le più vicine nel tempo. */
function assign(candidates: (TransferPair & { score: number })[]): TransferPair[] {
  candidates.sort((a, b) => b.score - a.score || Math.abs(a.days) - Math.abs(b.days) || a.difference - b.difference);
  const used = new Set<string>();
  const out: TransferPair[] = [];
  for (const { score: _score, ...c } of candidates) {
    if (used.has(c.out.id) || used.has(c.in.id)) continue;
    used.add(c.out.id);
    used.add(c.in.id);
    out.push(c);
  }
  return out.sort((a, b) => b.out.date.localeCompare(a.out.date));
}

const isTransfer = (t: Transaction) => TRANSFER_TX.includes(t.type);
/** Commissione di rete pagata in crypto dai wallet: esce dal conto, ma non è la metà di un trasferimento. */
const isNetworkFee = (t: Transaction) => !!t.externalId?.endsWith(':gas');

/** Riferimento stabile di una transazione (vedi TxRef). */
export const refOf = (t: Transaction): TxRef => ({ id: t.id, accountId: t.accountId, externalId: t.externalId });
const refKey = (r: TxRef) => `${r.accountId}|${r.externalId ? `x:${r.externalId}` : `id:${r.id}`}`;
const pairKey = (o: TxRef, i: TxRef) => `${refKey(o)}>${refKey(i)}`;

/** Nuova decisione su una coppia. */
export function decide(out: Transaction, into: Transaction, status: TransferLink['status']): TransferLink {
  return { id: uid(), out: refOf(out), in: refOf(into), status, decidedAt: new Date().toISOString() };
}

const isCashType = (t: Transaction) => t.type === 'deposito' || t.type === 'prelievo';

/**
 * @param options.labeledOnly considera solo i movimenti con l'etichetta "Trasferimento crypto interno"
 *   (è l'abbinamento usato dal calcolo del portafoglio per spostare il costo di carico).
 */
export function findTransfers(
  data: AppData,
  saleGains: Record<string, number> = {},
  options: { labeledOnly?: boolean } = {},
): TransferAnalysis {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const byExternal = new Map<string, Transaction>();
  for (const t of data.transactions) if (t.externalId) byExternal.set(`${t.accountId}|${t.externalId}`, t);
  const byId = new Map(data.transactions.map((t) => [t.id, t]));
  const resolve = (r: TxRef) => (r.externalId ? byExternal.get(`${r.accountId}|${r.externalId}`) : undefined) ?? byId.get(r.id);

  // Decisioni dell'utente: le coppie confermate sono fisse, quelle scartate non vengono riproposte.
  const links = data.transferLinks ?? [];
  const rejectedKeys = new Set(links.filter((l) => l.status === 'rifiutato').map((l) => pairKey(l.out, l.in)));
  const decided: { link: TransferLink; out: Transaction; in: Transaction }[] = [];
  for (const link of links) {
    const o = resolve(link.out);
    const i = resolve(link.in);
    if (o && i) decided.push({ link, out: o, in: i });
  }
  const confirmedIds = new Set(decided.filter((d) => d.link.status === 'confermato').flatMap((d) => [d.out.id, d.in.id]));
  const isRejected = (o: Transaction, i: Transaction) => rejectedKeys.has(pairKey(refOf(o), refOf(i)));

  /** Movimento di liquidità speculare di un'operazione (es. `okx:f:123` → `okx:f:123:cash`). */
  const mirrorOf = (t: Transaction) => {
    if (!t.externalId || isTransfer(t)) return undefined;
    const m = byExternal.get(`${t.accountId}|${t.externalId}:cash`);
    const expected = t.type === 'acquisto' ? 'deposito' : 'prelievo';
    return m && m.type === expected && !AUTO_MIRROR.test(m.note ?? '') ? m : undefined;
  };
  const mirrorIds = new Set<string>();
  for (const t of data.transactions) {
    if (!INFLOW_QTY.includes(t.type) && !OUTFLOW_QTY.includes(t.type)) continue;
    const m = mirrorOf(t);
    if (m) mirrorIds.add(m.id);
  }

  // ---------- Titoli e crypto ----------
  interface Leg {
    tx: Transaction;
    key: string;
    mirror?: Transaction;
    /** La fonte lo indica come trasferimento (etichetta, movimento speculare o descrizione). */
    hinted: boolean;
    /** Ha l'etichetta "Trasferimento crypto interno". */
    labeled: boolean;
    /** Rettifica automatica al saldo: data e prezzo sono stime. */
    estimated: boolean;
  }
  const legs = (types: Transaction['type'][]): Leg[] =>
    data.transactions
      .filter((t) => types.includes(t.type) && t.assetId && (t.quantity ?? 0) > 0 && !isNetworkFee(t))
      .filter((t) => !options.labeledOnly || isTransfer(t))
      .filter((t) => !confirmedIds.has(t.id))
      .map((tx) => {
        const mirror = mirrorOf(tx);
        const labeled = isTransfer(tx);
        return {
          tx,
          key: assetKey(assets.get(tx.assetId!), tx.assetId!),
          mirror,
          hinted: labeled || !!mirror || TRANSFER_NOTE.test(tx.note ?? ''),
          labeled,
          estimated: isAdjustment(tx),
        };
      });
  const outs = legs(OUTFLOW_QTY);
  const ins = legs(INFLOW_QTY);
  const insByKey = new Map<string, Leg[]>();
  for (const l of ins) insByKey.set(l.key, [...(insByKey.get(l.key) ?? []), l]);

  const securities: (TransferPair & { score: number })[] = [];
  for (const o of outs) {
    for (const i of insByKey.get(o.key) ?? []) {
      if (i.tx.accountId === o.tx.accountId || isRejected(o.tx, i.tx)) continue;
      // Almeno una delle due metà deve avere l'aspetto di un trasferimento: una vendita e un acquisto
      // qualsiasi dello stesso titolo su due conti sono, di norma, operazioni vere.
      if (!o.hinted && !i.hinted && !o.estimated && !i.estimated) continue;
      if (o.estimated && i.estimated) continue;
      const qOut = o.tx.quantity!;
      const qIn = i.tx.quantity!;
      const ratio = qIn / qOut;
      const days = daysBetween(o.tx.date, i.tx.date);
      const estimated = o.estimated || i.estimated;
      // Può arrivare meno di quanto partito (commissioni di rete), non di più.
      if (ratio > 1.001 || ratio < (estimated ? 0.98 : 0.8)) continue;
      if (!estimated && (days < -2 || days > 10)) continue;

      const reasons: string[] = [];
      let score = 0;
      const labeled = o.labeled && i.labeled;
      if (labeled) {
        // Con l'etichetta su entrambe le metà la coppia vince su abbinamenti con compravendite.
        score += 5;
        reasons.push('entrambe etichettate come trasferimento interno');
      } else if (o.hinted && i.hinted) {
        score += 4;
        reasons.push('entrambe indicate come trasferimento');
      } else {
        for (const [leg, side] of [
          [o, 'uscita'],
          [i, 'entrata'],
        ] as const) {
          if (leg.hinted) {
            score += 2;
            reasons.push(`${side} indicata come trasferimento`);
          } else if (leg.estimated) {
            score += 1;
            reasons.push(`${side} stimata (rettifica automatica al saldo)`);
          }
        }
      }
      if (ratio >= 0.99999) {
        score += 2;
        reasons.push('stessa quantità');
      } else if (ratio >= 0.98) {
        score += 1;
        reasons.push('quantità quasi uguale');
      } else reasons.push('arrivata una quantità minore');
      if (!estimated) {
        if (Math.abs(days) <= 1) {
          score += 2;
          reasons.push(days === 0 ? 'stesso giorno' : 'un giorno dopo');
        } else if (Math.abs(days) <= 4) {
          score += 1;
          reasons.push(`${Math.abs(days)} giorni dopo`);
        } else reasons.push(`${Math.abs(days)} giorni dopo`);
      }
      securities.push({
        kind: 'titoli',
        out: o.tx,
        in: i.tx,
        outCash: o.mirror,
        inCash: i.mirror,
        days,
        difference: Math.max(0, Math.round((qOut - qIn) * 1e8) / 1e8),
        confidence: confidence(score, 7, 5),
        reasons,
        recordedGain: o.tx.type === 'vendita' ? saleGains[o.tx.id] : undefined,
        labeled,
        score,
      });
    }
  }
  /** Coppia decisa dall'utente, descritta come le altre. */
  const describe = ({ link, out: o, in: i }: (typeof decided)[number]): TransferPair => {
    const cashPair = isCashType(o) && isCashType(i);
    const qOut = cashPair ? (o.amount ?? 0) : (o.quantity ?? 0);
    const qIn = cashPair ? (i.amount ?? 0) : (i.quantity ?? 0);
    return {
      kind: cashPair ? 'liquidita' : 'titoli',
      out: o,
      in: i,
      outCash: cashPair ? undefined : mirrorOf(o),
      inCash: cashPair ? undefined : mirrorOf(i),
      days: daysBetween(o.date, i.date),
      difference: Math.max(0, Math.round((qOut - qIn) * (cashPair ? 100 : 1e8)) / (cashPair ? 100 : 1e8)),
      confidence: 'alta',
      reasons: [link.status === 'confermato' ? 'confermato da te' : 'scartato da te'],
      recordedGain: o.type === 'vendita' ? saleGains[o.id] : undefined,
      labeled: isTransfer(o) && isTransfer(i),
      status: link.status,
      linkId: link.id,
    };
  };
  const confirmed = decided.filter((d) => d.link.status === 'confermato').map(describe);
  const rejected = decided.filter((d) => d.link.status === 'rifiutato').map(describe);

  const securityPairs = [...confirmed.filter((p) => p.kind === 'titoli'), ...assign(securities)];
  if (options.labeledOnly) {
    const pairs = securityPairs.filter((p) => p.labeled);
    const paired = new Set(pairs.flatMap((p) => [p.out.id, p.in.id]));
    return { pairs, rejected, unmatched: [...outs, ...ins].filter((l) => !paired.has(l.tx.id)).map((l) => l.tx) };
  }

  // ---------- Liquidità ----------
  const cashLeg = (t: Transaction, type: 'deposito' | 'prelievo') =>
    t.type === type &&
    (t.amount ?? 0) > 0 &&
    !mirrorIds.has(t.id) &&
    !isCashAdjustment(t) &&
    !AUTO_MIRROR.test(t.note ?? '') &&
    !confirmedIds.has(t.id);
  const cashOuts = data.transactions.filter((t) => cashLeg(t, 'prelievo'));
  const cashIns = data.transactions.filter((t) => cashLeg(t, 'deposito'));
  const cash: (TransferPair & { score: number })[] = [];
  for (const o of cashOuts) {
    for (const i of cashIns) {
      if (i.accountId === o.accountId || isRejected(o, i)) continue;
      const aOut = o.amount!;
      const aIn = i.amount!;
      const diff = Math.round((aOut - aIn) * 100) / 100;
      // Arriva lo stesso importo o poco meno (costo del bonifico).
      if (diff < -0.01 || diff > Math.max(2, aOut * 0.01)) continue;
      const days = daysBetween(o.date, i.date);
      if (days < -1 || days > 5) continue;
      const reasons: string[] = [];
      let score = 0;
      if (Math.abs(diff) < 0.005) {
        score += 3;
        reasons.push('stesso importo');
      } else {
        score += 1;
        reasons.push('importo quasi uguale');
      }
      if (Math.abs(days) <= 1) {
        score += 3;
        reasons.push(days === 0 ? 'stesso giorno' : 'un giorno dopo');
      } else {
        score += Math.abs(days) <= 3 ? 2 : 1;
        reasons.push(`${Math.abs(days)} giorni dopo`);
      }
      if (CASH_NOTE.test(`${o.note ?? ''} ${i.note ?? ''}`)) {
        score += 1;
        reasons.push('descritto come bonifico');
      }
      cash.push({ kind: 'liquidita', out: o, in: i, days, difference: Math.max(0, diff), confidence: confidence(score, 6, 4), reasons, score });
    }
  }
  const cashPairs = [...confirmed.filter((p) => p.kind === 'liquidita'), ...assign(cash)];

  // ---------- Metà senza controparte ----------
  const paired = new Set(securityPairs.flatMap((p) => [p.out.id, p.in.id]));
  const unmatched = [...outs, ...ins]
    .filter((l) => l.hinted && !paired.has(l.tx.id))
    .map((l) => l.tx)
    .sort((a, b) => b.date.localeCompare(a.date));

  return { pairs: [...securityPairs, ...cashPairs], rejected, unmatched };
}

/**
 * Coppie di trasferimenti con l'etichetta dedicata, per il calcolo: entrata → uscita da cui arriva il costo di
 * carico. Un'entrata senza uscita abbinata prende come costo il valore del giorno.
 */
export function transferLinks(data: AppData): Map<string, string> {
  return new Map(findTransfers(data, {}, { labeledOnly: true }).pairs.map((p) => [p.in.id, p.out.id]));
}

/**
 * Possibili altre metà di un movimento, per l'abbinamento a mano: movimenti di verso opposto dello stesso
 * strumento (o di liquidità) in altri conti, non già confermati, dal più vicino nel tempo.
 */
export function counterparts(data: AppData, tx: Transaction, limit = 30): Transaction[] {
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const confirmed = new Set<string>();
  const byExternal = new Map<string, Transaction>();
  for (const t of data.transactions) if (t.externalId) byExternal.set(`${t.accountId}|${t.externalId}`, t);
  const byId = new Map(data.transactions.map((t) => [t.id, t]));
  for (const l of data.transferLinks ?? []) {
    if (l.status !== 'confermato') continue;
    for (const r of [l.out, l.in]) {
      const t = (r.externalId ? byExternal.get(`${r.accountId}|${r.externalId}`) : undefined) ?? byId.get(r.id);
      if (t) confirmed.add(t.id);
    }
  }
  const out = OUTFLOW_QTY.includes(tx.type) || tx.type === 'prelievo';
  let wanted: Transaction['type'][];
  if (isCashType(tx)) wanted = [out ? 'deposito' : 'prelievo'];
  else wanted = out ? INFLOW_QTY : OUTFLOW_QTY;
  const key = tx.assetId ? assetKey(assets.get(tx.assetId), tx.assetId) : undefined;
  return data.transactions
    .filter(
      (t) =>
        t.accountId !== tx.accountId &&
        wanted.includes(t.type) &&
        !confirmed.has(t.id) &&
        !isNetworkFee(t) &&
        (isCashType(tx) || (t.assetId && assetKey(assets.get(t.assetId), t.assetId) === key)),
    )
    .map((t) => ({ t, gap: Math.abs(daysBetween(tx.date, t.date)) }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, limit)
    .map(({ t }) => t);
}
