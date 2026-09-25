import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellDate, cellNumber, cellText, findHeader } from './util';

/**
 * Trezor Suite — export CSV di un account (Transazioni → ⋯ → Esporta → CSV). Un file per account (Bitcoin #1,
 * Ethereum #1, …): trascinati insieme finiscono nello stesso conto "Trezor".
 *
 * Colonne: Timestamp, Date, Time, Type (RECV/SENT/SELF/FAILED…), Transaction ID, Fee, Fee unit, Address, Label,
 * Amount, Amount unit, Fiat (valore in valuta al momento), Other.
 * Ogni entrata o uscita è un "Trasferimento crypto interno"; se nella stessa transazione esce una moneta ed entra
 * un'altra, è uno scambio (vendita + acquisto).
 */

const REQUIRED = ['Timestamp', 'Type', 'Transaction ID', 'Fee', 'Fee unit', 'Address', 'Amount', 'Amount unit'];
/** Monete delle reti (pagano le commissioni): i token con valore zero sono pubblicità, le monete delle reti no. */
const NATIVE = new Set(['BTC', 'LTC', 'DOGE', 'BCH', 'ETH', 'ETC', 'BNB', 'POL', 'MATIC', 'SOL', 'ADA', 'XRP', 'DASH', 'ZEC', 'DGB', 'VTC', 'NMC', 'TEST', 'REGTEST']);

interface Row {
  /** Istante (ms): ordina le operazioni dello stesso giorno (il file va dal più recente al più vecchio). */
  time: number;
  date: string;
  type: string;
  txid: string;
  fee: number;
  feeUnit: string;
  address: string;
  amount: number;
  unit: string;
  fiat: number;
}

const r8 = (n: number) => Math.round(n * 1e8) / 1e8;

function locate(sheets: Sheet[]) {
  const found: { sheet: Sheet; header: NonNullable<ReturnType<typeof findHeader>> }[] = [];
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, REQUIRED);
    if (header) found.push({ sheet, header });
  }
  return found;
}

function readRows(sheet: Sheet, header: NonNullable<ReturnType<typeof findHeader>>): { rows: Row[]; nft: number } {
  const headerRow = sheet.rows[header.index].map((c) => cellText(c));
  // La colonna del controvalore si chiama "Fiat (EUR)", "Fiat (USD)"…
  const fiatCol = headerRow.findIndex((h) => /^fiat/i.test(h));
  const c = (n: string) => header.col(n);
  const rows: Row[] = [];
  let nft = 0;
  for (const raw of sheet.rows.slice(header.index + 1)) {
    const txid = cellText(raw[c('Transaction ID')]);
    if (!txid) continue;
    const amountText = cellText(raw[c('Amount')]);
    const amount = cellNumber(amountText);
    // Gli NFT compaiono come "ID 123": non sono monete.
    if (!Number.isFinite(amount)) {
      if (/^id\s/i.test(amountText)) nft++;
      continue;
    }
    const ts = Number(cellText(raw[c('Timestamp')]));
    const date = cellDate(raw[c('Date')]) || (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '');
    rows.push({
      time: ts * 1000,
      date,
      type: cellText(raw[c('Type')]).toUpperCase(),
      txid,
      fee: Math.abs(cellNumber(raw[c('Fee')])) || 0,
      feeUnit: cellText(raw[c('Fee unit')]).toUpperCase(),
      address: cellText(raw[c('Address')]),
      amount: Math.abs(amount),
      unit: cellText(raw[c('Amount unit')]).toUpperCase(),
      fiat: fiatCol >= 0 ? Math.abs(cellNumber(raw[fiatCol])) || 0 : 0,
    });
  }
  return { rows, nft };
}

export const trezor: FileImporter = {
  id: 'trezor',
  label: 'Trezor',
  howTo:
    'Trezor Suite: scegli un account (es. Bitcoin #1) → Transazioni → ⋯ accanto alla ricerca → Esporta → CSV. Un file per account: trascinali tutti insieme',
  needsCashBalance: false,
  multiFile: true,
  detect: (sheets) => locate(sheets).length > 0,
  parse(sheets): SyncResult {
    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    let nft = 0;
    const spam = new Set<string>();
    const unknownTypes = new Map<string, number>();
    const all: Row[] = [];
    // Righe identiche (stesso file trascinato due volte) contano una volta sola.
    const seen = new Set<string>();
    for (const { sheet, header } of locate(sheets)) {
      const r = readRows(sheet, header);
      for (const row of r.rows) {
        const k = [row.txid, row.type, row.address, row.amount, row.unit, row.fee].join('|');
        if (seen.has(k)) continue;
        seen.add(k);
        all.push(row);
      }
      nft += r.nft;
    }
    const natives = new Set([...NATIVE, ...all.map((r) => r.feeUnit).filter(Boolean)]);

    // Prezzo in euro per moneta e giorno, dai controvalori del file (serve anche per le commissioni).
    const dayPrice = new Map<string, Map<string, number>>();
    for (const r of all) {
      if (!r.fiat || !r.amount) continue;
      const m = dayPrice.get(r.unit) ?? new Map<string, number>();
      m.set(r.date, r.fiat / r.amount);
      dayPrice.set(r.unit, m);
    }
    const priceOf = (unit: string, date: string) => {
      const m = dayPrice.get(unit);
      if (!m) return 0;
      if (m.has(date)) return m.get(date)!;
      const days = [...m.keys()].sort();
      const before = days.filter((d) => d <= date).pop() ?? days[0];
      return m.get(before) ?? 0;
    };
    const touch = (unit: string, date: string, price: number) => {
      const key = `crypto:${unit}`;
      if (!assets.has(key)) assets.set(key, { key, symbol: unit, name: unit, type: 'crypto', taxRate: 26 });
      if (price > 0) {
        const prev = lastPrice.get(key);
        if (!prev || prev.date <= date) lastPrice.set(key, { date, price });
      }
      return key;
    };

    const byTx = new Map<string, Row[]>();
    for (const r of [...all].sort((a, b) => a.time - b.time)) byTx.set(r.txid, [...(byTx.get(r.txid) ?? []), r]);

    for (const [txid, rows] of byTx) {
      const { date } = rows[0];
      if (!date) continue;
      const evm = rows.some((r) => /^0x[0-9a-f]{40}$/i.test(r.address));
      const fee = Math.max(0, ...rows.map((r) => r.fee));
      const feeUnit = rows.find((r) => r.fee > 0)?.feeUnit ?? '';

      // Quantità per moneta e direzione. Su Ethereum & co. la stessa uscita può comparire su più righe
      // (una per indirizzo coinvolto): conta una volta. Su Bitcoin più righe sono più destinatari: si sommano.
      const legs = new Map<string, { amount: number; fiat: number }>();
      for (const r of rows) {
        let dir: 1 | -1 | 0;
        if (r.type === 'RECV') dir = 1;
        else if (r.type === 'SENT') dir = -1;
        else if (r.type === 'SELF' || r.type === 'FAILED') dir = 0;
        else {
          unknownTypes.set(r.type, (unknownTypes.get(r.type) ?? 0) + 1);
          continue;
        }
        if (!dir || !r.amount || !r.unit) continue;
        // Token ricevuti senza alcun valore: pubblicità o truffe (es. finti DAI regalati).
        if (!natives.has(r.unit) && !r.fiat && !dayPrice.has(r.unit)) {
          spam.add(r.unit);
          continue;
        }
        const k = `${dir}:${r.unit}`;
        const leg = legs.get(k) ?? { amount: 0, fiat: 0 };
        if (evm) {
          leg.amount = Math.max(leg.amount, r.amount);
          leg.fiat = Math.max(leg.fiat, r.fiat);
        } else {
          leg.amount += r.amount;
          leg.fiat += r.fiat;
        }
        legs.set(k, leg);
      }

      const outs = [...legs].filter(([k]) => k.startsWith('-1:')).map(([k, v]) => ({ unit: k.slice(3), ...v }));
      const ins = [...legs].filter(([k]) => k.startsWith('1:')).map(([k, v]) => ({ unit: k.slice(2), ...v }));
      // Stessa moneta sia in entrata sia in uscita (es. resto): conta il netto.
      for (const i of [...ins]) {
        const o = outs.find((x) => x.unit === i.unit);
        if (!o) continue;
        const net = i.amount - o.amount;
        outs.splice(outs.indexOf(o), 1);
        ins.splice(ins.indexOf(i), 1);
        if (net > 1e-12) ins.push({ unit: i.unit, amount: net, fiat: i.fiat - o.fiat });
        else if (net < -1e-12) outs.push({ unit: i.unit, amount: -net, fiat: o.fiat - i.fiat });
      }
      const unitPrice = (l: { unit: string; amount: number; fiat: number }) => (l.fiat && l.amount ? l.fiat / l.amount : priceOf(l.unit, date));
      const base = `trezor:${txid}`;
      let feeInside = false;

      if (outs.length && ins.length) {
        // Scambio nella stessa transazione: vendita di ciò che esce, acquisto di ciò che entra.
        const outValue = outs.reduce((s, l) => s + unitPrice(l) * l.amount, 0);
        for (const l of outs) {
          const price = unitPrice(l);
          transactions.push({ externalId: `${base}:${l.unit}`, date, type: 'vendita', assetKey: touch(l.unit, date, price), quantity: r8(l.amount), price, fees: 0, note: 'Scambio (Trezor)', rev: 1 });
        }
        for (const l of ins) {
          const price = ins.length === 1 && outValue ? outValue / l.amount : unitPrice(l);
          transactions.push({ externalId: `${base}:${l.unit}`, date, type: 'acquisto', assetKey: touch(l.unit, date, unitPrice(l)), quantity: r8(l.amount), price, fees: 0, note: 'Scambio (Trezor)', rev: 1 });
        }
      } else {
        for (const l of [...outs, ...ins]) {
          const out = outs.includes(l);
          const withFee = out && l.unit === feeUnit && fee > 0;
          if (withFee) feeInside = true;
          const price = unitPrice(l);
          transactions.push({
            externalId: `${base}:${l.unit}`,
            date,
            type: out ? 'trasf_uscita' : 'trasf_entrata',
            assetKey: touch(l.unit, date, price),
            quantity: r8(l.amount + (withFee ? fee : 0)),
            price,
            fees: 0,
            note: out ? 'Inviate da Trezor' : 'Ricevute su Trezor',
            rev: 1,
          });
        }
      }
      // Commissione non compresa in un invio della stessa moneta (token, scambi, operazioni fallite): a parte.
      if (fee > 0 && feeUnit && !feeInside) {
        const price = priceOf(feeUnit, date);
        transactions.push({
          externalId: `${base}:gas`,
          date,
          type: 'trasf_uscita',
          assetKey: touch(feeUnit, date, price),
          quantity: r8(fee),
          price,
          fees: 0,
          note: 'Commissione di rete (Trezor)',
          rev: 1,
        });
      }
    }

    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }
    if (spam.size) warnings.push(`${spam.size} token senza valore ignorati (pubblicità o truffe): ${[...spam].join(', ')}.`);
    if (nft) warnings.push(`${nft} NFT ignorati.`);
    for (const [t, n] of unknownTypes) warnings.push(`${n} righe di tipo "${t}" non riconosciute: ignorate.`);
    warnings.push('Il file non contiene i prezzi di oggi: le crypto sono valorizzate all\'ultimo prezzo presente. Aggiornali in Strumenti.');

    return {
      accountName: 'Trezor',
      accountKind: 'wallet',
      currency: 'EUR',
      assets: [...assets.values()],
      // Già in ordine di tempo; l'ordinamento per data è stabile e lo conserva nello stesso giorno.
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      warnings,
    };
  },
};
