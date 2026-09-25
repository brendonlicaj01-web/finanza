import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Sincronizzazione completa di un wallet con le risposte delle API simulate (nessuna richiesta vera):
 * indirizzo Bitcoin + indirizzo EVM, prezzi da Binance, cache su disco in una cartella temporanea.
 */

const BTC = 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu';
const EVM = '0x1111111111111111111111111111111111111111';
const t = (iso: string) => Date.parse(iso) / 1000;

const responses: [RegExp, unknown][] = [
  [/mempool\.space\/api\/address\/bc1q[^/]+$/, { chain_stats: { funded_txo_sum: 5_000_000, spent_txo_sum: 0, tx_count: 1 } }],
  [/mempool\.space\/api\/address\/bc1q.+\/txs\/chain$/, [
    { txid: 'btc1', fee: 200, status: { confirmed: true, block_time: t('2025-03-01T10:00:00Z') }, vin: [{ prevout: { scriptpubkey_address: 'bc1qother', value: 5_100_000 } }], vout: [{ scriptpubkey_address: BTC, value: 5_000_000 }] },
  ]],
  // Base: movimenti; le altre reti con esploratore: vuote.
  [/base\.blockscout\.com\/api\?.*action=txlist&/, { status: '1', message: 'OK', result: [
    { hash: '0xb1', timeStamp: String(t('2025-04-01T10:00:00Z')), from: '0x9999999999999999999999999999999999999999', to: EVM, value: '500000000000000000', isError: '0' },
  ] }],
  [/base\.blockscout\.com\/api\?.*action=balance/, { status: '1', message: 'OK', result: '500000000000000000' }],
  [/base\.blockscout\.com\/api\?.*action=tokenlist/, { status: '1', message: 'OK', result: [] }],
  [/blockscout\.com\/api\?/, { status: '0', message: 'No transactions found', result: [] }],
  // Nodi RPC delle reti senza esploratore gratuito: saldo zero.
  [/./, { jsonrpc: '2.0', id: 1, result: '0x0' }],
];
const binance: Record<string, number> = { BTCEUR: 80000, ETHEUR: 2000 };

let home: string;
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'finanza-wallet-'));
  vi.stubEnv('FINANZA_HOME', home);
  vi.stubGlobal('fetch', async (input: string | URL) => {
    const url = String(input);
    const k = url.match(/api\.binance\.com\/api\/v3\/klines\?symbol=(\w+)/);
    if (k) {
      if (!binance[k[1]]) return new Response(JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }), { status: 400 });
      const start = Date.parse('2025-01-01T00:00:00Z');
      const rows = Array.from({ length: 200 }, (_, i) => [start + i * 86_400_000, '0', '0', '0', String(binance[k[1]] + i)]);
      return new Response(JSON.stringify(rows));
    }
    if (url.includes('cryptocompare')) return new Response(JSON.stringify({ Response: 'Error', Data: {} }));
    const hit = responses.find(([re]) => re.test(url));
    return new Response(JSON.stringify(hit ? hit[1] : {}), { status: hit ? 200 : 404 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

describe('sincronizzazione di un wallet', () => {
  it('legge Bitcoin ed EVM, valorizza al prezzo del giorno e salva i prezzi in cache', async () => {
    vi.resetModules();
    const { wallet } = await import('./index.ts');
    await expect(wallet.test({ addresses: 'frase segreta' })).rejects.toThrow(/non riconosciuti/);
    const r = await wallet.sync({ addresses: `Ledger ${BTC}\nMetaMask ${EVM}` }, { currency: 'EUR' });

    expect(r.transactions.map((x) => [x.externalId, x.type, x.quantity, Math.round(x.price!)])).toEqual([
      [`wallet:bitcoin:btc1:BTC`, 'trasf_entrata', 0.05, 80000 + 59], // 1° marzo = giorno 59
      [`wallet:base:0xb1:ETH`, 'trasf_entrata', 0.5, 2000 + 90],
    ]);
    expect(r.holdings).toEqual([
      { assetKey: 'crypto:BTC', quantity: 0.05 },
      { assetKey: 'crypto:ETH', quantity: 0.5 },
    ]);
    expect(r.warnings.join(' ')).toMatch(/Reti EVM con movimenti: Base/);
    expect(r.warnings.join(' ')).not.toMatch(/Non letto/);

    const cache = JSON.parse(await readFile(join(home, 'cache', 'prices.json'), 'utf8'));
    expect(Object.keys(cache).sort()).toEqual(['BTC', 'ETH']);
  });
});
