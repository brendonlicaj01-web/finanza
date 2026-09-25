import { ProviderError } from '../types.ts';
import { fromUnits, getJson, pool } from './http.ts';
import { addBalance, emptyChainData, type ChainData, type Movement } from './types.ts';

/**
 * Ethereum e reti compatibili (EVM) **senza chiave**: lo stesso indirizzo 0x… viene cercato su tutte le reti.
 * Storico da Routescan (API compatibile con Etherscan, gratuita senza chiave: 2 richieste al secondo) per le reti
 * che copre; per le altre solo il saldo della moneta della rete (nodo RPC pubblico).
 * Con una chiave Zerion (gratuita) si usa invece Zerion, che copre tutte le reti in un colpo solo (zerion.ts).
 *
 * Nota (2026): Etherscan e Blockscout richiedono ormai una chiave, ed Etherscan ha tolto dal piano gratuito
 * Base, BNB Chain, Optimism, Avalanche e Gnosis.
 */

export interface EvmChain {
  id: string;
  name: string;
  chainId: number;
  symbol: string;
  rpc?: string;
}

export const EVM_CHAINS: EvmChain[] = [
  { id: 'ethereum', name: 'Ethereum', chainId: 1, symbol: 'ETH', rpc: 'https://ethereum-rpc.publicnode.com' },
  { id: 'arbitrum', name: 'Arbitrum', chainId: 42161, symbol: 'ETH', rpc: 'https://arb1.arbitrum.io/rpc' },
  { id: 'base', name: 'Base', chainId: 8453, symbol: 'ETH', rpc: 'https://mainnet.base.org' },
  { id: 'optimism', name: 'Optimism', chainId: 10, symbol: 'ETH', rpc: 'https://mainnet.optimism.io' },
  { id: 'polygon', name: 'Polygon', chainId: 137, symbol: 'POL', rpc: 'https://polygon-rpc.com' },
  { id: 'gnosis', name: 'Gnosis', chainId: 100, symbol: 'XDAI', rpc: 'https://rpc.gnosischain.com' },
  { id: 'scroll', name: 'Scroll', chainId: 534352, symbol: 'ETH', rpc: 'https://rpc.scroll.io' },
  { id: 'bsc', name: 'BNB Chain', chainId: 56, symbol: 'BNB', rpc: 'https://bsc-dataseed.bnbchain.org' },
  { id: 'avalanche', name: 'Avalanche C-Chain', chainId: 43114, symbol: 'AVAX', rpc: 'https://api.avax.network/ext/bc/C/rpc' },
  { id: 'linea', name: 'Linea', chainId: 59144, symbol: 'ETH', rpc: 'https://rpc.linea.build' },
  { id: 'zksync', name: 'zkSync Era', chainId: 324, symbol: 'ETH', rpc: 'https://mainnet.era.zksync.io' },
  { id: 'blast', name: 'Blast', chainId: 81457, symbol: 'ETH', rpc: 'https://rpc.blast.io' },
  { id: 'unichain', name: 'Unichain', chainId: 130, symbol: 'ETH', rpc: 'https://mainnet.unichain.org' },
  { id: 'mantle', name: 'Mantle', chainId: 5000, symbol: 'MNT', rpc: 'https://rpc.mantle.xyz' },
  { id: 'sonic', name: 'Sonic', chainId: 146, symbol: 'S', rpc: 'https://rpc.soniclabs.com' },
  { id: 'celo', name: 'Celo', chainId: 42220, symbol: 'CELO', rpc: 'https://forno.celo.org' },
  { id: 'berachain', name: 'Berachain', chainId: 80094, symbol: 'BERA', rpc: 'https://rpc.berachain.com' },
  { id: 'moonbeam', name: 'Moonbeam', chainId: 1284, symbol: 'GLMR', rpc: 'https://rpc.api.moonbeam.network' },
  { id: 'cronos', name: 'Cronos', chainId: 25, symbol: 'CRO', rpc: 'https://evm.cronos.org' },
];

/**
 * Contratti ufficiali delle monete più imitate: un token con lo stesso simbolo ma un altro contratto è una truffa
 * (inviata apposta per confondere) e viene ignorato.
 */
const OFFICIAL: Record<string, Record<string, string[]>> = {
  ethereum: {
    USDT: ['0xdac17f958d2ee523a2206206994597c13d831ec7'],
    USDC: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'],
    DAI: ['0x6b175474e89094c44da98b954eedeac495271d0f'],
    WETH: ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
    WBTC: ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599'],
  },
  arbitrum: {
    USDC: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
    USDT: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9'],
    WETH: ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
  },
  optimism: {
    USDC: ['0x0b2c639c533813f4aa9d7837caf62653d097ff85'],
    USDT: ['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58'],
    WETH: ['0x4200000000000000000000000000000000000006'],
  },
  base: {
    USDC: ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'],
    WETH: ['0x4200000000000000000000000000000000000006'],
  },
  polygon: {
    USDC: ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'],
    USDT: ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f'],
    WETH: ['0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'],
  },
  bsc: {
    USDT: ['0x55d398326f99059ff775485246999027b3197955'],
    USDC: ['0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d'],
  },
};
/** Simboli che su una rete vanno sempre confrontati con i contratti ufficiali (le reti senza elenco li accettano). */
const IMITATED = new Set(['USDT', 'USDC', 'DAI', 'WETH', 'WBTC', 'ETH', 'BTC']);

/** Token pubblicitari o truffaldini: link, inviti a "riscattare", simboli strani. */
export function isSpamToken(chain: string, symbol: string, name: string, contract: string): boolean {
  const text = `${symbol} ${name}`;
  if (/https?:|www\.|\.(com|io|xyz|net|org|app|finance|site|club|pro|me|top|cc)\b|t\.me|claim|visit|reward|airdrop|voucher|gift|bonus/i.test(text)) return true;
  if (!/^[A-Za-z0-9.+\-_]{1,12}$/.test(symbol)) return true;
  const up = symbol.toUpperCase();
  if (up === 'ETH' || up === 'BTC') return true; // nessun token ERC-20 legittimo si chiama così
  const official = OFFICIAL[chain];
  if (official && IMITATED.has(up)) return !(official[up] ?? []).includes(contract.toLowerCase());
  return false;
}

interface ScanResponse<T> {
  status?: string;
  message?: string;
  result?: T | string;
}
interface NormalTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  gasUsed?: string;
  gasPrice?: string;
  isError?: string;
}
interface TokenTx {
  hash: string;
  timeStamp: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  tokenSymbol: string;
  tokenName: string;
  tokenDecimal: string;
}
export type Scan = <T>(chain: EvmChain, params: Record<string, string>) => Promise<T[] | string>;

/** La rete non è coperta dalla fonte: si ripiega sul saldo dal nodo pubblico. */
export class ScanUnavailable extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const ROUTESCAN = 'https://api.routescan.io/v2/network/mainnet/evm';

/** Richiesta in formato Etherscan a Routescan (senza chiave). */
export function makeScan(get = getJson): Scan {
  return async <T>(chain: EvmChain, params: Record<string, string>) => {
    const url = `${ROUTESCAN}/${chain.chainId}/etherscan/api?${new URLSearchParams(params)}`;
    for (let attempt = 0; ; attempt++) {
      let r: ScanResponse<T[]>;
      try {
        r = await get<ScanResponse<T[]>>(url, { label: `Routescan ${chain.name}` });
      } catch (e) {
        // Rete non coperta (404/400) o servizio non disponibile: si passa al nodo pubblico.
        throw new ScanUnavailable((e as Error).message);
      }
      if (r.status === '1' || (Array.isArray(r.result) && r.result.length)) return r.result as T[];
      const msg = `${r.message ?? ''} ${typeof r.result === 'string' ? r.result : ''}`;
      if (/no (transactions|records|token transfers) found|no data/i.test(msg) || (Array.isArray(r.result) && !r.result.length)) return [];
      if (/rate limit|max calls|too many/i.test(msg) && attempt < 5) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (params.action === 'balance' && typeof r.result === 'string' && /^\d+$/.test(r.result)) return r.result;
      throw new ScanUnavailable(msg.trim() || 'risposta non valida');
    }
  };
}

async function listAll<T>(scan: Scan, chain: EvmChain, action: string, address: string): Promise<{ items: T[]; truncated: boolean }> {
  const items: T[] = [];
  const offset = 1000;
  for (let page = 1; page <= 10; page++) {
    const r = await scan<T>(chain, { module: 'account', action, address, page: String(page), offset: String(offset), sort: 'asc', startblock: '0', endblock: '99999999' });
    if (typeof r === 'string') break;
    items.push(...r);
    if (r.length < offset) return { items, truncated: false };
  }
  return { items, truncated: true };
}

const lc = (s?: string) => (s ?? '').toLowerCase();

/** Movimenti di un indirizzo su una rete, dai tre elenchi di Etherscan/Blockscout. */
export function evmMovements(
  chain: EvmChain,
  address: string,
  normal: NormalTx[],
  internal: NormalTx[],
  tokens: TokenTx[],
  skipped: Set<string> = new Set(),
): Movement[] {
  const me = lc(address);
  const byHash = new Map<string, { time: number; flows: Map<string, number>; fee: number }>();
  const entry = (hash: string, time: number) => {
    let e = byHash.get(hash);
    if (!e) {
      e = { time, flows: new Map(), fee: 0 };
      byHash.set(hash, e);
    }
    return e;
  };
  const flow = (hash: string, time: number, symbol: string, amount: number) => {
    if (!amount) return;
    const e = entry(hash, time);
    e.flows.set(symbol, (e.flows.get(symbol) ?? 0) + amount);
  };

  for (const t of normal) {
    const time = Number(t.timeStamp) * 1000;
    const failed = t.isError === '1';
    if (lc(t.from) === me) {
      // Il gas si paga anche se la transazione fallisce.
      const fee = fromUnits(t.gasUsed, 0) * fromUnits(t.gasPrice, 0);
      if (fee) entry(t.hash, time).fee += fee / 1e18;
      if (!failed) flow(t.hash, time, chain.symbol, -fromUnits(t.value, 18));
    }
    if (lc(t.to) === me && !failed) flow(t.hash, time, chain.symbol, fromUnits(t.value, 18));
  }
  for (const t of internal) {
    if (t.isError === '1') continue;
    const time = Number(t.timeStamp) * 1000;
    if (lc(t.from) === me) flow(t.hash, time, chain.symbol, -fromUnits(t.value, 18));
    if (lc(t.to) === me) flow(t.hash, time, chain.symbol, fromUnits(t.value, 18));
  }
  for (const t of tokens) {
    const symbol = (t.tokenSymbol ?? '').trim();
    if (isSpamToken(chain.id, symbol, t.tokenName ?? '', t.contractAddress)) {
      skipped.add(symbol || t.contractAddress);
      continue;
    }
    const value = fromUnits(t.value, Number(t.tokenDecimal) || 0);
    if (!value) continue; // trasferimenti a valore zero: tentativi di "avvelenare" la cronologia
    const time = Number(t.timeStamp) * 1000;
    const sym = symbol.toUpperCase();
    if (lc(t.from) === me) flow(t.hash, time, sym, -value);
    if (lc(t.to) === me) flow(t.hash, time, sym, value);
  }

  const out: Movement[] = [];
  for (const [hash, e] of byHash) {
    let feeAssigned = false;
    for (const [symbol, amount] of e.flows) {
      if (Math.abs(amount) < 1e-12) continue;
      const withFee = symbol === chain.symbol && !feeAssigned;
      if (withFee) feeAssigned = true;
      out.push({ chain: chain.id, hash, time: e.time, symbol, amount, fee: withFee && e.fee ? e.fee : undefined });
    }
    // Solo gas (es. approvazioni, operazioni fallite, token scambiati altrove): movimento con sola commissione.
    if (!feeAssigned && e.fee) out.push({ chain: chain.id, hash, time: e.time, symbol: chain.symbol, amount: 0, fee: e.fee });
  }
  return out;
}

async function rpcBalance(chain: EvmChain, address: string, get = getJson): Promise<number> {
  if (!chain.rpc) return 0;
  const r = await get<{ result?: string }>(chain.rpc, {
    body: { jsonrpc: '2.0', id: 1, method: 'eth_getBalance', params: [address, 'latest'] },
    label: `${chain.name} (nodo pubblico)`,
  });
  return r.result ? fromUnits(BigInt(r.result).toString(), 18) : 0;
}

export async function readEvm(
  addresses: string[],
  options: { chains?: EvmChain[]; scan?: Scan; get?: typeof getJson } = {},
): Promise<ChainData> {
  const data = emptyChainData();
  const get = options.get ?? getJson;
  const scan = options.scan ?? makeScan(get);
  const skipped = new Set<string>();
  const historyless: string[] = [];
  const found: string[] = [];

  const tasks = (options.chains ?? EVM_CHAINS).flatMap((chain) => addresses.map((address) => ({ chain, address })));
  const failed = new Map<string, string>();
  // Routescan senza chiave accetta 2 richieste al secondo.
  await pool(tasks, 2, async (task) => {
    try {
      await readChain(task);
    } catch (e) {
      // Una rete irraggiungibile non blocca le altre.
      failed.set(task.chain.name, (e as Error).message);
    }
  });
  if (failed.size === tasks.length && tasks.length) throw new ProviderError([...failed.values()][0]);
  if (failed.size) data.warnings.push(`Reti EVM non lette: ${[...failed.keys()].join(', ')} (${[...failed.values()][0]}).`);

  async function readChain({ chain, address }: { chain: EvmChain; address: string }) {
    try {
      // Sondaggio leggero: se sulla rete non c'è nulla, niente altre richieste.
      const probe = await Promise.all([
        scan<NormalTx>(chain, { module: 'account', action: 'txlist', address, page: '1', offset: '1', sort: 'asc' }),
        scan<TokenTx>(chain, { module: 'account', action: 'tokentx', address, page: '1', offset: '1', sort: 'asc' }),
      ]);
      if (probe.every((p) => typeof p !== 'string' && !p.length)) {
        const bal = await rpcBalance(chain, address, get).catch(() => 0);
        if (bal) addBalance(data.balances, chain.symbol, bal);
        return;
      }
      const normal = await listAll<NormalTx>(scan, chain, 'txlist', address);
      const internal = await listAll<NormalTx>(scan, chain, 'txlistinternal', address);
      const tokens = await listAll<TokenTx>(scan, chain, 'tokentx', address);
      if (normal.truncated || internal.truncated || tokens.truncated) {
        data.warnings.push(`${chain.name}: più di 10.000 operazioni, importate solo le prime (i saldi restano allineati).`);
      }
      const moves = evmMovements(chain, address, normal.items, internal.items, tokens.items, skipped);
      data.movements.push(...moves);
      found.push(chain.name);
      // Saldi: moneta della rete dal servizio, token come somma dello storico.
      const native = await scan<string>(chain, { module: 'account', action: 'balance', address, tag: 'latest' });
      addBalance(data.balances, chain.symbol, fromUnits(typeof native === 'string' ? native : '0', 18));
      for (const m of moves) if (m.symbol !== chain.symbol) addBalance(data.balances, m.symbol, m.amount);
      return;
    } catch (e) {
      if (!(e instanceof ScanUnavailable)) throw e;
    }
    // Nessuno storico disponibile per questa rete: almeno il saldo della moneta della rete.
    const bal = await rpcBalance(chain, address, get);
    if (bal) {
      addBalance(data.balances, chain.symbol, bal);
      historyless.push(chain.name);
    }
  }

  if (skipped.size) {
    data.warnings.push(`${skipped.size} token sospetti (pubblicità, imitazioni di USDT/USDC…) ignorati: ${[...skipped].slice(0, 8).join(', ')}${skipped.size > 8 ? '…' : ''}.`);
  }
  if (historyless.length) {
    data.warnings.push(
      `${[...new Set(historyless)].join(', ')}: letto solo il saldo della moneta della rete. Per token e storico aggiungi una chiave Zerion gratuita.`,
    );
  }
  if (found.length) data.warnings.push(`Reti EVM con movimenti: ${[...new Set(found)].join(', ')}.`);
  return data;
}
