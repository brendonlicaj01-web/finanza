import { describe, expect, it } from 'vitest';
import * as XLSX from '@e965/xlsx';
import { detectImporter, type Sheet } from './index';
import { okx } from './okx';
import { OKX_FUNDING, OKX_TRADING } from './okx.fixtures';
import { mergeSync } from '../sync';
import { computePortfolio } from '../portfolio';
import { emptyData } from '../types';

const read = (csv: string): Sheet[] => {
  const wb = XLSX.read(csv, { type: 'string', raw: true });
  return wb.SheetNames.map((name) => ({
    name,
    rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, raw: true, defval: '', blankrows: false }),
  }));
};
const opts = { balanceCash: false, existingIds: new Set<string>(), knownSymbols: [] as string[] };
const trading = read(OKX_TRADING);
const funding = read(OKX_FUNDING);

describe('import OKX', () => {
  it('riconosce entrambi i file come OKX e li unisce', () => {
    expect(detectImporter(trading)?.id).toBe('okx');
    expect(detectImporter(funding)?.id).toBe('okx');
    expect(okx.multiFile).toBe(true);
  });

  it('mantiene gli id a 19 cifre senza arrotondarli', () => {
    const r = okx.parse([...trading, ...funding], opts);
    const ids = r.transactions.map((t) => t.externalId);
    expect(ids).toContain('okx:order:3713039297183260672:BTC');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('aggrega le esecuzioni di un ordine e valorizza in EUR', () => {
    const r = okx.parse([...trading, ...funding], opts);
    const btc = r.transactions.find((t) => t.externalId === 'okx:order:3713039297183260672:BTC')!;
    expect(btc).toMatchObject({ type: 'acquisto', date: '2026-07-04', quantity: 0.00274442, price: 54612.4 });
    expect(btc.fees).toBeCloseTo(0.12, 2);
    const usdc = r.transactions.find((t) => t.externalId === 'okx:order:3719858049002545152:USDC')!;
    expect(usdc).toMatchObject({ type: 'acquisto', quantity: 400.228702, price: 0.8744 });
  });

  it('ignora i movimenti interni e ricostruisce i saldi reali', () => {
    const r = okx.parse([...trading, ...funding], opts);
    expect(r.transactions.some((t) => /unified|Stake/i.test(t.note ?? '') && !/Reinvestito|OKX:/.test(t.note ?? ''))).toBe(false);
    const { data, stats } = mergeSync(emptyData(), { id: 'file:okx', label: 'OKX' }, r, '2026-09-24');
    expect(stats.adjustments).toBe(0);
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    const qty = (sym: string) =>
      p.positions.find((x) => data.assets.find((a) => a.id === x.assetId)?.symbol === sym)?.quantity ?? 0;
    expect(qty('BTC')).toBeCloseTo(0.01176042, 8);
    expect(qty('TRX')).toBeCloseTo(591.358718 + 2.25591841, 5);
    expect(qty('SOL')).toBeGreaterThan(1.7676); // OKSOL contato come SOL
    expect(qty('OKSOL')).toBe(0);
    expect(qty('BNB')).toBeCloseTo(0.16205158, 8);
    expect(qty('USDC')).toBeCloseTo(1159.8957, 3);
    expect(p.cash[0].cash).toBeCloseTo(0.04, 1);
    expect(r.cash).toBe(0.04);
  });

  it('i rendimenti sono proventi, e le monete entrano a quel valore', () => {
    const r = okx.parse([...trading, ...funding], opts);
    const yieldTx = r.transactions.find((t) => t.externalId === 'okx:f:200047116058')!;
    expect(yieldTx).toMatchObject({ type: 'dividendo', assetKey: 'crypto:TRX', date: '2026-08-20' });
    expect(yieldTx.amount).toBeCloseTo(0.02788886, 8);
    expect(r.transactions.find((t) => t.externalId === 'okx:f:200047116058:buy')).toMatchObject({
      type: 'acquisto',
      quantity: 0.09681831,
    });
  });

  it('con un solo file avvisa e non allinea la liquidità', () => {
    const r = okx.parse(trading, opts);
    expect(r.cash).toBeUndefined();
    expect(r.warnings.join(' ')).toMatch(/Manca il file Funding/);
  });

  it('reimportare i file non crea doppioni', () => {
    const first = mergeSync(emptyData(), { id: 'file:okx', label: 'OKX' }, okx.parse([...trading, ...funding], opts), '2026-09-24');
    const again = mergeSync(first.data, { id: 'file:okx', label: 'OKX' }, okx.parse([...funding, ...trading], opts), '2026-09-25');
    expect(again.stats).toMatchObject({ added: 0, adjustments: 0 });
  });
});
