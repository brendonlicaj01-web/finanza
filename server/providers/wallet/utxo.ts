import { HDKey } from '@scure/bip32';
import { bech32, createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { getJson, pool } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';

/**
 * Reti a UTXO: Bitcoin e Litecoin (API "Esplora" di mempool.space / litecoinspace.org), Dogecoin (BlockCypher).
 * Per Bitcoin si accettano anche chiavi pubbliche estese (xpub/ypub/zpub): gli indirizzi vengono derivati qui,
 * senza inviare la chiave a nessun servizio.
 */

export type Get = <T>(url: string) => Promise<T>;
const defaultGet: Get = (url) => getJson(url);

const b58c = createBase58check(sha256);
const hash160 = (b: Uint8Array) => ripemd160(sha256(b));
const SATS = 1e8;

interface EsploraTx {
  txid: string;
  fee?: number;
  status?: { confirmed?: boolean; block_time?: number };
  vin: { prevout?: { scriptpubkey_address?: string; value?: number } | null }[];
  vout: { scriptpubkey_address?: string; value?: number }[];
}
interface EsploraStats {
  chain_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
  mempool_stats?: { funded_txo_sum?: number; spent_txo_sum?: number; tx_count?: number };
}

export const ESPLORA = {
  bitcoin: { base: 'https://mempool.space/api', symbol: 'BTC', label: 'mempool.space' },
  litecoin: { base: 'https://litecoinspace.org/api', symbol: 'LTC', label: 'litecoinspace.org' },
} as const;

/** Movimenti di un insieme di indirizzi dello stesso utente: conta solo ciò che entra ed esce dall'insieme. */
export function esploraMovements(chain: string, symbol: string, txs: EsploraTx[], own: Set<string>): Movement[] {
  const out: Movement[] = [];
  const seen = new Set<string>();
  for (const tx of txs) {
    if (seen.has(tx.txid) || !tx.status?.confirmed) continue;
    seen.add(tx.txid);
    let spent = 0;
    let received = 0;
    let ownInputs = 0;
    for (const i of tx.vin) {
      if (i.prevout?.scriptpubkey_address && own.has(i.prevout.scriptpubkey_address)) {
        spent += i.prevout.value ?? 0;
        ownInputs++;
      }
    }
    for (const o of tx.vout) if (o.scriptpubkey_address && own.has(o.scriptpubkey_address)) received += o.value ?? 0;
    // Se gli input sono nostri, la commissione l'abbiamo pagata noi.
    const fee = ownInputs && ownInputs === tx.vin.length ? (tx.fee ?? 0) : 0;
    const net = received - spent + fee;
    if (!net && !fee) continue;
    out.push({
      chain,
      hash: tx.txid,
      time: (tx.status.block_time ?? 0) * 1000,
      symbol,
      amount: net / SATS,
      fee: fee ? fee / SATS : undefined,
    });
  }
  return out;
}

async function esploraAddressTxs(base: string, address: string, get: Get): Promise<EsploraTx[]> {
  const all: EsploraTx[] = [];
  let last = '';
  for (let page = 0; page < 400; page++) {
    const txs = await get<EsploraTx[]>(`${base}/address/${address}/txs/chain${last ? `/${last}` : ''}`);
    if (!Array.isArray(txs) || !txs.length) break;
    all.push(...txs);
    if (txs.length < 25) break;
    last = txs[txs.length - 1].txid;
  }
  return all;
}

const statsBalance = (s: EsploraStats) =>
  (s.chain_stats?.funded_txo_sum ?? 0) - (s.chain_stats?.spent_txo_sum ?? 0);
const statsCount = (s: EsploraStats) => (s.chain_stats?.tx_count ?? 0) + (s.mempool_stats?.tx_count ?? 0);

export async function readEsplora(
  kind: keyof typeof ESPLORA,
  addresses: string[],
  get: Get = defaultGet,
): Promise<ChainData> {
  const { base, symbol } = ESPLORA[kind];
  const data = emptyChainData();
  const own = new Set(addresses);
  const txs: EsploraTx[] = [];
  let balance = 0;
  await pool(addresses, 3, async (address) => {
    const stats = await get<EsploraStats>(`${base}/address/${address}`);
    balance += statsBalance(stats);
    if (statsCount(stats)) txs.push(...(await esploraAddressTxs(base, address, get)));
  });
  data.movements = esploraMovements(kind, symbol, txs, own);
  addBalance(data.balances, symbol, balance / SATS);
  return data;
}

// ---------- Chiavi pubbliche estese (xpub / ypub / zpub) ----------

type Script = 'p2pkh' | 'p2sh-p2wpkh' | 'p2wpkh';
const XPUB_VERSION = new Uint8Array([0x04, 0x88, 0xb2, 0x1e]);

function addressOf(pub: Uint8Array, script: Script): string {
  const h = hash160(pub);
  if (script === 'p2wpkh') return bech32.encode('bc', [0, ...bech32.toWords(h)]);
  if (script === 'p2sh-p2wpkh') {
    const redeem = new Uint8Array([0x00, 0x14, ...h]);
    return b58c.encode(new Uint8Array([0x05, ...hash160(redeem)]));
  }
  return b58c.encode(new Uint8Array([0x00, ...h]));
}

/** Tipi di indirizzo da provare: la ypub/zpub lo dichiara, la xpub può essere usata per tutti. */
export function scriptsFor(extended: string): Script[] {
  if (extended.startsWith('zpub')) return ['p2wpkh'];
  if (extended.startsWith('ypub')) return ['p2sh-p2wpkh'];
  return ['p2wpkh', 'p2pkh', 'p2sh-p2wpkh'];
}

/** Indirizzo `index` della catena `change` (0 = ricezione, 1 = resto). */
export function deriveAddress(extended: string, script: Script, change: 0 | 1, index: number): string {
  const raw = b58c.decode(extended);
  const normalized = new Uint8Array(raw);
  normalized.set(XPUB_VERSION, 0);
  const node = HDKey.fromExtendedKey(b58c.encode(normalized)).deriveChild(change).deriveChild(index);
  return addressOf(node.publicKey!, script);
}

const GAP = 20;

/** Trova gli indirizzi usati di una chiave estesa (limite di 20 indirizzi vuoti consecutivi, come i wallet). */
export async function usedAddresses(extended: string, get: Get = defaultGet): Promise<string[]> {
  const used: string[] = [];
  for (const script of scriptsFor(extended)) {
    const before = used.length;
    for (const change of [0, 1] as const) {
      let empty = 0;
      for (let start = 0; empty < GAP && start < 5000; start += GAP) {
        const batch = Array.from({ length: GAP }, (_, k) => deriveAddress(extended, script, change, start + k));
        const counts = new Map<string, number>();
        await pool(batch, 4, async (a) => {
          counts.set(a, statsCount(await get<EsploraStats>(`${ESPLORA.bitcoin.base}/address/${a}`)));
        });
        for (const a of batch) {
          if (counts.get(a)) {
            used.push(a);
            empty = 0;
          } else empty++;
        }
      }
      // Una xpub senza alcun indirizzo di ricezione usato con questo tipo: inutile controllare il resto.
      if (change === 0 && used.length === before && scriptsFor(extended).length > 1) break;
    }
  }
  return used;
}

// ---------- Dogecoin (BlockCypher) ----------

interface CypherTx {
  hash: string;
  confirmed?: string;
  block_height?: number;
  fees?: number;
  inputs: { addresses?: string[]; output_value?: number }[];
  outputs: { addresses?: string[]; value?: number }[];
}

export function cypherMovements(chain: string, symbol: string, txs: CypherTx[], own: Set<string>): Movement[] {
  // Stessa logica degli UTXO: trasformiamo nel formato Esplora.
  return esploraMovements(
    chain,
    symbol,
    txs
      .filter((t) => (t.block_height ?? -1) > 0)
      .map((t) => ({
        txid: t.hash,
        fee: t.fees,
        status: { confirmed: true, block_time: Math.floor(Date.parse(t.confirmed ?? '') / 1000) },
        vin: t.inputs.map((i) => ({ prevout: { scriptpubkey_address: i.addresses?.[0], value: i.output_value } })),
        vout: t.outputs.map((o) => ({ scriptpubkey_address: o.addresses?.[0], value: o.value })),
      })),
    own,
  );
}

export async function readDogecoin(addresses: string[], get: Get = defaultGet): Promise<ChainData> {
  const data = emptyChainData();
  const txs: CypherTx[] = [];
  for (const address of addresses) {
    let before: number | undefined;
    for (let page = 0; page < 100; page++) {
      const r = await get<{ final_balance?: number; balance?: number; txs?: CypherTx[]; hasMore?: boolean }>(
        `https://api.blockcypher.com/v1/doge/main/addrs/${address}/full?limit=50${before ? `&before=${before}` : ''}`,
      );
      if (page === 0) addBalance(data.balances, 'DOGE', (r.final_balance ?? r.balance ?? 0) / SATS);
      const list = r.txs ?? [];
      txs.push(...list);
      if (!r.hasMore || !list.length) break;
      before = Math.min(...list.map((t) => t.block_height ?? Infinity));
    }
  }
  data.movements = cypherMovements('dogecoin', 'DOGE', txs, new Set(addresses));
  return data;
}
