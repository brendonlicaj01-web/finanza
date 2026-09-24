import type { AssetType } from '../types';
import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellNumber, cellText, findHeader } from './util';

const COLUMNS = ['datetime', 'date', 'account_type', 'category', 'type', 'asset_class', 'name', 'symbol', 'shares', 'price', 'amount', 'fee', 'tax', 'transaction_id'];

/** Pagamenti con carta: per privacy non vengono mai letti nel dettaglio. */
const CARD = /^CARD_/;

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, COLUMNS);
    if (header) return { sheet, header };
  }
  return undefined;
}

function assetType(assetClass: string, name: string): AssetType {
  switch (assetClass.toUpperCase()) {
    case 'STOCK':
      return 'azione';
    case 'FUND':
      return /\b(fund|fondo)\b/i.test(name) && !/etf|acc|dist/i.test(name) ? 'fondo' : 'etf';
    case 'CRYPTO':
      return 'crypto';
    case 'BOND':
      return 'obbligazione';
    default:
      return 'altro';
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Trade Republic — export CSV delle transazioni (una riga per movimento, colonne in inglese).
 * Per privacy: i pagamenti con carta sono esclusi (o, a scelta, ridotti a un totale mensile anonimo),
 * e dei bonifici non vengono letti nomi, IBAN o causali.
 */
export const tradeRepublic: FileImporter = {
  id: 'traderepublic',
  label: 'Trade Republic',
  howTo: 'App o sito Trade Republic → Profilo → Transazioni → Esporta (CSV)',
  needsCashBalance: false,
  options: [
    {
      key: 'cardMonthly',
      label: 'Includi le spese con carta come totale mensile anonimo',
      hint: 'Spento: i pagamenti con carta sono ignorati (la liquidità risulterà più alta del reale). Acceso: un solo prelievo per mese, senza esercenti; il mese in corso è escluso finché non è concluso.',
      default: false,
    },
  ],
  detect: (sheets) => !!locate(sheets),
  parse(sheets, { flags }): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Formato Trade Republic non riconosciuto.');
    const { sheet, header } = found;
    const c = (n: string) => header.col(n);
    const cardMonthly = flags?.cardMonthly ?? false;

    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    const unknown = new Map<string, number>();
    const cardByMonth = new Map<string, number>();
    let cardCount = 0;
    let lastDate = '';

    const assetFor = (row: unknown[]) => {
      const cls = cellText(row[c('asset_class')]).toUpperCase();
      const symbol = cellText(row[c('symbol')]).toUpperCase();
      const name = cellText(row[c('name')]);
      if (!symbol) return undefined;
      const isin = /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(symbol) ? symbol : undefined;
      const key = cls === 'CRYPTO' ? `crypto:${symbol}` : isin ?? `tr:${symbol}`;
      if (!assets.has(key)) {
        assets.set(key, {
          key,
          symbol: cls === 'CRYPTO' ? symbol : name || symbol,
          name: name || symbol,
          type: assetType(cls, name),
          isin,
          taxRate: 26,
        });
      }
      return key;
    };
    const seenPrice = (key: string, date: string, price: number) => {
      if (!(price > 0)) return;
      const prev = lastPrice.get(key);
      if (!prev || prev.date <= date) lastPrice.set(key, { date, price });
    };

    // Ordine cronologico: serve per valorizzare le uscite di crypto all'ultimo prezzo noto.
    const rows = sheet.rows
      .slice(header.index + 1)
      .filter((r) => cellText(r[c('date')]))
      .sort((a, b) => cellText(a[c('datetime')]).localeCompare(cellText(b[c('datetime')])));

    for (const row of rows) {
      const type = cellText(row[c('type')]).toUpperCase();
      const date = cellText(row[c('date')]).slice(0, 10);
      if (date > lastDate) lastDate = date;
      const amount = cellNumber(row[c('amount')]) || 0;
      const fee = cellNumber(row[c('fee')]) || 0;
      const tax = cellNumber(row[c('tax')]) || 0;
      const cashEffect = amount + fee + tax;

      if (CARD.test(type)) {
        cardCount++;
        if (cardMonthly) cardByMonth.set(date.slice(0, 7), (cardByMonth.get(date.slice(0, 7)) ?? 0) + cashEffect);
        continue;
      }

      const id = `tr:${cellText(row[c('transaction_id')])}`;
      const shares = cellNumber(row[c('shares')]) || 0;
      const price = cellNumber(row[c('price')]) || 0;
      const costs = r2(Math.abs(fee) + Math.abs(tax));

      switch (type) {
        case 'BUY':
        case 'SELL': {
          const key = assetFor(row);
          if (!key || !shares) break;
          const sell = type === 'SELL' || shares < 0 || amount > 0;
          const unit = price || (shares ? Math.abs(amount) / Math.abs(shares) : 0);
          transactions.push({
            externalId: id,
            date,
            type: sell ? 'vendita' : 'acquisto',
            assetKey: key,
            quantity: Math.abs(shares),
            price: unit,
            fees: costs,
          });
          seenPrice(key, date, unit);
          break;
        }
        case 'FREE_RECEIPT':
        case 'FREE_DELIVERY': {
          // Titoli o crypto trasferiti da/verso un altro conto: valorizzati al prezzo indicato
          // (o all'ultimo prezzo noto), con un movimento di liquidità speculare.
          const key = assetFor(row);
          if (!key || !shares) break;
          const inflow = type === 'FREE_RECEIPT';
          const unit = price || lastPrice.get(key)?.price || 0;
          if (!unit) warnings.push(`Trasferimento di ${assets.get(key)?.symbol} del ${date} senza prezzo: valorizzato a 0.`);
          const value = r2(Math.abs(shares) * unit);
          if (value) {
            transactions.push({
              externalId: `${id}:cash`,
              date,
              type: inflow ? 'deposito' : 'prelievo',
              amount: value,
              fees: 0,
              note: inflow ? 'Trasferimento titoli/crypto in entrata' : 'Trasferimento titoli/crypto in uscita',
            });
          }
          transactions.push({
            externalId: id,
            date,
            type: inflow ? 'acquisto' : 'vendita',
            assetKey: key,
            quantity: Math.abs(shares),
            price: unit,
            fees: costs,
            note: inflow ? 'Ricevuti da altro conto' : 'Inviati ad altro conto',
          });
          if (inflow) seenPrice(key, date, unit);
          break;
        }
        case 'DIVIDEND': {
          const key = assetFor(row);
          transactions.push({ externalId: id, date, type: 'dividendo', assetKey: key, amount: r2(amount), fees: costs, note: 'Dividendo' });
          break;
        }
        case 'INTEREST_PAYMENT':
          transactions.push({ externalId: id, date, type: 'interessi', amount: r2(amount), fees: costs, note: 'Interessi sulla liquidità' });
          break;
        case 'BENEFITS_SAVEBACK':
        case 'BONUS':
          transactions.push({
            externalId: id,
            date,
            type: 'interessi',
            amount: r2(amount),
            fees: costs,
            note: type === 'BONUS' ? 'Bonus Trade Republic' : 'Saveback / premio',
          });
          break;
        case 'TAX_OPTIMIZATION':
        case 'TAX':
        case 'FEE': {
          if (!cashEffect) break;
          const desc = cellText(row[c('description')]);
          const note =
            type === 'FEE'
              ? 'Commissione'
              : /stamp/i.test(desc)
                ? 'Imposta di bollo'
                : /transfer out/i.test(desc)
                  ? 'Imposta sul trasferimento in uscita'
                  : 'Imposte (ottimizzazione fiscale)';
          // Effetto negativo = costo; positivo = rimborso (commissione negativa).
          transactions.push({ externalId: id, date, type: 'commissione', amount: r2(-cashEffect), fees: 0, note });
          break;
        }
        case 'CUSTOMER_INPAYMENT':
        case 'TRANSFER_INBOUND':
        case 'TRANSFER_INSTANT_INBOUND':
        case 'TRANSFER_OUTBOUND':
        case 'TRANSFER_INSTANT_OUTBOUND': {
          if (!amount) break;
          const inflow = amount > 0;
          transactions.push({
            externalId: id,
            date,
            type: inflow ? 'deposito' : 'prelievo',
            amount: r2(Math.abs(amount)),
            fees: r2(Math.abs(fee)),
            note: type === 'CUSTOMER_INPAYMENT' ? 'Ricarica' : inflow ? 'Bonifico in entrata' : 'Bonifico in uscita',
          });
          break;
        }
        default: {
          unknown.set(type || '(vuoto)', (unknown.get(type || '(vuoto)') ?? 0) + 1);
          if (cashEffect) {
            transactions.push({
              externalId: id,
              date,
              type: cashEffect > 0 ? 'deposito' : 'prelievo',
              amount: r2(Math.abs(cashEffect)),
              fees: 0,
              note: `Movimento Trade Republic (${type.toLowerCase()})`,
            });
          }
        }
      }
    }

    if (cardMonthly) {
      // Solo mesi conclusi: un mese parziale cambierebbe totale al prossimo import.
      const current = lastDate.slice(0, 7);
      for (const [month, total] of cardByMonth) {
        if (month >= current || !r2(total)) continue;
        transactions.push({
          externalId: `tr:card:${month}`,
          date: `${month}-28`,
          type: total < 0 ? 'prelievo' : 'deposito',
          amount: r2(Math.abs(total)),
          fees: 0,
          note: 'Spese con carta (totale del mese)',
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

    if (cardCount) {
      warnings.push(
        cardMonthly
          ? `${cardCount} pagamenti con carta ridotti a totali mensili anonimi (mese in corso escluso).`
          : `${cardCount} pagamenti con carta esclusi per privacy: la liquidità del conto risulterà più alta di quella reale.`,
      );
    }
    for (const [t, n] of unknown) warnings.push(`${n} movimenti di tipo ${t} non riconosciuti: importati come movimenti di liquidità.`);
    if (lastPrice.size) warnings.push('Il file non contiene i prezzi correnti: aggiornali nella pagina Strumenti.');

    return {
      accountName: 'Trade Republic',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      warnings,
    };
  },
};
