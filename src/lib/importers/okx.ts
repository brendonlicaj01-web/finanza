import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellNumber, cellText, findHeader } from './util';

const TRADING = ['id', 'Order id', 'Time', 'Trade Type', 'Symbol', 'Action', 'Balance Change', 'Balance Unit'];
const FUNDING = ['id', 'Time', 'Type', 'Amount', 'Before Balance', 'After Balance', 'Symbol', 'Amount-EUR'];

/** Token "derivati" che rappresentano la stessa moneta (es. SOL in staking liquido). */
const ALIAS: Record<string, string> = { OKSOL: 'SOL' };
const coin = (s: string) => {
  const c = s.trim().toUpperCase();
  return ALIAS[c] ?? c;
};

/** Movimenti interni tra i conti OKX (Trading, Funding, Earn/staking): non cambiano quanto possiedi. */
const INTERNAL = /unified trading account|^stake$|redeem staking|simple earn (subscription|redemption)|staking swapping|^(un)?stake|subscription|redemption|transfer between/i;
/** Rendimenti e premi: proventi al valore del giorno. */
const INCOME = /yield|earning|interest|reward|airdrop|received|bonus|rebate|distribution|dividend/i;

type Row = unknown[];

function locate(sheets: Sheet[], cols: string[]) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, cols);
    if (header) return { sheet, header };
  }
  return undefined;
}

const day = (v: unknown) => cellText(v).slice(0, 10);
/** Confronta (orario, id): a parità di secondo vince l'id più alto (gli id OKX sono crescenti, a 19 cifre). */
const later = (a: { time: string; id: string }, b?: { time: string; id: string }) =>
  !b || a.time > b.time || (a.time === b.time && (a.id.length > b.id.length || (a.id.length === b.id.length && a.id > b.id)));
const round = (n: number, d = 8) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * OKX — due export CSV dello stesso account: "Trading" (conto unificato: operazioni spot) e "Funding"
 * (depositi, prelievi, rendimenti, staking). Importati insieme vanno nello stesso conto.
 */
export const okx: FileImporter = {
  id: 'okx',
  label: 'OKX',
  howTo: 'Esporta entrambi i file della cronologia: conto Trading e conto Funding (CSV), e trascinali insieme',
  needsCashBalance: false,
  multiFile: true,
  detect: (sheets) => !!(locate(sheets, TRADING) || locate(sheets, FUNDING)),
  parse(sheets): SyncResult {
    const currency = 'EUR';
    const trading = locate(sheets, TRADING);
    const funding = locate(sheets, FUNDING);
    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const remove: string[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();

    const touch = (symbol: string, date: string, price?: number) => {
      const key = `crypto:${symbol}`;
      if (!assets.has(key)) assets.set(key, { key, symbol, name: symbol, type: 'crypto', taxRate: 26 });
      if (price && price > 0) {
        const prev = lastPrice.get(key);
        if (!prev || prev.date <= date) lastPrice.set(key, { date, price });
      }
      return key;
    };

    // ---------- Trading: ordini spot ----------
    let tradingEur: { time: string; id: string; value: number } | undefined;
    if (trading) {
      const { sheet, header } = trading;
      const c = (n: string) => header.col(n);
      interface Leg {
        qty: number; // variazione di saldo (netta di commissioni)
        amount: number; // quantità lorda eseguita
        fee: number;
        feeEur: number;
      }
      interface Order {
        id: string;
        time: string;
        base: string;
        quote: string;
        legs: Map<string, Leg>;
        px: number; // somma quantità×prezzo (in valuta di quotazione)
        pxEur: number; // somma quantità×prezzo in EUR
        vol: number;
      }
      const orders = new Map<string, Order>();

      for (const row of sheet.rows.slice(header.index + 1) as Row[]) {
        const time = cellText(row[c('Time')]);
        const unit = coin(cellText(row[c('Balance Unit')]));
        const change = cellNumber(row[c('Balance Change')]) || 0;
        if (!time || !unit) continue;
        if (unit === 'EUR') {
          const bal = cellNumber(row[c('Balance')]);
          const cand = { time, id: cellText(row[c('id')]), value: bal };
          if (Number.isFinite(bal) && later(cand, tradingEur)) tradingEur = cand;
        }
        const kind = cellText(row[c('Trade Type')]).toLowerCase();
        if (kind === 'transfer') continue; // Trading ↔ Funding: interno
        if (kind !== 'spot') {
          warnings.push(`Operazione "${cellText(row[c('Trade Type')])}" del ${day(time)} non supportata (solo spot): ignorata.`);
          continue;
        }
        const [base, quote] = cellText(row[c('Symbol')]).split('-').map(coin);
        const orderId = cellText(row[c('Order id')]) || cellText(row[c('id')]);
        const key = `${orderId}:${base}-${quote}`;
        let o = orders.get(key);
        if (!o) {
          o = { id: orderId, time, base, quote, legs: new Map(), px: 0, pxEur: 0, vol: 0 };
          orders.set(key, o);
        }
        if (time < o.time) o.time = time;
        const leg = o.legs.get(unit) ?? { qty: 0, amount: 0, fee: 0, feeEur: 0 };
        leg.qty += change;
        leg.amount += Math.abs(cellNumber(row[c('Amount')]) || 0);
        const feeUnit = coin(cellText(row[c('Fee Unit')]));
        const fee = Math.abs(cellNumber(row[c('Fee')]) || 0);
        if (fee && feeUnit === unit) {
          leg.fee += fee;
          leg.feeEur += Math.abs(cellNumber(row[c('Fee-EUR')]) || 0);
        }
        o.legs.set(unit, leg);
        // Prezzo medio ponderato sulle righe della moneta base.
        if (unit === base) {
          const q = Math.abs(cellNumber(row[c('Amount')]) || 0);
          o.px += q * (cellNumber(row[c('Filled Price')]) || 0);
          o.pxEur += q * (cellNumber(row[c('Filled_price-EUR')]) || 0);
          o.vol += q;
        }
      }

      for (const o of orders.values()) {
        const b = o.legs.get(o.base);
        const q = o.legs.get(o.quote);
        if (!b || !o.vol) continue;
        const date = day(o.time);
        const price = o.px / o.vol; // in valuta di quotazione
        // Prezzo in EUR: esatto se la quotazione è in EUR, altrimenti la colonna EUR dell'export.
        const priceEur = o.quote === currency ? price : o.pxEur / o.vol;
        const quoteEur = price ? priceEur / price : 0;
        const buy = b.qty > 0;
        const feeValue = b.fee * priceEur + (q ? (o.quote === currency ? q.fee : q.fee * quoteEur) : 0);
        const base = o.base;
        const id = `okx:order:${o.id}:${base}`;
        if (base !== currency) {
          transactions.push({
            externalId: id,
            date,
            type: buy ? 'acquisto' : 'vendita',
            assetKey: touch(base, date, priceEur),
            quantity: round(Math.abs(b.qty)),
            price: priceEur,
            fees: Math.round(feeValue * 100) / 100,
          });
        }
        if (q && o.quote !== currency && Math.abs(q.qty) > 0) {
          transactions.push({
            externalId: `${id}:q`,
            date,
            type: q.qty > 0 ? 'acquisto' : 'vendita',
            assetKey: touch(o.quote, date, quoteEur),
            quantity: round(Math.abs(q.qty)),
            price: quoteEur,
            fees: 0,
            note: `Contropartita ${base}-${o.quote}`,
          });
        }
      }
    }

    // ---------- Funding: depositi, prelievi, rendimenti ----------
    let fundingEur: { time: string; id: string; value: number } | undefined;
    if (funding) {
      const { sheet, header } = funding;
      const c = (n: string) => header.col(n);
      const unknown = new Map<string, number>();

      for (const row of sheet.rows.slice(header.index + 1) as Row[]) {
        const time = cellText(row[c('Time')]);
        const symbol = coin(cellText(row[c('Symbol')]));
        const type = cellText(row[c('Type')]);
        const amount = cellNumber(row[c('Amount')]) || 0;
        const eur = Math.abs(cellNumber(row[c('Amount-EUR')]) || 0);
        if (!time || !symbol || !amount) continue;
        const date = day(time);
        const id = `okx:f:${cellText(row[c('id')])}`;
        if (symbol === currency) {
          const after = cellNumber(row[c('After Balance')]);
          const cand = { time, id: cellText(row[c('id')]), value: after };
          if (Number.isFinite(after) && later(cand, fundingEur)) fundingEur = cand;
        }
        if (INTERNAL.test(type)) continue;

        const qty = Math.abs(amount);
        const unit = qty ? eur / qty : 0;

        if (/^deposit$/i.test(type) || /^withdraw/i.test(type)) {
          const inflow = /^deposit$/i.test(type);
          if (symbol === currency) {
            transactions.push({ externalId: id, date, type: inflow ? 'deposito' : 'prelievo', amount: round(qty, 2), fees: 0, note: `OKX: ${type}` });
            continue;
          }
          // Crypto in entrata/uscita da altri conti o wallet: trasferimento interno, non compravendita.
          // Il valore del giorno serve solo se l'altra metà non è tra i conti dell'app.
          transactions.push({
            externalId: id,
            date,
            type: inflow ? 'trasf_entrata' : 'trasf_uscita',
            assetKey: touch(symbol, date, unit),
            quantity: round(qty),
            price: unit,
            fees: 0,
            note: inflow ? `Ricevute da altro conto o wallet (${symbol})` : `Inviate ad altro conto o wallet (${symbol})`,
            rev: 1,
          });
          // Versioni precedenti: acquisto/vendita con deposito/prelievo speculare.
          remove.push(`${id}:cash`);
          continue;
        }

        if (INCOME.test(type) && amount > 0) {
          // Provento in natura: reddito al valore del giorno + moneta che entra in portafoglio a quel prezzo.
          const key = touch(symbol, date, unit);
          transactions.push({ externalId: id, date, type: 'dividendo', assetKey: key, amount: round(eur, 8), fees: 0, note: `OKX: ${type}` });
          transactions.push({
            externalId: `${id}:buy`,
            date,
            type: 'acquisto',
            assetKey: key,
            quantity: round(qty),
            price: unit,
            fees: 0,
            note: `Reinvestito: ${type}`,
          });
          continue;
        }

        unknown.set(type, (unknown.get(type) ?? 0) + 1);
      }
      for (const [t, n] of unknown) warnings.push(`${n} movimenti "${t}" del conto Funding non riconosciuti: ignorati.`);
    }

    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }

    if (trading && !funding) {
      warnings.push('Manca il file Funding: depositi e rendimenti non sono inclusi, la liquidità potrebbe risultare negativa.');
    }
    if (funding && !trading) {
      warnings.push('Manca il file Trading: le compravendite non sono incluse.');
    }
    warnings.push('OKX non riporta i prezzi correnti: le crypto sono valorizzate all\'ultimo prezzo presente nei file. Aggiornali in Strumenti.');

    return {
      accountName: 'OKX',
      accountKind: 'wallet',
      currency,
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      // La liquidità si allinea solo se ci sono entrambi i file (altrimenti il saldo sarebbe parziale).
      cash: trading && funding ? Math.round(((tradingEur?.value ?? 0) + (fundingEur?.value ?? 0)) * 100) / 100 : undefined,
      remove,
      warnings,
    };
  },
};
