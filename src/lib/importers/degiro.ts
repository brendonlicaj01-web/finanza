import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellDate, cellNumber, cellText, classify, findHeader, idMaker } from './util';

/** Intestazioni dell'estratto conto DEGIRO in italiano e in inglese. */
const HEADERS = [
  ['Data', 'Ora', 'Prodotto', 'ISIN', 'Descrizione', 'Saldo', 'ID Ordine'],
  ['Date', 'Time', 'Product', 'ISIN', 'Description', 'Balance', 'Order Id'],
];

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    for (const cols of HEADERS) {
      const header = findHeader(sheet.rows, cols);
      if (header) return { sheet, header, it: cols[0] === 'Data' };
    }
  }
  return undefined;
}

/** "Acquisto 6 StSt SPDR Russell 2000 US Small Cap UCITS ETF Acc@48,88 EUR (IE00BJ38QD84)" */
const TRADE =
  /^(Acquisto|Vendita|Buy|Sell)\s+([\d.,]+)\s+(.+?)@([\d.,]+)\s+([A-Z]{3})(?:\s+\(([A-Z]{2}[A-Z0-9]{9}\d)\))?/i;

type Kind =
  | 'trade'
  | 'fee'
  | 'ftt'
  | 'fx'
  | 'sweep'
  | 'deposit'
  | 'withdrawal'
  | 'withdrawal-noise'
  | 'dividend'
  | 'dividend-tax'
  | 'interest'
  | 'cost'
  | 'bonus'
  | 'ignore';

/** Classifica una riga dalla descrizione (italiano e inglese). */
export function degiroKind(desc: string): Kind {
  const d = desc.toLowerCase();
  if (TRADE.test(desc)) return 'trade';
  if (/cash sweep|conto deposito presso flatex|flatexdegiro bank|fondi del mercato monetario|money market/.test(d)) return 'sweep';
  if (/costi di transazione|transaction and\/or third|transaction fee|commissione di transazione/.test(d)) return 'fee';
  if (/imposta sulle transazioni finanziarie|financial transaction tax|tobin/.test(d)) return 'ftt';
  if (/^(prelievo|credito|accredito) fx|^fx (withdrawal|credit)|cambio valuta|valuta debitata|valuta accreditata/.test(d)) return 'fx';
  // I prelievi compaiono tre volte ("Processed" −x, +x e "Prelievo flatex" −x): conta solo l'ultimo.
  if (/processed flatex withdrawal|prelievo rifiutato|withdrawal rejected|rejected withdrawal/.test(d)) return 'withdrawal-noise';
  if (/^(prelievo|withdrawal)|flatex withdrawal/.test(d)) return 'withdrawal';
  if (/^(deposito|deposit)|ideal deposit|sofort deposit|flatex deposit/.test(d)) return 'deposit';
  if (/ritenuta sul dividendo|dividend tax|imposta sul dividendo/.test(d)) return 'dividend-tax';
  if (/dividend|cedol|coupon|distribuzione/.test(d)) return 'dividend';
  if (/compensazione|compensation|promozion|promotion|bonus|rimborso commission/.test(d)) return 'bonus';
  if (/interest|interess/.test(d)) return 'interest';
  if (/costi di connessione|connection fee|exchange connection|costi|fee|commission|spese|imposta|tax/.test(d)) return 'cost';
  return 'ignore';
}

interface Order {
  id: string;
  date: string;
  time: string;
  isin: string;
  name: string;
  buy: boolean;
  qty: number;
  /** Controvalore nella valuta del titolo. */
  value: number;
  currency: string;
  /** Controvalore in EUR dalle righe di cambio, se il titolo non è in EUR. */
  eur: number;
  fees: number;
}

/**
 * DEGIRO — "Estratto conto" (Attività → Estratto conto → Esporta, CSV o Excel), in italiano o in inglese.
 * Le righe di uno stesso ordine (esecuzione, commissioni, Tobin tax, cambio valuta) sono unite tramite l'ID ordine.
 */
export const degiro: FileImporter = {
  id: 'degiro',
  label: 'DEGIRO',
  howTo: 'Posta in arrivo / Attività → Estratto conto: periodo dall\'apertura del conto a oggi → Esporta (CSV o Excel)',
  needsCashBalance: false,
  detect: (sheets) => !!locate(sheets),
  parse(sheets): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Formato DEGIRO non riconosciuto.');
    const { sheet, header, it } = found;
    const col = (n: string) => header.col(n);
    const cDate = col(it ? 'Data' : 'Date');
    const cTime = col(it ? 'Ora' : 'Time');
    const cProduct = col(it ? 'Prodotto' : 'Product');
    const cIsin = col('ISIN');
    const cDesc = col(it ? 'Descrizione' : 'Description');
    const cOrder = col(it ? 'ID Ordine' : 'Order Id');
    // "Variazioni"/"Change" e "Saldo"/"Balance" sono seguite da una colonna senza nome: valuta, poi importo.
    const cChange = header.col(it ? 'Variazioni' : 'Change');
    const cBalance = col(it ? 'Saldo' : 'Balance');

    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    const orders = new Map<string, Order>();
    const orderExtras = new Map<string, { fees: number; eur: number }>();
    const dividends: SyncTx[] = [];
    const divTaxes: { date: string; isin: string; amount: number; id: string }[] = [];
    const makeId = idMaker('degiro');
    const unknown = new Map<string, number>();
    let latestBalance: { key: string; value: number } | undefined;

    const touch = (isin: string, name: string, date?: string, price?: number) => {
      const key = isin || `degiro:${name.toUpperCase()}`;
      if (!assets.has(key)) {
        const cls = classify(name, isin || undefined);
        assets.set(key, {
          key,
          symbol: name,
          name,
          type: cls.type,
          isin: isin || undefined,
          priceMultiplier: cls.priceMultiplier,
          taxRate: cls.taxRate,
        });
      }
      if (date && price) {
        const prev = lastPrice.get(key);
        if (!prev || prev.date <= date) lastPrice.set(key, { date, price });
      }
      return key;
    };

    // Ordine cronologico (il file è dal più recente al più vecchio).
    const rows = sheet.rows
      .slice(header.index + 1)
      .map((r, i) => ({ r, i, date: cellDate(r[cDate]), time: cellText(r[cTime]) }))
      .filter((x) => x.date)
      .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || b.i - a.i);

    for (const { r, date, time } of rows) {
      const desc = cellText(r[cDesc]);
      const isin = cellText(r[cIsin]).toUpperCase();
      const currency = cellText(r[cChange]).toUpperCase();
      const amount = cellNumber(r[cChange + 1]);
      const orderId = cellText(r[cOrder]);
      const kind = degiroKind(desc);

      // Saldo in EUR della riga più recente (per allineare la liquidità).
      if (cellText(r[cBalance]).toUpperCase() === 'EUR' && Number.isFinite(cellNumber(r[cBalance + 1]))) {
        latestBalance = { key: `${date} ${time}`, value: cellNumber(r[cBalance + 1]) };
      }

      if (kind === 'trade') {
        const m = desc.match(TRADE)!;
        const qty = cellNumber(m[2]);
        const price = cellNumber(m[4]);
        const name = m[3].trim();
        const id = orderId || makeId(r);
        const o = orders.get(id) ?? {
          id,
          date,
          time,
          isin: m[6] || isin,
          name,
          buy: /acquisto|buy/i.test(m[1]),
          qty: 0,
          value: 0,
          currency: m[5].toUpperCase(),
          eur: 0,
          fees: 0,
        };
        o.qty += qty;
        o.value += Number.isFinite(amount) ? Math.abs(amount) : qty * price;
        orders.set(id, o);
        continue;
      }

      if (!Number.isFinite(amount) || amount === 0) continue;

      // Righe legate a un ordine: commissioni, Tobin tax, cambio valuta.
      if (orderId && (kind === 'fee' || kind === 'ftt' || kind === 'fx')) {
        const extra = orderExtras.get(orderId) ?? { fees: 0, eur: 0 };
        if (kind === 'fx') {
          if (currency === 'EUR') extra.eur += Math.abs(amount);
        } else {
          extra.fees += -amount; // costo positivo, rimborso negativo
        }
        orderExtras.set(orderId, extra);
        continue;
      }

      const id = makeId(r);
      const name = cellText(r[cProduct]);
      switch (kind) {
        case 'sweep':
        case 'withdrawal-noise':
        case 'fx':
        case 'ignore':
          if (kind === 'ignore') unknown.set(desc.replace(/[\d.,]+/g, '#'), (unknown.get(desc.replace(/[\d.,]+/g, '#')) ?? 0) + 1);
          break;
        case 'deposit':
        case 'withdrawal':
          transactions.push({
            externalId: id,
            date,
            type: amount > 0 ? 'deposito' : 'prelievo',
            amount: Math.abs(amount),
            fees: 0,
            note: amount > 0 ? 'Deposito' : 'Prelievo',
          });
          break;
        case 'dividend':
          dividends.push({
            externalId: id,
            date,
            type: 'dividendo',
            assetKey: isin || name ? touch(isin, name || isin) : undefined,
            amount: Math.abs(amount),
            fees: 0,
            note: 'Dividendo',
          });
          if (currency && currency !== 'EUR') {
            warnings.push(`Dividendo in ${currency} del ${date}: l'importo non è convertito in EUR.`);
          }
          break;
        case 'dividend-tax':
          divTaxes.push({ date, isin, amount, id });
          break;
        case 'bonus':
          transactions.push({ externalId: id, date, type: 'interessi', amount: Math.abs(amount), fees: 0, note: desc.replace(/\s+/g, ' ').slice(0, 60) });
          break;
        case 'interest':
          transactions.push(
            amount > 0
              ? { externalId: id, date, type: 'interessi', amount, fees: 0, note: 'Interessi' }
              : { externalId: id, date, type: 'commissione', amount: -amount, fees: 0, note: 'Interessi passivi' },
          );
          break;
        case 'fee':
        case 'ftt':
        case 'cost':
          transactions.push({
            externalId: id,
            date,
            type: 'commissione',
            amount: -amount,
            fees: 0,
            note: kind === 'ftt' ? 'Imposta sulle transazioni finanziarie' : desc.replace(/\s+/g, ' ').slice(0, 60),
          });
          break;
      }
    }

    for (const o of orders.values()) {
      const extra = orderExtras.get(o.id);
      const valueEur = o.currency === 'EUR' ? o.value : extra?.eur ?? 0;
      if (!valueEur) {
        warnings.push(`Ordine ${o.name} del ${o.date} in ${o.currency} senza cambio in EUR: ignorato.`);
        continue;
      }
      const price = Math.round((valueEur / o.qty) * 1e8) / 1e8;
      transactions.push({
        externalId: `degiro:order:${o.id}`,
        date: o.date,
        type: o.buy ? 'acquisto' : 'vendita',
        assetKey: touch(o.isin, o.name, o.date, price),
        quantity: o.qty,
        price,
        fees: Math.round((extra?.fees ?? 0) * 100) / 100,
      });
    }
    // Commissioni/Tobin con ID ordine ma senza esecuzione nel file (es. ordine fuori periodo): costi a sé.
    for (const [oid, extra] of orderExtras) {
      if (!orders.has(oid) && extra.fees) {
        transactions.push({ externalId: `degiro:orderfee:${oid}`, date: '', type: 'commissione', amount: extra.fees, fees: 0, note: 'Costi di un ordine fuori periodo' });
      }
    }

    // Ritenute: sottratte al dividendo dello stesso titolo e giorno.
    for (const t of divTaxes) {
      const div = dividends.find((d) => d.date === t.date && (!t.isin || d.assetKey === t.isin));
      if (div) div.fees = Math.round((div.fees - t.amount) * 100) / 100;
      else transactions.push({ externalId: t.id, date: t.date, type: 'commissione', amount: -t.amount, fees: 0, note: 'Ritenuta sul dividendo' });
    }
    transactions.push(...dividends);

    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }
    for (const [d, n] of unknown) warnings.push(`${n} righe "${d}" non riconosciute: ignorate.`);
    if (lastPrice.size) warnings.push('Il file non contiene i prezzi correnti: aggiornali nella pagina Strumenti.');

    return {
      accountName: 'DEGIRO',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.filter((t) => t.date).sort((a, b) => a.date.localeCompare(b.date)),
      cash: latestBalance?.value,
      warnings,
    };
  },
};
