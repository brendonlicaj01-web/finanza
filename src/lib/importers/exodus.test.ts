import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { exodus, exodusSymbol } from './exodus';
import { fillPrices, priceRequest } from '../pricefill';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

// Stessa struttura dell'export di Exodus, con indirizzi e transazioni inventati.
const HEAD = 'DATE,TYPE,FROMPORTFOLIO,TOPORTFOLIO,OUTAMOUNT,OUTCURRENCY,FEEAMOUNT,FEECURRENCY,FROMADDRESS,TOADDRESS,OUTTXID,OUTTXURL,INAMOUNT,INCURRENCY,INTXID,INTXURL,ORDERID,PERSONALNOTE';
const row = (o: Partial<Record<string, string>>) =>
  HEAD.split(',').map((h) => o[h] ?? '').join(',');
const CSV = [
  HEAD,
  // SOL ricevuti, messi in staking (solo commissione), rientrati con i premi, poi inviati tutti.
  row({ DATE: '2025-11-21T10:00:00.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '0.7', INCURRENCY: 'SOL', INTXID: 's1' }),
  row({ DATE: '2025-11-21T11:00:00.000Z', TYPE: 'staked', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '0', OUTCURRENCY: 'SOL', FEEAMOUNT: '-0.0001', FEECURRENCY: 'SOL', OUTTXID: 's2' }),
  // Polvere da indirizzo sconosciuto: ignorata.
  row({ DATE: '2025-11-21T11:00:01.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '1e-9', INCURRENCY: 'SOL', INTXID: 's3' }),
  row({ DATE: '2026-05-24T09:00:00.000Z', TYPE: 'unstaked', FROMPORTFOLIO: 'exodus_0', FEEAMOUNT: '-0.0001', FEECURRENCY: 'SOL', INAMOUNT: '0', INCURRENCY: 'SOL', INTXID: 's4' }),
  row({ DATE: '2026-05-25T12:00:00.000Z', TYPE: 'deposit', FROMPORTFOLIO: 'exodus_0', FEEAMOUNT: '-0.0001', FEECURRENCY: 'SOL', INAMOUNT: '0.72', INCURRENCY: 'SOL', INTXID: 's5' }),
  row({ DATE: '2026-05-25T12:10:00.000Z', TYPE: 'withdrawal', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '-0.7196', OUTCURRENCY: 'SOL', FEEAMOUNT: '-0.0001', FEECURRENCY: 'SOL', OUTTXID: 's6' }),
  // BNB Chain: token ricevuto, autorizzazione (importo 0, solo commissione) e scambio LINK → CMC20 nella stessa transazione.
  row({ DATE: '2025-11-25T19:00:00.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '1', INCURRENCY: 'BNB', INTXID: 'b0' }),
  row({ DATE: '2025-11-24T19:24:00.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '3', INCURRENCY: 'LINK', INTXID: 'b1' }),
  row({ DATE: '2025-11-25T19:30:00.000Z', TYPE: 'withdrawal', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '0', OUTCURRENCY: 'BNB', FEEAMOUNT: '-0.00001', FEECURRENCY: 'BNBBSC', OUTTXID: 'b2' }),
  row({ DATE: '2025-11-25T19:31:18.077Z', TYPE: 'withdrawal', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '-3', OUTCURRENCY: 'LINK', FEEAMOUNT: '-0.00002', FEECURRENCY: 'BNBBSC', OUTTXID: 'b3' }),
  row({ DATE: '2025-11-25T19:31:18.077Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '0.2', INCURRENCY: 'CMC20', INTXID: 'b3' }),
  // Invio con commissione nella stessa moneta.
  row({ DATE: '2025-11-25T20:00:00.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '20', INCURRENCY: 'XRP', INTXID: 'x1' }),
  row({ DATE: '2025-11-25T20:05:00.000Z', TYPE: 'withdrawal', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '-19', OUTCURRENCY: 'XRP', FEEAMOUNT: '-0.005', FEECURRENCY: 'XRP', OUTTXID: 'x2' }),
  // Storico incompleto: esce più TRX di quanto sia entrato.
  row({ DATE: '2026-04-17T18:00:00.000Z', TYPE: 'deposit', TOPORTFOLIO: 'exodus_0', INAMOUNT: '5', INCURRENCY: 'TRX', INTXID: 't1' }),
  row({ DATE: '2026-04-27T19:00:00.000Z', TYPE: 'withdrawal', FROMPORTFOLIO: 'exodus_0', OUTAMOUNT: '-400', OUTCURRENCY: 'TRX', OUTTXID: 't2' }),
].join('\n');

const sheets = (): Sheet[] => {
  const wb = XLSX.read(CSV, { type: 'string', raw: true });
  return [{ name: 'x', rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: false }) }];
};
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };
const table = { SOL: { '2025-01-01': 150 }, BNB: { '2025-01-01': 800 }, LINK: { '2025-01-01': 12, '2025-11-25': 10 }, XRP: { '2025-01-01': 2 }, TRX: { '2025-01-01': 0.25 } };

describe('import Exodus', () => {
  it('riconosce il formato e normalizza i ticker con la rete', () => {
    expect(detectImporter(sheets())?.id).toBe('exodus');
    expect(exodusSymbol('BNBBSC')).toBe('BNB');
    expect(exodusSymbol('USDTTRX')).toBe('USDT');
    expect(exodusSymbol('WBTC')).toBe('WBTC');
    expect(exodusSymbol('ETH')).toBe('ETH');
  });

  it('interpreta trasferimenti, scambi, autorizzazioni, staking e polvere', () => {
    const r = exodus.parse(sheets(), opts);
    const by = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(by['exodus:b3:LINK']).toMatchObject({ type: 'vendita', quantity: 3, pair: 'exodus:b3' });
    expect(by['exodus:b3:CMC20']).toMatchObject({ type: 'acquisto', quantity: 0.2, pair: 'exodus:b3' });
    expect(by['exodus:b3:gas']).toMatchObject({ type: 'trasf_uscita', assetKey: 'crypto:BNB', quantity: 0.00002 });
    expect(by['exodus:b2:gas']).toMatchObject({ type: 'trasf_uscita', assetKey: 'crypto:BNB', quantity: 0.00001 });
    expect(by['exodus:x2:XRP']).toMatchObject({ type: 'trasf_uscita', quantity: 19.005 });
    // Staking: solo commissioni; il rientro non è un'entrata, i premi sono ciò che manca per l'invio finale.
    // Saldo: 0,7 − 0,0001×3 = 0,6997; invio 0,7196 + 0,0001 → premi 0,02.
    expect(by['exodus:s5:reward']).toMatchObject({ type: 'dividendo', quantity: 0.02 });
    expect(by['exodus:s5:reward:buy']).toMatchObject({ type: 'acquisto', quantity: 0.02 });
    expect(Object.keys(by).some((k) => k.startsWith('exodus:s3'))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/1 arrivi "polvere"/);
    expect(r.warnings.join(' ')).toMatch(/TRX: nel file mancano entrate per 395 TRX prima del 27\/04\/2026/);
    expect(r.warnings.join(' ')).toMatch(/Premi di staking SOL stimati in 0.02/);
  });

  it('con i prezzi del giorno: scambio valorizzato, premi come proventi, saldi giusti', () => {
    const raw = exodus.parse(sheets(), opts);
    expect(priceRequest(raw)).toEqual({ symbols: expect.arrayContaining(['SOL', 'BNB', 'LINK', 'CMC20', 'XRP', 'TRX']), from: '2025-11-21' });
    const r = fillPrices(raw, table);
    const by = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(by['exodus:b3:LINK'].price).toBe(10);
    // CMC20 non ha prezzo di mercato, ma il suo costo è il valore dei LINK dati in cambio.
    expect(by['exodus:b3:CMC20'].price! * 0.2).toBeCloseTo(30);
    expect(by['exodus:s5:reward'].amount).toBe(3);
    expect(r.warnings.join(' ')).toMatch(/Nessun prezzo di mercato per CMC20/);

    const { data } = mergeSync(emptyData(), { id: 'file:exodus', label: 'Exodus' }, r, '2026-09-25');
    const p = computePortfolio(data);
    const pos = (s: string) => p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.symbol === s)!;
    expect(pos('SOL').quantity).toBeCloseTo(0, 9);
    expect(pos('LINK').quantity).toBe(0);
    expect(pos('CMC20')).toMatchObject({ quantity: 0.2 });
    expect(pos('CMC20').cost).toBeCloseTo(30);
    expect(pos('BNB').quantity).toBeCloseTo(1 - 0.00003, 9);
    expect(pos('XRP').quantity).toBeCloseTo(0.995, 9);
    // LINK entrati il 24/11 a 12 € (valore del giorno) e scambiati il 25/11 a 10 €: minusvalenza di 6 €.
    expect(pos('LINK').realized).toBeCloseTo(-6);
    expect(p.summary.income).toBeCloseTo(3);
  });
});
