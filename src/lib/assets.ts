import type { AppData, Asset } from './types.ts';

/**
 * Identità degli strumenti tra fonti diverse.
 *
 * La stessa crypto arriva con nomi diversi: "BTC" (Trade Republic, OKX, wallet), "Bitcoin" con ISIN XF000BTC0017
 * (Scalable). Il ticker canonico permette di riconoscerla come uno strumento solo.
 */

/** Nomi estesi → ticker delle crypto più diffuse. */
const NAMES: Record<string, string> = {
  BITCOIN: 'BTC',
  ETHEREUM: 'ETH',
  ETHER: 'ETH',
  SOLANA: 'SOL',
  RIPPLE: 'XRP',
  CARDANO: 'ADA',
  POLKADOT: 'DOT',
  LITECOIN: 'LTC',
  CHAINLINK: 'LINK',
  DOGECOIN: 'DOGE',
  AVALANCHE: 'AVAX',
  POLYGON: 'POL',
  MATIC: 'POL',
  UNISWAP: 'UNI',
  STELLAR: 'XLM',
  STELLARLUMENS: 'XLM',
  TRON: 'TRX',
  BITCOINCASH: 'BCH',
  SHIBAINU: 'SHIB',
  TETHER: 'USDT',
  USDCOIN: 'USDC',
  COSMOS: 'ATOM',
  NEAR: 'NEAR',
  NEARPROTOCOL: 'NEAR',
  TONCOIN: 'TON',
  SUI: 'SUI',
  APTOS: 'APT',
  ARBITRUM: 'ARB',
  OPTIMISM: 'OP',
  PEPE: 'PEPE',
  BNB: 'BNB',
  BINANCECOIN: 'BNB',
  ETHEREUMCLASSIC: 'ETC',
  MONERO: 'XMR',
  AAVE: 'AAVE',
  ALGORAND: 'ALGO',
  TEZOS: 'XTZ',
  HEDERA: 'HBAR',
  INTERNETCOMPUTER: 'ICP',
  FILECOIN: 'FIL',
  RENDER: 'RENDER',
  THEGRAPH: 'GRT',
};

const squash = (s: string) => s.toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '');

/**
 * Ticker canonico di una crypto: dall'ISIN crypto (XF000BTC0017 → BTC), dal nome esteso (Bitcoin → BTC) o dal
 * simbolo. Per gli altri strumenti restituisce undefined.
 */
export function cryptoTicker(a: Pick<Asset, 'symbol' | 'name' | 'type'> & { isin?: string }): string | undefined {
  if (a.type !== 'crypto') return undefined;
  const fromIsin = a.isin?.toUpperCase().match(/^XF000([A-Z]{2,10})\d/);
  if (fromIsin) return fromIsin[1];
  const sym = squash(a.symbol);
  if (NAMES[sym]) return NAMES[sym];
  const name = squash(a.name ?? '');
  // Un simbolo lungo come un nome ("Bitcoin") senza corrispondenza: prova con il nome.
  if (sym.length > 6 && NAMES[name]) return NAMES[name];
  return sym;
}

/** Chiave d'identità: stesso valore → stesso strumento. */
export function identityKey(a: Asset): string {
  const ticker = cryptoTicker(a);
  if (ticker) return `crypto:${ticker}`;
  return a.isin ? `isin:${a.isin.toUpperCase()}` : `id:${a.id}`;
}

export interface DuplicateGroup {
  key: string;
  /** Strumento da tenere: quello con il simbolo "giusto" (il ticker), poi quello con più transazioni. */
  primary: Asset;
  others: Asset[];
}

/** Strumenti registrati più volte (stessa crypto o stesso ISIN). */
export function findDuplicates(data: AppData): DuplicateGroup[] {
  const txCount = new Map<string, number>();
  for (const t of data.transactions) if (t.assetId) txCount.set(t.assetId, (txCount.get(t.assetId) ?? 0) + 1);
  const groups = new Map<string, Asset[]>();
  for (const a of data.assets) {
    const k = identityKey(a);
    if (k.startsWith('id:')) continue;
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const out: DuplicateGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    const ticker = key.startsWith('crypto:') ? key.slice(7) : undefined;
    const ranked = [...list].sort(
      (x, y) =>
        Number(y.symbol.toUpperCase() === ticker) - Number(x.symbol.toUpperCase() === ticker) ||
        (txCount.get(y.id) ?? 0) - (txCount.get(x.id) ?? 0) ||
        x.symbol.localeCompare(y.symbol),
    );
    out.push({ key, primary: ranked[0], others: ranked.slice(1) });
  }
  return out;
}

/**
 * Unisce più strumenti in uno: le transazioni passano allo strumento principale, che prende anche l'ISIN mancante e
 * il prezzo più recente; gli altri vengono eliminati.
 */
export function mergeAssets(data: AppData, primaryId: string, otherIds: string[]): AppData {
  const others = new Set(otherIds.filter((id) => id !== primaryId));
  const primary = data.assets.find((a) => a.id === primaryId);
  if (!primary || !others.size) return data;
  const merged = data.assets.filter((a) => others.has(a.id));
  const newest = [primary, ...merged]
    .filter((a) => a.price > 0)
    .sort((x, y) => (y.priceUpdatedAt ?? '').localeCompare(x.priceUpdatedAt ?? ''))[0];
  const updated: Asset = {
    ...primary,
    isin: primary.isin ?? merged.find((a) => a.isin)?.isin,
    ...(newest ? { price: newest.price, priceUpdatedAt: newest.priceUpdatedAt } : {}),
  };
  return {
    ...data,
    assets: data.assets.filter((a) => !others.has(a.id)).map((a) => (a.id === primaryId ? updated : a)),
    transactions: data.transactions.map((t) => (t.assetId && others.has(t.assetId) ? { ...t, assetId: primaryId } : t)),
  };
}
