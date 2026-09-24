import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellDate, cellNumber, cellText, classify, idMaker, norm } from './util';

/** Nomi di colonna riconosciuti (italiano e inglese), confrontati senza spazi, accenti e simboli. */
const ALIASES = {
  date: ['dataoperazione', 'data', 'date', 'tradedate', 'dataeseguito', 'datacontabile', 'bookingdate', 'giorno'],
  type: ['tipooperazione', 'tipo', 'operazione', 'type', 'transactiontype', 'causale', 'categoria'],
  desc: ['descrizione', 'description', 'titolo', 'strumento', 'prodotto', 'product', 'nome', 'name', 'dettaglio'],
  isin: ['isin', 'codiceisin'],
  symbol: ['ticker', 'simbolo', 'symbol'],
  // "quantit": "Quantità" letto con la codifica sbagliata perde la à.
  qty: ['quantita', 'quantit', 'quantity', 'qta', 'shares', 'numero', 'pezzi', 'units'],
  price: ['prezzo', 'price', 'prezzounitario', 'corso', 'prezzomedio'],
  amount: ['importo', 'amount', 'controvalore', 'importoeuro', 'totale', 'total', 'netamount', 'valore', 'value'],
  fees: ['commissioni', 'commissione', 'fees', 'fee', 'costi', 'spese'],
  id: ['idoperazione', 'id', 'transactionid', 'riferimento', 'protocollo', 'orderid', 'numerooperazione'],
  balance: ['saldoprogressivo', 'saldo', 'balance', 'saldodisponibile'],
} as const;

type Col = keyof typeof ALIASES;

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    for (let i = 0; i < Math.min(sheet.rows.length, 40); i++) {
      const cells = sheet.rows[i].map((c) => norm(cellText(c)));
      const cols = {} as Record<Col, number>;
      for (const [k, names] of Object.entries(ALIASES) as [Col, readonly string[]][]) {
        cols[k] = cells.findIndex((c) => names.includes(c));
      }
      const hasValue = cols.amount >= 0 || (cols.qty >= 0 && cols.price >= 0);
      if (cols.date >= 0 && cols.type >= 0 && hasValue) return { sheet, index: i, cols };
    }
  }
  return undefined;
}

const ISIN = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
const squash = (s: string) => s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();

type Kind = 'buy' | 'sell' | 'dividend' | 'withholding' | 'deposit' | 'withdrawal' | 'interest' | 'fee' | 'transfer';

/** Riconosce il tipo di operazione da parole chiave (tipo, poi descrizione), con il segno dell'importo come arbitro. */
export function kindOf(type: string, desc: string, amount: number): Kind | undefined {
  const t = type.toLowerCase();
  const d = desc.toLowerCase();
  const test = (re: RegExp) => re.test(t) || (!t && re.test(d));
  if (/compravendita/.test(t)) return amount > 0 ? 'sell' : 'buy';
  if (/^(compra|acquist|buy|acq\b|sottoscri)/.test(t)) return 'buy';
  if (/^(vend|sell|rimbors|riscatt)/.test(t)) return 'sell';
  if (test(/ritenut|withholding/)) return 'withholding';
  if (test(/dividend|cedol|provent|coupon/)) return 'dividend';
  if (test(/interess|interest/)) return amount >= 0 ? 'interest' : 'fee';
  if (test(/commission|impost|bollo|spese|fee|tass|tobin|capital ?gain|addebito/)) return 'fee';
  if (test(/preliev|prelev|withdraw|in uscita/)) return 'withdrawal';
  if (test(/versament|deposit|in entrata|accredito/)) return 'deposit';
  if (test(/bonific|giroconto|transfer/)) return 'transfer';
  return undefined;
}

/**
 * CSV/Excel generico: per broker senza un lettore dedicato (es. Directa). Riconosce le colonne più comuni e
 * i tipi di operazione più diffusi; l'ISIN può stare in una colonna o tra parentesi nella descrizione.
 */
export const generic: FileImporter = {
  id: 'generic',
  label: 'CSV generico',
  howTo:
    'Qualsiasi CSV o Excel con almeno le colonne Data, Tipo operazione e Importo (o Quantità e Prezzo); facoltative Descrizione, ISIN, Commissioni, ID operazione, Saldo',
  needsCashBalance: false,
  detect: (sheets) => !!locate(sheets),
  parse(sheets, { knownSymbols }): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Colonne non riconosciute: servono almeno Data, Tipo operazione e Importo.');
    const { sheet, index, cols } = found;
    const get = (row: unknown[], k: Col) => (cols[k] >= 0 ? row[cols[k]] : undefined);

    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    const makeId = idMaker('csv');
    const unknown = new Map<string, number>();
    const withholdings: SyncTx[] = [];
    const balances: { date: string; order: number; value: number }[] = [];
    const known = knownSymbols.map((s) => ({ s, k: squash(s) })).filter((x) => x.k.length >= 3);

    const assetFor = (desc: string, isinCell: string, symbolCell: string) => {
      const isin = (isinCell || desc.match(ISIN)?.[1] || '').toUpperCase();
      const name = desc.replace(/\(?\b[A-Z]{2}[A-Z0-9]{9}\d\b\)?/, '').replace(/\s+/g, ' ').trim() || isin;
      const key = isin || `csv:${squash(symbolCell || name)}`;
      if (!assets.has(key)) {
        const cls = classify(name, isin || undefined);
        assets.set(key, {
          key,
          symbol: symbolCell || name,
          name,
          type: cls.type,
          isin: isin || undefined,
          priceMultiplier: cls.priceMultiplier,
          taxRate: cls.taxRate,
        });
      }
      return assets.get(key)!;
    };

    /** Per dividendi senza ISIN: cerca uno strumento noto citato nella descrizione. */
    const guessAsset = (desc: string) => {
      const d = squash(desc);
      for (const a of assets.values()) if (d.includes(squash(a.name)) || (a.isin && d.includes(a.isin))) return a;
      const hit = known.find((x) => d.includes(x.k));
      return hit ? assetFor(hit.s, '', hit.s) : undefined;
    };

    sheet.rows.slice(index + 1).forEach((row, order) => {
      const date = cellDate(get(row, 'date'));
      if (!date) return;
      const type = cellText(get(row, 'type'));
      const desc = cellText(get(row, 'desc'));
      const qty = Math.abs(cellNumber(get(row, 'qty'))) || 0;
      let price = Math.abs(cellNumber(get(row, 'price'))) || 0;
      const rawAmount = cellNumber(get(row, 'amount'));
      const amount = Number.isFinite(rawAmount) ? rawAmount : 0;
      const fees = Math.abs(cellNumber(get(row, 'fees'))) || 0;
      const bal = cellNumber(get(row, 'balance'));
      if (Number.isFinite(bal)) balances.push({ date, order, value: bal });

      const idCell = cellText(get(row, 'id'));
      const externalId = idCell ? `csv:${idCell}` : makeId(row);
      const kind = kindOf(type, desc, amount);

      switch (kind) {
        case 'buy':
        case 'sell': {
          if (!qty) {
            warnings.push(`Riga del ${date} (${type}) senza quantità: ignorata.`);
            return;
          }
          const asset = assetFor(desc, cellText(get(row, 'isin')), cellText(get(row, 'symbol')));
          const mult = asset.priceMultiplier ?? 1;
          if (!price && amount) price = Math.abs(amount) / (qty * mult);
          transactions.push({
            externalId,
            date,
            type: kind === 'buy' ? 'acquisto' : 'vendita',
            assetKey: asset.key,
            quantity: qty,
            price,
            fees,
          });
          const prev = lastPrice.get(asset.key);
          if (!prev || prev.date <= date) lastPrice.set(asset.key, { date, price });
          return;
        }
        case 'dividend': {
          const asset = cellText(get(row, 'isin')) || ISIN.test(desc)
            ? assetFor(desc, cellText(get(row, 'isin')), cellText(get(row, 'symbol')))
            : guessAsset(desc);
          transactions.push({ externalId, date, type: 'dividendo', assetKey: asset?.key, amount: Math.abs(amount), fees, note: desc || type });
          return;
        }
        case 'withholding':
          withholdings.push({ externalId, date, type: 'commissione', amount: Math.abs(amount) + fees, fees: 0, note: desc || type });
          return;
        case 'interest':
          transactions.push({ externalId, date, type: 'interessi', amount: Math.abs(amount), fees, note: desc || type });
          return;
        case 'fee':
          // Importo positivo = rimborso di costi/imposte: commissione negativa.
          transactions.push({ externalId, date, type: 'commissione', amount: -amount || fees, fees: 0, note: desc || type });
          return;
        case 'deposit':
        case 'withdrawal':
        case 'transfer': {
          if (!amount) return;
          const out = kind === 'withdrawal' || (kind === 'transfer' && amount < 0);
          transactions.push({ externalId, date, type: out ? 'prelievo' : 'deposito', amount: Math.abs(amount), fees, note: desc || type });
          return;
        }
        default:
          unknown.set(type || '(vuoto)', (unknown.get(type || '(vuoto)') ?? 0) + 1);
          if (amount) {
            transactions.push({ externalId, date, type: amount > 0 ? 'deposito' : 'prelievo', amount: Math.abs(amount), fees, note: desc || type });
          }
      }
    });

    // Le ritenute vanno sul dividendo dello stesso giorno, se c'è; altrimenti restano un'imposta.
    for (const w of withholdings) {
      const div = transactions.find((t) => t.type === 'dividendo' && t.date === w.date);
      if (div) div.fees = Math.round((div.fees + (w.amount ?? 0)) * 100) / 100;
      else transactions.push(w);
    }

    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }

    // Saldo finale: quello della riga più recente (a parità di data, l'ultima nell'ordine del file).
    let cash: number | undefined;
    if (balances.length) {
      const ascending = balances[0].date <= balances[balances.length - 1].date;
      const latest = balances.reduce((best, b) =>
        b.date > best.date || (b.date === best.date && (ascending ? b.order > best.order : b.order < best.order)) ? b : best,
      );
      cash = latest.value;
    }

    for (const [t, n] of unknown) {
      warnings.push(`${n} operazioni di tipo "${t}" non riconosciute: importate come movimenti di liquidità.`);
    }
    if (lastPrice.size) warnings.push('Il file non contiene i prezzi correnti: aggiornali nella pagina Strumenti.');
    if (cash === undefined) {
      warnings.push('Nessuna colonna "Saldo": la liquidità è calcolata solo dai movimenti del file.');
    }

    return {
      accountName: 'Conto importato',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      cash,
      warnings,
    };
  },
};
