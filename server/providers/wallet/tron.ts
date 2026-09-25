import { createBase58check } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { fromUnits, getJson } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';
import { isSpamToken } from './evm.ts';

/** Tron tramite TronGrid (API pubblica): TRX e token TRC-20 (USDT in primis). */

const API = 'https://api.trongrid.io';
const b58c = createBase58check(sha256);
/** Contratti TRC-20 ufficiali delle monete più imitate su Tron. */
const OFFICIAL: Record<string, string[]> = { USDT: ['TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'] };

/** Indirizzo Tron in formato esadecimale (41…), usato nelle transazioni TRX. */
export function tronHex(address: string): string {
  return Array.from(b58c.decode(address), (b) => b.toString(16).padStart(2, '0')).join('');
}

interface TrxTx {
  txID: string;
  block_timestamp: number;
  ret?: { contractRet?: string; fee?: number }[];
  raw_data?: { contract?: { type?: string; parameter?: { value?: { amount?: number; owner_address?: string; to_address?: string } } }[] };
}
interface Trc20Tx {
  transaction_id: string;
  block_timestamp: number;
  from: string;
  to: string;
  value: string;
  type?: string;
  token_info?: { symbol?: string; name?: string; address?: string; decimals?: number };
}

export function tronMovements(address: string, trx: TrxTx[], trc20: Trc20Tx[], skipped: Set<string>): Movement[] {
  const me = tronHex(address).toLowerCase();
  const out: Movement[] = [];
  for (const t of trx) {
    const c = t.raw_data?.contract?.[0];
    const v = c?.parameter?.value ?? {};
    const mine = (v.owner_address ?? '').toLowerCase() === me;
    const fee = mine ? (t.ret?.[0]?.fee ?? 0) / 1e6 : 0;
    const ok = (t.ret?.[0]?.contractRet ?? 'SUCCESS') === 'SUCCESS';
    let amount = 0;
    if (ok && c?.type === 'TransferContract') {
      if ((v.to_address ?? '').toLowerCase() === me) amount += (v.amount ?? 0) / 1e6;
      if (mine) amount -= (v.amount ?? 0) / 1e6;
    }
    if (amount || fee) out.push({ chain: 'tron', hash: t.txID, time: t.block_timestamp, symbol: 'TRX', amount, fee: fee || undefined });
  }
  for (const t of trc20) {
    const info = t.token_info ?? {};
    const symbol = (info.symbol ?? '').trim();
    const contract = info.address ?? '';
    const official = OFFICIAL[symbol.toUpperCase()];
    if (isSpamToken('tron', symbol, info.name ?? '', contract) || (official && !official.includes(contract))) {
      skipped.add(symbol || contract);
      continue;
    }
    const value = fromUnits(t.value, info.decimals ?? 0);
    if (!value) continue;
    const amount = (t.to === address ? value : 0) - (t.from === address ? value : 0);
    if (amount) out.push({ chain: 'tron', hash: t.transaction_id, time: t.block_timestamp, symbol: symbol.toUpperCase(), amount });
  }
  return out;
}

async function pages<T>(url: string, get: typeof getJson): Promise<T[]> {
  const all: T[] = [];
  let fingerprint = '';
  for (let i = 0; i < 100; i++) {
    const r = await get<{ data?: T[]; meta?: { fingerprint?: string } }>(`${url}${fingerprint ? `&fingerprint=${encodeURIComponent(fingerprint)}` : ''}`, { label: 'TronGrid' });
    all.push(...(r.data ?? []));
    fingerprint = r.meta?.fingerprint ?? '';
    if (!fingerprint || !r.data?.length) break;
  }
  return all;
}

export async function readTron(addresses: string[], get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  const skipped = new Set<string>();
  for (const address of addresses) {
    const acc = await get<{ data?: { balance?: number; trc20?: Record<string, string>[] }[] }>(`${API}/v1/accounts/${address}`, { label: 'TronGrid' });
    const info = acc.data?.[0];
    addBalance(data.balances, 'TRX', (info?.balance ?? 0) / 1e6);
    const trx = await pages<TrxTx>(`${API}/v1/accounts/${address}/transactions?only_confirmed=true&limit=200`, get);
    const trc20 = await pages<Trc20Tx>(`${API}/v1/accounts/${address}/transactions/trc20?only_confirmed=true&limit=200`, get);
    data.movements.push(...tronMovements(address, trx, trc20, skipped));
    // Saldi TRC-20: dal conto, con simbolo e decimali presi dallo storico (i contratti mai visti sono ignorati).
    const known = new Map(trc20.map((t) => [t.token_info?.address ?? '', t.token_info]));
    for (const entry of info?.trc20 ?? []) {
      for (const [contract, raw] of Object.entries(entry)) {
        const t = known.get(contract);
        if (!t?.symbol) continue;
        const official = OFFICIAL[t.symbol.toUpperCase()];
        if (isSpamToken('tron', t.symbol, t.name ?? '', contract) || (official && !official.includes(contract))) continue;
        addBalance(data.balances, t.symbol.toUpperCase(), fromUnits(raw, t.decimals ?? 0));
      }
    }
  }
  if (skipped.size) data.warnings.push(`Tron: ${skipped.size} token sospetti ignorati (${[...skipped].slice(0, 6).join(', ')}).`);
  return data;
}
