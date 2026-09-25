import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from '../../store.ts';
import { getJson, pool } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';

/**
 * Solana tramite JSON-RPC (nodo pubblico o un RPC personale, es. Helius, per wallet con molte operazioni).
 * Le transazioni lette restano in cache: non cambiano più.
 */

export const SOLANA_RPC = 'https://api.mainnet-beta.solana.com';
const TOKEN_PROGRAMS = ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'];

/** Token più diffusi (mint → simbolo). Gli altri vengono ignorati: su Solana abbondano token senza valore. */
export const SOLANA_MINTS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  So11111111111111111111111111111111111111112: 'SOL',
  mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So: 'MSOL',
  J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn: 'JITOSOL',
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 'JUP',
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 'BONK',
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 'WIF',
  HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3: 'PYTH',
  '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R': 'RAY',
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 'JTO',
  '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs': 'ETH',
  '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh': 'BTC',
  cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij: 'BTC',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
  rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof: 'RENDER',
  hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux: 'HNT',
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 'ORCA',
  '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ': 'W',
  TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6: 'TNSR',
};

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export function makeRpc(url = SOLANA_RPC, get = getJson): Rpc {
  return async <T>(method: string, params: unknown[]) => {
    const r = await get<{ result?: T; error?: { message?: string } }>(url, {
      body: { jsonrpc: '2.0', id: 1, method, params },
      label: 'Solana RPC',
    });
    if (r.error) throw new Error(`Solana RPC: ${r.error.message ?? 'errore'}`);
    return r.result as T;
  };
}

interface TokenBal {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount?: number | null };
}
export interface SolTx {
  blockTime?: number | null;
  meta?: {
    err?: unknown;
    fee?: number;
    preBalances?: number[];
    postBalances?: number[];
    preTokenBalances?: TokenBal[];
    postTokenBalances?: TokenBal[];
  } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: ({ pubkey: string } | string)[] } };
}

const tokenAmount = (b: TokenBal) => Number(b.uiTokenAmount.amount) / 10 ** b.uiTokenAmount.decimals;

/** Variazioni di SOL e token del proprietario in una transazione. */
export function solanaMovements(owner: string, signature: string, tx: SolTx, unknownMints: Set<string>): Movement[] {
  const meta = tx.meta;
  if (!meta) return [];
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey));
  const time = (tx.blockTime ?? 0) * 1000;
  const out: Movement[] = [];
  const i = keys.indexOf(owner);
  const payer = keys[0] === owner;
  const fee = payer ? (meta.fee ?? 0) / 1e9 : 0;
  if (i >= 0) {
    const delta = ((meta.postBalances?.[i] ?? 0) - (meta.preBalances?.[i] ?? 0)) / 1e9;
    const amount = meta.err ? 0 : delta + fee;
    if (Math.abs(amount) > 1e-12 || fee) out.push({ chain: 'solana', hash: signature, time, symbol: 'SOL', amount: Math.abs(amount) > 1e-12 ? amount : 0, fee: fee || undefined });
  }
  if (meta.err) return out;
  const byMint = new Map<string, number>();
  for (const b of meta.postTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) + tokenAmount(b));
  for (const b of meta.preTokenBalances ?? []) if (b.owner === owner) byMint.set(b.mint, (byMint.get(b.mint) ?? 0) - tokenAmount(b));
  for (const [mint, amount] of byMint) {
    if (Math.abs(amount) < 1e-12) continue;
    const symbol = SOLANA_MINTS[mint];
    if (!symbol) {
      unknownMints.add(mint);
      continue;
    }
    // SOL "incartato" (wSOL) è la stessa moneta: si somma al SOL.
    const existing = out.find((m) => m.symbol === symbol);
    if (existing) existing.amount += amount;
    else out.push({ chain: 'solana', hash: signature, time, symbol, amount });
  }
  return out;
}

const CACHE_FILE = join(DATA_DIR, 'cache', 'solana-tx.json');
const MAX_SIGNATURES = 5000;

export async function readSolana(addresses: string[], options: { rpcUrl?: string; rpc?: Rpc; cache?: boolean } = {}): Promise<ChainData> {
  const rpc = options.rpc ?? makeRpc(options.rpcUrl || SOLANA_RPC);
  const data = emptyChainData();
  const useCache = options.cache ?? !options.rpc;
  let cache: Record<string, SolTx> = {};
  if (useCache) cache = await readFile(CACHE_FILE, 'utf8').then(JSON.parse).catch(() => ({}));
  let fetched = 0;
  const unknown = new Set<string>();

  for (const owner of addresses) {
    const bal = await rpc<{ value: number }>('getBalance', [owner]);
    addBalance(data.balances, 'SOL', (bal?.value ?? 0) / 1e9);
    for (const programId of TOKEN_PROGRAMS) {
      const r = await rpc<{ value: { account: { data: { parsed: { info: { mint: string; tokenAmount: { uiAmount: number | null; amount: string; decimals: number } } } } } }[] }>(
        'getTokenAccountsByOwner',
        [owner, { programId }, { encoding: 'jsonParsed' }],
      ).catch(() => ({ value: [] }));
      for (const a of r?.value ?? []) {
        const info = a.account.data.parsed.info;
        const symbol = SOLANA_MINTS[info.mint];
        const amount = Number(info.tokenAmount.amount) / 10 ** info.tokenAmount.decimals;
        if (!amount) continue;
        if (symbol) addBalance(data.balances, symbol, amount);
        else unknown.add(info.mint);
      }
    }

    const signatures: { signature: string; err?: unknown }[] = [];
    let before: string | undefined;
    while (signatures.length < MAX_SIGNATURES) {
      const page = await rpc<{ signature: string; err?: unknown }[]>('getSignaturesForAddress', [owner, { limit: 1000, ...(before ? { before } : {}) }]);
      if (!page?.length) break;
      signatures.push(...page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    if (signatures.length >= MAX_SIGNATURES) {
      data.warnings.push(`Solana: più di ${MAX_SIGNATURES} operazioni per ${owner.slice(0, 6)}…, importate le più recenti (i saldi restano allineati).`);
    }
    await pool(signatures, 3, async ({ signature }) => {
      let tx = cache[signature];
      if (!tx) {
        tx = await rpc<SolTx>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]);
        if (!tx) return;
        // In cache solo ciò che serve.
        cache[signature] = tx = {
          blockTime: tx.blockTime,
          meta: tx.meta && {
            err: tx.meta.err,
            fee: tx.meta.fee,
            preBalances: tx.meta.preBalances,
            postBalances: tx.meta.postBalances,
            preTokenBalances: tx.meta.preTokenBalances,
            postTokenBalances: tx.meta.postTokenBalances,
          },
          transaction: { message: { accountKeys: (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === 'string' ? k : k.pubkey)) } },
        };
        fetched++;
      }
      data.movements.push(...solanaMovements(owner, signature, tx, unknown));
    });
  }
  if (useCache && fetched) {
    await mkdir(join(DATA_DIR, 'cache'), { recursive: true, mode: 0o700 });
    await writeFile(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
  }
  if (unknown.size) data.warnings.push(`Solana: ${unknown.size} token poco diffusi ignorati (spesso senza valore).`);
  return data;
}
