import { INFLOW_QTY, OUTFLOW_QTY, TRANSFER_TX, type AppData, type Asset, type Transaction } from './types';

/**
 * Riconoscimento dei trasferimenti tra i propri conti (sola lettura).
 *
 * Oggi ogni conto vede solo la sua metà del movimento: chi invia registra una vendita (o un prelievo), chi riceve
 * un acquisto (o un deposito). Qui si cercano le coppie uscita/entrata che con buona probabilità sono lo stesso
 * trasferimento, senza modificare nulla.
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
}

export interface TransferAnalysis {
  pairs: TransferPair[];
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
      .filter((t) => types.includes(t.type) && t.assetId && (t.quantity ?? 0) > 0)
      .filter((t) => !options.labeledOnly || isTransfer(t))
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
      if (i.tx.accountId === o.tx.accountId) continue;
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
  const securityPairs = assign(securities);
  if (options.labeledOnly) {
    const paired = new Set(securityPairs.flatMap((p) => [p.out.id, p.in.id]));
    return { pairs: securityPairs, unmatched: [...outs, ...ins].filter((l) => !paired.has(l.tx.id)).map((l) => l.tx) };
  }

  // ---------- Liquidità ----------
  const cashLeg = (t: Transaction, type: 'deposito' | 'prelievo') =>
    t.type === type && (t.amount ?? 0) > 0 && !mirrorIds.has(t.id) && !isCashAdjustment(t) && !AUTO_MIRROR.test(t.note ?? '');
  const cashOuts = data.transactions.filter((t) => cashLeg(t, 'prelievo'));
  const cashIns = data.transactions.filter((t) => cashLeg(t, 'deposito'));
  const cash: (TransferPair & { score: number })[] = [];
  for (const o of cashOuts) {
    for (const i of cashIns) {
      if (i.accountId === o.accountId) continue;
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
  const cashPairs = assign(cash);

  // ---------- Metà senza controparte ----------
  const paired = new Set(securityPairs.flatMap((p) => [p.out.id, p.in.id]));
  const unmatched = [...outs, ...ins]
    .filter((l) => l.hinted && !paired.has(l.tx.id))
    .map((l) => l.tx)
    .sort((a, b) => b.date.localeCompare(a.date));

  return { pairs: [...securityPairs, ...cashPairs], unmatched };
}

/**
 * Coppie di trasferimenti con l'etichetta dedicata, per il calcolo: entrata → uscita da cui arriva il costo di
 * carico. Un'entrata senza uscita abbinata prende come costo il valore del giorno.
 */
export function transferLinks(data: AppData): Map<string, string> {
  return new Map(findTransfers(data, {}, { labeledOnly: true }).pairs.map((p) => [p.in.id, p.out.id]));
}
