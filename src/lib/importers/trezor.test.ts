import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { trezor } from './trezor';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { findTransfers } from '../transfers';
import { emptyData } from '../types';

// Stessa struttura degli export di Trezor Suite, con indirizzi e transazioni inventati.
const HEAD = 'Timestamp,Date,Time,Type,Transaction ID,Fee,Fee unit,Address,Label,Amount,Amount unit,Fiat (EUR),Other';
const ETH_CSV = [
  HEAD,
  // Token regalato senza valore e NFT: ignorati.
  '1771987559,25/02/2026,03:45:59 GMT+1,RECV,0xaaa1,,,0x1111111111111111111111111111111111111111,,0.001,Yf-DAI,0,',
  '1771987559,25/02/2026,03:45:59 GMT+1,RECV,0xaaa1,,,0x1111111111111111111111111111111111111111,,ID 0,EverStake,,',
  // Invio mostrato su due righe (stessa transazione, due indirizzi): conta una volta, con la commissione.
  '1765474547,11/12/2025,18:35:47 GMT+1,SENT,0xaaa2,0.000021361345670485,ETH,0x2222222222222222222222222222222222222222,,0.10123539,ETH,279.05,',
  '1765474547,11/12/2025,18:35:47 GMT+1,SENT,0xaaa2,,,0x3333333333333333333333333333333333333333,,0.10123539,ETH,279.05,',
  // Ricezioni dello stesso giorno, prima dell'invio (il file va dal più recente al più vecchio).
  '1765473755,11/12/2025,18:22:35 GMT+1,RECV,0xaaa3,,,0x1111111111111111111111111111111111111111,,0.00289705,ETH,7.99,',
  '1765473455,11/12/2025,18:17:35 GMT+1,RECV,0xaaa4,,,0x1111111111111111111111111111111111111111,,0.10153834,ETH,279.89,',
  '1765473311,11/12/2025,18:15:11 GMT+1,RECV,0xaaa5,,,0x1111111111111111111111111111111111111111,,0.0018,ETH,4.96,',
  // Invio di un token: la commissione in ETH è un'uscita a parte.
  '1768000000,10/01/2026,00:06:40 GMT+1,SENT,0xaaa6,0.00001,ETH,0x4444444444444444444444444444444444444444,,10,USDC,8.6,',
  '1767900000,08/01/2026,20:20:00 GMT+1,RECV,0xaaa7,,,0x1111111111111111111111111111111111111111,,10,USDC,8.6,',
].join('\n');
const BTC_CSV = [
  HEAD,
  '1767384826,02/01/2026,21:13:46 GMT+1,RECV,b1,,,bc1qexampleexampleexampleexampleexample0,,0.00646626,BTC,495.89,',
  '1763755074,21/11/2025,20:57:54 GMT+1,RECV,b2,,,bc1qexampleexampleexampleexampleexample0,,0.00773805,BTC,571.52,',
  // Invio a due destinatari: su Bitcoin le righe si sommano.
  '1768100000,11/01/2026,03:53:20 GMT+1,SENT,b3,0.00001,BTC,bc1qdest1,,0.002,BTC,160,',
  '1768100000,11/01/2026,03:53:20 GMT+1,SENT,b3,,,bc1qdest2,,0.001,BTC,80,',
].join('\n');

const read = (csv: string, name: string): Sheet[] => {
  const wb = XLSX.read(csv, { type: 'string', raw: true });
  return wb.SheetNames.map(() => ({ name, rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '', blankrows: false }) }));
};
const sheets = () => [...read(ETH_CSV, 'Ethereum #1'), ...read(BTC_CSV, 'Bitcoin #1')];
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };

describe('import Trezor Suite', () => {
  it('riconosce il formato e unisce i file dei diversi account', () => {
    expect(detectImporter(read(ETH_CSV, 'x'))?.id).toBe('trezor');
    expect(trezor.multiFile).toBe(true);
  });

  it('entrate e uscite sono trasferimenti interni, con valore in euro del momento', () => {
    const r = trezor.parse(sheets(), opts);
    const by = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(by['trezor:0xaaa2:ETH']).toMatchObject({ type: 'trasf_uscita', quantity: 0.10125675 });
    expect(by['trezor:0xaaa2:ETH'].price).toBeCloseTo(279.05 / 0.10123539);
    expect(by['trezor:0xaaa4:ETH']).toMatchObject({ type: 'trasf_entrata', quantity: 0.10153834, date: '2025-12-11' });
    expect(by['trezor:0xaaa6:USDC']).toMatchObject({ type: 'trasf_uscita', quantity: 10 });
    expect(by['trezor:0xaaa6:gas']).toMatchObject({ type: 'trasf_uscita', quantity: 0.00001, assetKey: 'crypto:ETH' });
    expect(by['trezor:b3:BTC']).toMatchObject({ type: 'trasf_uscita', quantity: 0.00301 });
    expect(Object.keys(by).some((k) => k.includes('aaa1'))).toBe(false);
    expect(r.warnings.join(' ')).toMatch(/1 token senza valore ignorati .*YF-DAI/);
    expect(r.warnings.join(' ')).toMatch(/1 NFT ignorati/);
  });

  it('calcola i saldi giusti, senza plusvalenze e senza vendite scoperte', () => {
    const r = trezor.parse(sheets(), opts);
    const { data } = mergeSync(emptyData(), { id: 'file:trezor', label: 'Trezor' }, r, '2026-09-25');
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    const qty = (s: string) => p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.symbol === s)?.quantity ?? 0;
    // 0,10623539 ricevuti − 0,10123539 inviati − commissioni (0,0000213… + 0,00001 per il token).
    expect(qty('ETH')).toBeCloseTo(0.10623539 - 0.10123539 - 0.000021361345670485 - 0.00001, 8);
    expect(qty('BTC')).toBeCloseTo(0.00646626 + 0.00773805 - 0.00301, 8);
    expect(qty('USDC')).toBe(0);
    expect(p.summary.realized).toBe(0);
    expect(p.cash[0].cash).toBe(0);
    // Senza gli altri conti, entrate e uscite restano senza controparte; le commissioni di rete non contano.
    const unmatched = findTransfers(data).unmatched.map((t) => t.externalId!);
    expect(unmatched).toHaveLength(9);
    expect(unmatched.some((id) => id.endsWith(':gas'))).toBe(false);
  });

  it('lo stesso file trascinato due volte non raddoppia le quantità', () => {
    const r = trezor.parse([...sheets(), ...read(BTC_CSV, 'Bitcoin #1 (copia)')], opts);
    expect(r.transactions.find((t) => t.externalId === 'trezor:b3:BTC')?.quantity).toBe(0.00301);
    expect(r.transactions.find((t) => t.externalId === 'trezor:b1:BTC')?.quantity).toBe(0.00646626);
  });

  it('reimportare gli stessi file non crea doppioni', () => {
    const first = mergeSync(emptyData(), { id: 'file:trezor', label: 'Trezor' }, trezor.parse(sheets(), opts), '2026-09-25').data;
    const again = mergeSync(first, { id: 'file:trezor', label: 'Trezor' }, trezor.parse(sheets(), opts), '2026-09-26');
    expect(again.stats).toMatchObject({ added: 0, updated: 0 });
  });
});

describe('coda dei file da importare', () => {
  it('unire più file dello stesso formato non modifica gli oggetti ricevuti (React può ripetere l\'operazione)', async () => {
    const { enqueue } = await import('../../components/FileImport');
    const a = { files: [new File(['x'], 'eth.csv')], importer: trezor, sheets: read(ETH_CSV, 'eth') };
    const b = { files: [new File(['y'], 'btc.csv')], importer: trezor, sheets: read(BTC_CSV, 'btc') };
    const once = enqueue([], [a, b]);
    const twice = enqueue([], [a, b]);
    expect(once).toHaveLength(1);
    expect(once[0].files.map((f) => f.name)).toEqual(['eth.csv', 'btc.csv']);
    expect(twice[0].files.map((f) => f.name)).toEqual(['eth.csv', 'btc.csv']);
    expect(a.files).toHaveLength(1);
  });
});
