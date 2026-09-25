import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellNumber, cellText, findHeader } from './util';

/**
 * Exodus — export CSV della cronologia (Cronologia → portafoglio, "Tutti gli asset" → Esporta → CSV; il file finisce
 * in Scrivania/exodus-exports). Una riga per movimento: deposit, withdrawal, exchange, staked, unstaked…
 *
 * Il file non contiene i controvalori: i prezzi del giorno si aggiungono dopo la lettura (needsPrices).
 * - deposit/withdrawal: "Trasferimento crypto interno" in entrata/uscita (la commissione esce con l'invio);
 * - stessa transazione con un'uscita e un'entrata di monete diverse, o `exchange`: scambio (vendita + acquisto);
 * - uscite a importo zero (autorizzazioni ai contratti), staked/unstaked: solo commissione di rete;
 * - rientro dallo staking (deposit dal proprio portafoglio): movimento interno; i premi sono ricavati dalle uscite
 *   successive che altrimenti supererebbero il saldo;
 * - arrivi "polvere" (≤ 0,000001), tipici dei tentativi di avvelenare la cronologia: ignorati.
 */

const REQUIRED = ['DATE', 'TYPE', 'OUTAMOUNT', 'OUTCURRENCY', 'FEEAMOUNT', 'FEECURRENCY', 'OUTTXID', 'INAMOUNT', 'INCURRENCY', 'INTXID'];
const DUST = 0.000001;
const EPS = 1e-9;
const r9 = (n: number) => Math.round(n * 1e9) / 1e9;

/** Ticker con suffisso di rete (es. BNBBSC = BNB su BNB Chain) → moneta. */
export function exodusSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  const m = s.match(/^(BNB|ETH|USDT|USDC|DAI|MATIC|POL|AVAX|WETH|WBTC)(BSC|BEP20|ETH|ERC20|TRX|TRC20|SOL|SPL|ARB|ARBITRUM|BASE|OP|OPTIMISM|MATIC|POLYGON|AVAXC|FTM)$/);
  return m && m[1] !== m[2] ? m[1] : s;
}

interface Row {
  time: number;
  date: string;
  type: string;
  fromPortfolio: string;
  outAmount: number;
  outCur: string;
  fee: number;
  feeCur: string;
  outTx: string;
  inAmount: number;
  inCur: string;
  inTx: string;
  orderId: string;
}

/** Data locale (quella che vede l'utente), non UTC. */
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, REQUIRED);
    if (header) return { sheet, header };
  }
  return undefined;
}

export const exodus: FileImporter = {
  id: 'exodus',
  label: 'Exodus',
  howTo:
    'Exodus desktop: Cronologia (History) → scegli il portafoglio, lascia "Tutti gli asset" e tutti i tipi → Esporta → CSV (lo trovi in Scrivania, cartella exodus-exports)',
  needsCashBalance: false,
  needsPrices: true,
  detect: (sheets) => !!locate(sheets),
  parse(sheets): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Formato Exodus non riconosciuto.');
    const { sheet, header } = found;
    const c = (n: string) => header.col(n);
    const warnings: string[] = [];
    const assets = new Map<string, SyncAsset>();
    const touch = (sym: string) => {
      const key = `crypto:${sym}`;
      if (!assets.has(key)) assets.set(key, { key, symbol: sym, name: sym, type: 'crypto', taxRate: 26 });
      return key;
    };

    const rows: Row[] = [];
    for (const raw of sheet.rows.slice(header.index + 1)) {
      const iso = cellText(raw[c('DATE')]);
      const time = Date.parse(iso);
      if (!Number.isFinite(time)) continue;
      rows.push({
        time,
        date: localDate(time),
        type: cellText(raw[c('TYPE')]).toLowerCase(),
        fromPortfolio: c('FROMPORTFOLIO') >= 0 ? cellText(raw[c('FROMPORTFOLIO')]) : '',
        outAmount: Math.abs(cellNumber(raw[c('OUTAMOUNT')])) || 0,
        outCur: exodusSymbol(cellText(raw[c('OUTCURRENCY')])),
        fee: Math.abs(cellNumber(raw[c('FEEAMOUNT')])) || 0,
        feeCur: exodusSymbol(cellText(raw[c('FEECURRENCY')])),
        outTx: cellText(raw[c('OUTTXID')]),
        inAmount: Math.abs(cellNumber(raw[c('INAMOUNT')])) || 0,
        inCur: exodusSymbol(cellText(raw[c('INCURRENCY')])),
        inTx: cellText(raw[c('INTXID')]),
        orderId: c('ORDERID') >= 0 ? cellText(raw[c('ORDERID')]) : '',
      });
    }
    rows.sort((a, b) => a.time - b.time);

    // Operazioni raggruppate: stessa transazione (o stesso ordine di scambio).
    interface Op {
      key: string;
      time: number;
      date: string;
      outs: Map<string, number>;
      ins: Map<string, number>;
      fees: Map<string, number>;
      /** Rientro dallo staking o da un altro conto dello stesso portafoglio: non è un'entrata. */
      internalIn: Map<string, number>;
      exchange: boolean;
    }
    const ops = new Map<string, Op>();
    const add = (m: Map<string, number>, k: string, v: number) => v && k && m.set(k, (m.get(k) ?? 0) + v);
    let dust = 0;
    const unknown = new Map<string, number>();
    for (const r of rows) {
      const key = r.orderId || r.outTx || r.inTx || `${r.time}:${r.type}`;
      let op = ops.get(key);
      if (!op) {
        op = { key, time: r.time, date: r.date, outs: new Map(), ins: new Map(), fees: new Map(), internalIn: new Map(), exchange: false };
        ops.set(key, op);
      }
      switch (r.type) {
        case 'deposit':
          if (r.fromPortfolio) {
            // Dal proprio portafoglio (es. conto di staking): la commissione è nostra, l'importo non è un'entrata.
            add(op.internalIn, r.inCur, r.inAmount);
            add(op.fees, r.feeCur, r.fee);
          } else if (r.inAmount <= DUST) {
            dust++;
          } else add(op.ins, r.inCur, r.inAmount);
          break;
        case 'withdrawal':
          add(op.outs, r.outCur, r.outAmount);
          add(op.fees, r.feeCur, r.fee);
          break;
        case 'exchange':
          op.exchange = true;
          add(op.outs, r.outCur, r.outAmount);
          add(op.ins, r.inCur, r.inAmount);
          add(op.fees, r.feeCur, r.fee);
          break;
        case 'staked':
        case 'unstaked':
        case 'fee':
          add(op.fees, r.feeCur, r.fee);
          break;
        default:
          unknown.set(r.type, (unknown.get(r.type) ?? 0) + 1);
      }
    }

    const transactions: (SyncTx & { time: number })[] = [];
    const internalReturns: { time: number; date: string; symbol: string; amount: number; key: string }[] = [];
    let swaps = 0;
    for (const op of [...ops.values()].sort((a, b) => a.time - b.time)) {
      const base = `exodus:${op.key}`;
      const { date, time } = op;
      // Stessa moneta in entrata e in uscita nella stessa operazione: conta il netto.
      for (const [sym, qIn] of [...op.ins]) {
        const qOut = op.outs.get(sym);
        if (qOut === undefined) continue;
        op.ins.delete(sym);
        op.outs.delete(sym);
        if (qIn - qOut > EPS) op.ins.set(sym, qIn - qOut);
        else if (qOut - qIn > EPS) op.outs.set(sym, qOut - qIn);
      }
      const swap = op.outs.size > 0 && op.ins.size > 0;
      const feeInside = new Set<string>();
      if (swap) {
        swaps++;
        for (const [sym, q] of op.outs) transactions.push({ time, externalId: `${base}:${sym}`, date, type: 'vendita', assetKey: touch(sym), quantity: r9(q), fees: 0, note: 'Scambio (Exodus)', pair: base, rev: 1 });
        for (const [sym, q] of op.ins) transactions.push({ time, externalId: `${base}:${sym}`, date, type: 'acquisto', assetKey: touch(sym), quantity: r9(q), fees: 0, note: 'Scambio (Exodus)', pair: base, rev: 1 });
      } else {
        for (const [sym, q] of op.outs) {
          const fee = op.fees.get(sym) ?? 0;
          if (fee) feeInside.add(sym);
          transactions.push({ time, externalId: `${base}:${sym}`, date, type: 'trasf_uscita', assetKey: touch(sym), quantity: r9(q + fee), fees: 0, note: 'Inviate da Exodus', rev: 1 });
        }
        for (const [sym, q] of op.ins) {
          transactions.push({ time, externalId: `${base}:${sym}`, date, type: 'trasf_entrata', assetKey: touch(sym), quantity: r9(q), fees: 0, note: 'Ricevute su Exodus', rev: 1 });
        }
      }
      for (const [sym, fee] of op.fees) {
        if (feeInside.has(sym) || !fee) continue;
        transactions.push({ time, externalId: `${base}:gas`, date, type: 'trasf_uscita', assetKey: touch(sym), quantity: r9(fee), fees: 0, note: 'Commissione di rete (Exodus)', rev: 1 });
      }
      for (const [sym, q] of op.internalIn) internalReturns.push({ time, date, symbol: sym, amount: q, key: base });
    }

    // Premi di staking: il file non dice quanto era in staking. Le monete restano nel saldo mentre sono in staking;
    // se un'uscita successiva a un rientro supera il saldo, la differenza (fino all'importo rientrato) sono premi.
    const balance = new Map<string, number>();
    const shortfall = new Map<string, { qty: number; date: string }>();
    const rewards = new Map<string, number>(); // chiave del rientro → premi
    const lastReturn = new Map<string, (typeof internalReturns)[number]>();
    const events = [
      ...transactions.map((t) => ({ time: t.time, t })),
      ...internalReturns.map((r) => ({ time: r.time, r })),
    ].sort((a, b) => a.time - b.time);
    for (const e of events) {
      if ('r' in e && e.r) {
        lastReturn.set(e.r.symbol, e.r);
        continue;
      }
      const t = (e as { t: SyncTx }).t;
      const sym = t.assetKey!.slice(7);
      const q = t.quantity ?? 0;
      const inflow = t.type === 'trasf_entrata' || t.type === 'acquisto';
      let bal = (balance.get(sym) ?? 0) + (inflow ? q : -q);
      if (bal < -EPS) {
        const ret = lastReturn.get(sym);
        const already = ret ? (rewards.get(ret.key) ?? 0) : 0;
        const room = ret ? ret.amount - already : 0;
        const take = Math.min(-bal, Math.max(0, room));
        if (ret && take > EPS) {
          rewards.set(ret.key, already + take);
          bal += take;
        }
        if (bal < -EPS) {
          const s = shortfall.get(sym) ?? { qty: 0, date: t.date };
          shortfall.set(sym, { qty: s.qty - bal, date: s.date });
          bal = 0;
        }
      }
      balance.set(sym, bal);
    }
    for (const ret of internalReturns) {
      const q = rewards.get(ret.key);
      if (!q) continue;
      const key = touch(ret.symbol);
      // Premi: provento al valore del giorno + monete che entrano a quel valore (come per OKX).
      transactions.push({ time: ret.time, externalId: `${ret.key}:reward`, date: ret.date, type: 'dividendo', assetKey: key, quantity: r9(q), fees: 0, note: `Premi di staking ${ret.symbol} (stimati)`, rev: 1 });
      transactions.push({ time: ret.time, externalId: `${ret.key}:reward:buy`, date: ret.date, type: 'acquisto', assetKey: key, quantity: r9(q), fees: 0, note: `Premi di staking ${ret.symbol} reinvestiti`, rev: 1 });
      warnings.push(`Premi di staking ${ret.symbol} stimati in ${r9(q)} (il file non indica quanto era in staking).`);
    }

    if (swaps) warnings.push(`${swaps} scambi registrati come vendita + acquisto.`);
    if (dust) warnings.push(`${dust} arrivi "polvere" (importi minimi da indirizzi sconosciuti, tipici delle truffe) ignorati.`);
    for (const [sym, s] of shortfall) {
      warnings.push(`${sym}: nel file mancano entrate per ${r9(s.qty)} ${sym} prima del ${s.date.split('-').reverse().join('/')} (storico incompleto): la quantità risulterà più bassa del reale.`);
    }
    for (const [t, n] of unknown) warnings.push(`${n} righe di tipo "${t}" non riconosciute: ignorate.`);

    return {
      accountName: 'Exodus',
      accountKind: 'wallet',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.time - b.time).map(({ time: _t, ...t }) => t),
      warnings,
    };
  },
};
