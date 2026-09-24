import type { SyncAsset, SyncResult, SyncTx } from '../sync-types';
import type { FileImporter, Sheet } from './types';
import { cellDate, cellNumber, cellText, classify, findHeader, idMaker } from './util';

const COLUMNS = ['Data_Operazione', 'Data_Valuta', 'Entrate', 'Uscite', 'Descrizione', 'Descrizione_Completa'];

const squash = (s: string) => s.replace(/[\s*]/g, '').toUpperCase();

/** Fineco va a capo ogni 40 caratteri inserendo uno spazio: lo togliamo dove cade esattamente lì. */
export function unwrap(s: string): string {
  let out = s;
  for (let pos = 40; pos < out.length; pos += 40) {
    if (out[pos] === ' ') out = out.slice(0, pos) + out.slice(pos + 1);
  }
  return out;
}

function locate(sheets: Sheet[]) {
  for (const sheet of sheets) {
    const header = findHeader(sheet.rows, COLUMNS);
    if (header) return { sheet, header };
  }
  return undefined;
}

/**
 * Fineco — "Movimenti" del conto corrente (Account → movimenti, filtro dall'apertura del conto a oggi →
 * Esporta Excel). Contiene tutta la liquidità (bonifici, imposte) e l'addebito/accredito di ogni
 * operazione sui titoli, da cui ricaviamo compravendite, rimborsi e proventi.
 */
export const finecoConto: FileImporter = {
  id: 'fineco-conto',
  label: 'Fineco',
  howTo: 'Account → Movimenti del conto: filtro dall\'apertura del conto a oggi → Esporta Excel',
  needsCashBalance: false,
  detect: (sheets) => !!locate(sheets),
  parse(sheets, { existingIds, knownSymbols }): SyncResult {
    const found = locate(sheets);
    if (!found) throw new Error('Formato Fineco (conto corrente) non riconosciuto.');
    const { sheet, header } = found;
    const c = (name: string) => header.col(name);
    const statusCol = c('Stato');

    const warnings: string[] = [];
    const transactions: SyncTx[] = [];
    const assets = new Map<string, SyncAsset>();
    const lastPrice = new Map<string, { date: string; price: number }>();
    const makeId = idMaker('fineco-cc');
    const dossierAlready = [...existingIds].some((id) => /^fineco:[0-9a-f]/.test(id));
    let skippedSecurities = 0;

    const known = new Map<string, string>();
    for (const s of knownSymbols) known.set(squash(s), s);

    const assetFor = (rawTitle: string) => {
      const title = rawTitle.replace(/^\*+\s*/, '').trim();
      const key = `fineco-cc:${squash(title)}`;
      if (!assets.has(key)) {
        const cls = classify(title);
        assets.set(key, {
          key,
          symbol: known.get(squash(title)) ?? title,
          name: title,
          type: cls.type,
          priceMultiplier: cls.priceMultiplier,
          taxRate: cls.taxRate,
        });
      }
      return assets.get(key)!;
    };

    const rows = sheet.rows.slice(header.index + 1);
    // Prima passata: i titoli delle compravendite (le loro descrizioni non vengono spezzate).
    for (const row of rows) {
      const full = cellText(row[c('Descrizione_Completa')]);
      const m = full.match(/(?:Compravendita|Rimborso) Titoli(?: Italia| Estero)? (.+?) Qta\/Val/i);
      if (m) known.set(squash(m[1]), m[1].replace(/^\*+\s*/, ''));
    }

    for (const row of rows) {
      const date = cellDate(row[c('Data_Operazione')]);
      if (!date) continue;
      if (statusCol >= 0 && cellText(row[statusCol]) && !/contabilizzat/i.test(cellText(row[statusCol]))) continue;
      const inflow = Math.abs(cellNumber(row[c('Entrate')])) || 0;
      const outflow = Math.abs(cellNumber(row[c('Uscite')])) || 0;
      const amount = inflow - outflow;
      if (!amount) continue;
      const what = cellText(row[c('Descrizione')]);
      const whatL = what.toLowerCase();
      const full = cellText(row[c('Descrizione_Completa')]);
      const id = makeId(row);

      const trade = full.match(/(?:Compravendita|Rimborso) Titoli(?: Italia| Estero)? (.+?) Qta\/Val\.?\s*nom\.?\s*([\d.,]+)/i);
      const isIncome = /provent|cedol|dividend/.test(whatL);

      if ((trade || isIncome) && dossierAlready) {
        skippedSecurities++;
        continue;
      }

      if (trade) {
        const asset = assetFor(trade[1]);
        const qty = cellNumber(trade[2]);
        if (!(qty > 0)) continue;
        const mult = asset.priceMultiplier ?? 1;
        const price = Math.abs(amount) / (qty * mult);
        const redemption = /rimborso/i.test(full);
        const tx: SyncTx = {
          externalId: id,
          date,
          type: amount < 0 ? 'acquisto' : 'vendita',
          assetKey: asset.key,
          quantity: qty,
          price,
          fees: 0,
          note: redemption ? 'Rimborso a scadenza' : undefined,
        };
        transactions.push(tx);
        if (!redemption) {
          const prev = lastPrice.get(asset.key);
          if (!prev || prev.date <= date) lastPrice.set(asset.key, { date, price });
        }
        continue;
      }

      if (isIncome) {
        // Il titolo è in fondo alla descrizione, dopo la quantità: lo cerchiamo tra quelli noti.
        const tail = (full.match(/[\d.,]+\s+(\D.*)$/)?.[1] ?? '').trim();
        const hit = [...known.entries()].find(([k]) => squash(tail).endsWith(k) || squash(full).includes(k));
        const title = hit ? hit[1] : unwrap(full).match(/[\d.,]+\s+(\D.*)$/)?.[1];
        transactions.push({
          externalId: id,
          date,
          type: amount > 0 ? 'dividendo' : 'commissione',
          assetKey: title ? assetFor(title).key : undefined,
          amount: Math.abs(amount),
          fees: 0,
          note: what,
        });
        continue;
      }

      let type: SyncTx['type'];
      if (/imposta|bollo|ritenut|tass|commission|spese|canone|capit/.test(whatL)) type = 'commissione';
      else if (/interess|competenz/.test(whatL)) type = amount > 0 ? 'interessi' : 'commissione';
      else type = amount > 0 ? 'deposito' : 'prelievo';
      // Le imposte rimborsate (importo positivo) diventano una commissione negativa.
      const value = type === 'commissione' ? -amount : Math.abs(amount);
      transactions.push({ externalId: id, date, type, amount: Math.round(value * 100) / 100, fees: 0, note: what });
    }

    for (const [key, p] of lastPrice) {
      const a = assets.get(key);
      if (a) {
        a.price = p.price;
        a.priceDate = p.date;
      }
    }

    // Saldo finale dall'intestazione del file (es. "Saldo Finale: 1.234,56").
    let cash: number | undefined;
    for (const row of sheet.rows.slice(0, header.index)) {
      const m = cellText(row[0]).match(/Saldo Finale:\s*(-?[\d.,]+)/i);
      if (m) cash = cellNumber(m[1]);
    }

    if (skippedSecurities) {
      warnings.push(
        `${skippedSecurities} operazioni sui titoli già presenti dall'import del dossier: importati solo i movimenti di liquidità.`,
      );
    }
    if (lastPrice.size) {
      warnings.push('Il file non contiene i prezzi correnti: aggiornali nella pagina Strumenti.');
    }
    if ([...assets.values()].some((a) => a.priceMultiplier)) {
      warnings.push(
        'Per le obbligazioni il prezzo è ricavato dall\'addebito sul conto: può includere rateo cedola e commissioni.',
      );
    }

    return {
      accountName: 'Fineco',
      accountKind: 'broker',
      currency: 'EUR',
      assets: [...assets.values()],
      transactions: transactions.sort((a, b) => a.date.localeCompare(b.date)),
      cash: cash !== undefined && Number.isFinite(cash) ? cash : undefined,
      warnings,
    };
  },
};
