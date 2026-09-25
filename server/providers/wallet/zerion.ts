import { ProviderError } from '../types.ts';
import { getJson } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';

/**
 * Zerion API (chiave gratuita, 3.000 richieste al giorno): con un solo indirizzo restituisce lo storico già
 * interpretato di tutte le reti EVM, di Solana e di Tron — invii, ricezioni, scambi, commissioni — con i valori in
 * euro del momento e i token truffaldini già esclusi.
 */

const API = 'https://api.zerion.io/v1';

type Num = number | string | { float?: number | string; numeric?: string } | null | undefined;
const num = (q: Num): number => {
  if (q === null || q === undefined) return 0;
  if (typeof q === 'object') return Number(q.float ?? q.numeric ?? 0) || 0;
  return Number(q) || 0;
};

interface Fungible {
  symbol?: string;
  name?: string;
}
interface ZTransfer {
  fungible_info?: Fungible | null;
  direction?: 'in' | 'out' | 'self';
  quantity?: Num;
  value?: number | null;
  price?: number | null;
}
export interface ZTransaction {
  id?: string;
  attributes: {
    operation_type?: string;
    hash?: string;
    mined_at?: string;
    sent_from?: string;
    status?: string;
    fee?: { fungible_info?: Fungible | null; quantity?: Num; price?: number | null; value?: number | null } | null;
    transfers?: ZTransfer[];
  };
  relationships?: { chain?: { data?: { id?: string } } };
}
export interface ZPosition {
  attributes: {
    position_type?: string;
    quantity?: Num;
    price?: number | null;
    value?: number | null;
    fungible_info?: Fungible | null;
    flags?: { displayable?: boolean; is_trash?: boolean };
  };
}

const sym = (f?: Fungible | null) => (f?.symbol ?? '').trim().toUpperCase();

/** Movimenti di un indirizzo da una transazione Zerion (valori in euro al momento della transazione). */
export function zerionMovements(address: string, tx: ZTransaction): Movement[] {
  const a = tx.attributes;
  if (!a.hash || !a.mined_at || a.status === 'pending') return [];
  const chain = tx.relationships?.chain?.data?.id ?? 'evm';
  const time = Date.parse(a.mined_at);
  const flows = new Map<string, { amount: number; value: number; qty: number }>();
  if (a.status !== 'failed') {
    for (const t of a.transfers ?? []) {
      const s = sym(t.fungible_info);
      if (!s || t.direction === 'self' || !t.direction) continue; // NFT o movimenti interni al wallet
      const qty = num(t.quantity);
      if (!qty) continue;
      const f = flows.get(s) ?? { amount: 0, value: 0, qty: 0 };
      f.amount += t.direction === 'in' ? qty : -qty;
      const unit = t.price ?? (t.value && qty ? t.value / qty : undefined);
      if (unit) {
        f.value += unit * qty;
        f.qty += qty;
      }
      flows.set(s, f);
    }
  }
  const out: Movement[] = [];
  for (const [symbol, f] of flows) {
    if (Math.abs(f.amount) < 1e-12) continue;
    out.push({ chain, hash: a.hash, time, symbol, amount: f.amount, ...(f.qty ? { price: f.value / f.qty } : {}) });
  }
  // La commissione conta solo se l'ha pagata questo indirizzo.
  const fee = a.fee;
  const payer = (a.sent_from ?? '').toLowerCase() === address.toLowerCase();
  const feeQty = payer ? num(fee?.quantity) : 0;
  if (feeQty) {
    const s = sym(fee?.fungible_info);
    const feePrice = fee?.price ?? (fee?.value ? fee.value / feeQty : undefined);
    const host = out.find((m) => m.symbol === s);
    if (host) host.fee = feeQty;
    else out.push({ chain, hash: a.hash, time, symbol: s, amount: 0, fee: feeQty, ...(feePrice ? { price: feePrice } : {}) });
  }
  return out;
}

function authHeader(key: string) {
  return { Authorization: `Basic ${Buffer.from(`${key.trim()}:`).toString('base64')}` };
}

export async function readZerion(addresses: string[], key: string, get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  const headers = authHeader(key);
  const call = async <T>(url: string) => {
    try {
      return await get<T>(url, { headers, label: 'Zerion' });
    } catch (e) {
      if (/errore 401|errore 403/.test((e as Error).message)) {
        throw new ProviderError('Zerion: chiave API non valida. Controllala su dashboard.zerion.io o lascia il campo vuoto.');
      }
      throw e;
    }
  };
  const chains = new Set<string>();
  for (const address of addresses) {
    let url: string | undefined =
      `${API}/wallets/${address}/transactions/?currency=eur&page[size]=100&filter[trash]=only_non_trash`;
    for (let page = 0; url && page < 500; page++) {
      const r: { data?: ZTransaction[]; links?: { next?: string | null } } = await call(url);
      for (const tx of r.data ?? []) {
        const moves = zerionMovements(address, tx);
        for (const m of moves) chains.add(m.chain);
        data.movements.push(...moves);
      }
      url = r.links?.next ?? undefined;
    }
    const pos = await call<{ data?: ZPosition[] }>(
      `${API}/wallets/${address}/positions/?filter[positions]=only_simple&currency=eur&filter[trash]=only_non_trash`,
    );
    for (const p of pos.data ?? []) {
      const s = sym(p.attributes.fungible_info);
      const qty = num(p.attributes.quantity);
      if (!s || !qty || p.attributes.flags?.is_trash) continue;
      addBalance(data.balances, s, qty);
      const price = p.attributes.price ?? (p.attributes.value ? p.attributes.value / qty : undefined);
      if (price) (data.prices ??= new Map()).set(s, price);
    }
  }
  if (chains.size) data.warnings.push(`Reti con movimenti (Zerion): ${[...chains].sort().join(', ')}.`);
  return data;
}
