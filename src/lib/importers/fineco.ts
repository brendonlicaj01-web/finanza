import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cashMirror, cellDate, cellNumber, cellText, classify, findHeader, idMaker } from './util';

const COLUMNS = ['Operazione', 'Data valuta', 'Descrizione', 'Titolo', 'ISIN', 'Segno', 'Quantita', 'Divisa', 'Prezzo', 'Controvalore'];

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, COLUMNS);
    if (header) return { sheet, header };
  }
  return undefined;
}

/**
 * Fineco — "Movimenti Dossier Titoli" (Account → Report → Ordini e contabili → Titoli → Ricerca avanzata →
 * Esporta in Excel). Contiene compravendite, rimborsi e proventi; non contiene la liquidità.
 */
export const fineco: FileImporter = {
  id: 'fineco',
  label: 'Fineco',
  howTo: 'Account → Report → Ordini e contabili → Titoli → Ricerca avanzata (dall\'apertura del conto a oggi) → Esporta in Excel',
  needsCashBalance: true,
  detect: (sheets) => !!locate(sheets),
  parse(sheets, { balanceCash, existingIds }): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Formato Fineco non riconosciuto.');
    const { sheet, header } = found;
    const c = (name: string) => header.col(name);
    const feeCols = sheet.rows[header.index]
      .map((h, i) => (/commission|spese/i.test(cellText(h)) ? i : -1))
      .filter((i) => i >= 0);

    const warnings: string[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    const transactions: SyncTx[] = [];
    const makeId = idMaker('fineco');
    const unknown = new Set<string>();
    let foreign = false;

    for (const row of sheet.rows.slice(header.index + 1)) {
      const date = cellDate(row[c('Operazione')]);
      const isin = cellText(row[c('ISIN')]).toUpperCase();
      const title = cellText(row[c('Titolo')]).replace(/^\*+\s*/, '');
      if (!date || (!isin && !title)) continue;

      const what = cellText(row[c('Descrizione')]).toLowerCase();
      const sign = cellText(row[c('Segno')]).toUpperCase();
      const qty = Math.abs(cellNumber(row[c('Quantita')]));
      const currency = cellText(row[c('Divisa')]).toUpperCase() || 'EUR';
      const rate = cellNumber(row[c('Cambio')]) || 1;
      let price = cellNumber(row[c('Prezzo')]);
      const value = Math.abs(cellNumber(row[c('Controvalore')]));
      const fees = feeCols.reduce((s, i) => s + (Math.abs(cellNumber(row[i])) || 0), 0);

      const key = isin || `fineco:${title}`;
      const cls = classify(title, isin);
      if (!assets.has(key)) {
        assets.set(key, {
          key,
          symbol: title || isin,
          name: title || isin,
          type: cls.type,
          isin: isin || undefined,
          priceMultiplier: cls.priceMultiplier,
          taxRate: cls.taxRate,
        });
      }
      const mult = cls.priceMultiplier ?? 1;
      const id = makeId(row);

      // Importi in valuta estera: Fineco indica il cambio come unità di valuta per 1 euro.
      const toEur = (n: number) => (currency === 'EUR' ? n : n / rate);
      if (currency !== 'EUR') foreign = true;

      let tx: SyncTx | undefined;
      if (/compravendita|sottoscrizione|riscatto|acquisto|vendita/.test(what)) {
        // Attenzione: "compravendita" contiene "vendita": decide il segno (A/V), o la parola iniziale.
        const sell = sign === 'V' || (sign !== 'A' && /riscatto|^vendita/.test(what));
        if (!(qty > 0)) continue;
        if (!(price > 0)) price = value / (qty * mult);
        tx = { externalId: id, date, type: sell ? 'vendita' : 'acquisto', assetKey: key, quantity: qty, price: toEur(price), fees: toEur(fees) };
      } else if (/rimborso|scadenza/.test(what)) {
        if (!(qty > 0)) continue;
        tx = {
          externalId: id,
          date,
          type: 'vendita',
          assetKey: key,
          quantity: qty,
          price: toEur(value / (qty * mult)),
          fees: toEur(fees),
          note: 'Rimborso a scadenza',
        };
      } else if (/dividend|cedol|provent|premio|interess/.test(what)) {
        if (!(value > 0)) continue;
        tx = { externalId: id, date, type: 'dividendo', assetKey: key, amount: toEur(value), fees: toEur(fees), note: cellText(row[c('Descrizione')]) };
      } else {
        unknown.add(cellText(row[c('Descrizione')]));
        continue;
      }

      transactions.push(tx);
      if (tx.price && (tx.type === 'acquisto' || tx.type === 'vendita') && tx.note !== 'Rimborso a scadenza') {
        const prev = lastPrice.get(key);
        if (!prev || prev.date <= date) lastPrice.set(key, { date, price: tx.price });
      }
      if (balanceCash) {
        const mirror = cashMirror(tx, mult);
        if (mirror) transactions.push(mirror);
      }
    }

    // Il file non riporta i prezzi correnti: usiamo l'ultimo prezzo di scambio, da aggiornare poi.
    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }
    // Se i titoli sono già stati importati dal file del conto corrente, questo file serve solo ad
    // aggiungere ISIN e tipologia agli strumenti: le operazioni sarebbero doppioni.
    if ([...existingIds].some((id) => id.startsWith('fineco-cc:'))) {
      return {
        accountName: 'Fineco',
        accountKind: 'broker',
        currency: 'EUR',
        assets: [...assets.values()].map(({ price: _p, priceDate: _d, ...a }) => a),
        transactions: [],
        warnings: [
          'Hai già importato il file dei movimenti del conto corrente Fineco: da questo file vengono presi solo ISIN e tipologia dei titoli, per non creare doppioni.',
        ],
      };
    }
    for (const u of unknown) warnings.push(`Operazioni "${u}" non riconosciute: ignorate.`);
    if (foreign) warnings.push('Ci sono operazioni in valuta estera: verifica che gli importi convertiti in euro siano corretti.');
    if (lastPrice.size) {
      warnings.push('Il file non contiene i prezzi correnti: aggiornali nella pagina Strumenti (o importa anche l\'Excel del portafoglio).');
    }

    return {
      accountName: 'Fineco',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      warnings,
    };
  },
};
