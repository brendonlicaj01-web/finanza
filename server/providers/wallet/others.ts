import { getJson } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';

// ---------- XRP Ledger (nodo pubblico) ----------

const XRPL = 'https://xrplcluster.com/';
/** I tempi dell'XRP Ledger partono dal 1° gennaio 2000. */
const RIPPLE_EPOCH = 946_684_800;

interface XrpNode {
  ModifiedNode?: { LedgerEntryType?: string; FinalFields?: { Account?: string; Balance?: string }; PreviousFields?: { Balance?: string } };
  CreatedNode?: { LedgerEntryType?: string; NewFields?: { Account?: string; Balance?: string } };
  DeletedNode?: { LedgerEntryType?: string; FinalFields?: { Account?: string; Balance?: string }; PreviousFields?: { Balance?: string } };
}
export interface XrpTxEntry {
  tx?: { hash?: string; Account?: string; Fee?: string; date?: number };
  tx_json?: { Account?: string; Fee?: string; date?: number };
  hash?: string;
  meta?: { TransactionResult?: string; AffectedNodes?: XrpNode[] } | string;
  validated?: boolean;
}

/** Variazione del saldo XRP del conto, letta dai nodi modificati (vale per pagamenti, scambi, ecc.). */
export function xrpMovements(account: string, entries: XrpTxEntry[]): Movement[] {
  const out: Movement[] = [];
  for (const e of entries) {
    const tx = e.tx ?? e.tx_json ?? {};
    const hash = e.hash ?? (e.tx as { hash?: string })?.hash ?? '';
    if (!hash || typeof e.meta !== 'object' || e.validated === false) continue;
    let drops = 0;
    for (const n of e.meta.AffectedNodes ?? []) {
      const m = n.ModifiedNode ?? n.DeletedNode;
      if (m?.LedgerEntryType === 'AccountRoot' && m.FinalFields?.Account === account && m.PreviousFields?.Balance !== undefined) {
        drops += Number(m.FinalFields.Balance ?? 0) - Number(m.PreviousFields.Balance);
      }
      const c = n.CreatedNode;
      if (c?.LedgerEntryType === 'AccountRoot' && c.NewFields?.Account === account) drops += Number(c.NewFields.Balance ?? 0);
    }
    const fee = tx.Account === account ? Number(tx.Fee ?? 0) : 0;
    const amount = (drops + fee) / 1e6;
    if (!amount && !fee) continue;
    out.push({ chain: 'xrp', hash, time: ((tx.date ?? 0) + RIPPLE_EPOCH) * 1000, symbol: 'XRP', amount, fee: fee ? fee / 1e6 : undefined });
  }
  return out;
}

export async function readXrp(addresses: string[], get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  const rpc = <T>(method: string, params: Record<string, unknown>) =>
    get<{ result: T & { status?: string; error?: string } }>(XRPL, { body: { method, params: [params] }, label: 'XRP Ledger' }).then((r) => r.result);
  for (const account of addresses) {
    const info = await rpc<{ account_data?: { Balance?: string } }>('account_info', { account, ledger_index: 'validated' });
    if (info.error === 'actNotFound') continue;
    addBalance(data.balances, 'XRP', Number(info.account_data?.Balance ?? 0) / 1e6);
    let marker: unknown;
    for (let i = 0; i < 200; i++) {
      const r = await rpc<{ transactions?: XrpTxEntry[]; marker?: unknown }>('account_tx', {
        account,
        ledger_index_min: -1,
        ledger_index_max: -1,
        limit: 400,
        forward: true,
        ...(marker ? { marker } : {}),
      });
      data.movements.push(...xrpMovements(account, r.transactions ?? []));
      marker = r.marker;
      if (!marker) break;
    }
  }
  return data;
}

// ---------- Reti di cui si legge solo il saldo ----------

/** Cardano (Koios): saldo complessivo del conto di staking (tutti gli indirizzi del wallet). */
export async function readCardano(addresses: string[], get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  const stakes = new Set(addresses.filter((a) => a.startsWith('stake1')));
  const plain = addresses.filter((a) => a.startsWith('addr1'));
  if (plain.length) {
    const info = await get<{ address: string; balance?: string; stake_address?: string | null }[]>('https://api.koios.rest/api/v1/address_info', {
      body: { _addresses: plain },
      label: 'Koios (Cardano)',
    });
    for (const a of info) {
      if (a.stake_address) stakes.add(a.stake_address);
      else addBalance(data.balances, 'ADA', Number(a.balance ?? 0) / 1e6);
    }
  }
  if (stakes.size) {
    const info = await get<{ total_balance?: string }[]>('https://api.koios.rest/api/v1/account_info', {
      body: { _stake_addresses: [...stakes] },
      label: 'Koios (Cardano)',
    });
    for (const a of info) addBalance(data.balances, 'ADA', Number(a.total_balance ?? 0) / 1e6);
  }
  data.warnings.push('Cardano: letto il saldo; lo storico delle operazioni non è ancora supportato.');
  return data;
}

/** TON (toncenter): saldo in TON. */
export async function readTon(addresses: string[], get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  for (const a of addresses) {
    const r = await get<{ ok?: boolean; result?: string }>(`https://toncenter.com/api/v2/getAddressBalance?address=${encodeURIComponent(a)}`, { label: 'toncenter (TON)' });
    addBalance(data.balances, 'TON', Number(r.result ?? 0) / 1e9);
  }
  data.warnings.push('TON: letto il saldo; lo storico delle operazioni non è ancora supportato.');
  return data;
}

/** Stellar (Horizon): XLM e asset con prezzo di mercato (es. USDC). */
export async function readStellar(addresses: string[], get = getJson): Promise<ChainData> {
  const data = emptyChainData();
  for (const a of addresses) {
    const r = await get<{ balances?: { asset_type: string; asset_code?: string; balance: string }[] }>(`https://horizon.stellar.org/accounts/${a}`, { label: 'Stellar Horizon' });
    for (const b of r.balances ?? []) {
      if (b.asset_type === 'native') addBalance(data.balances, 'XLM', Number(b.balance));
      else if (b.asset_code && /^(USDC|EURC)$/.test(b.asset_code)) addBalance(data.balances, b.asset_code, Number(b.balance));
    }
  }
  data.warnings.push('Stellar: letto il saldo; lo storico delle operazioni non è ancora supportato.');
  return data;
}
