/** Tipi comuni ai lettori delle blockchain (sola lettura, solo indirizzi pubblici). */

/** Variazione di un asset in una transazione on-chain, vista dal wallet dell'utente. */
export interface Movement {
  /** Rete (es. "bitcoin", "ethereum", "base", "solana"). */
  chain: string;
  /** Identificativo della transazione on-chain. */
  hash: string;
  /** Istante in millisecondi. */
  time: number;
  /** Simbolo della moneta o del token (maiuscolo). */
  symbol: string;
  /** Variazione netta: positiva in entrata, negativa in uscita (commissione di rete esclusa). */
  amount: number;
  /** Commissione di rete pagata in questa transazione (nella moneta della rete), se a carico dell'utente. */
  fee?: number;
}

export interface ChainData {
  movements: Movement[];
  /** Saldi attuali per simbolo. */
  balances: Map<string, number>;
  warnings: string[];
}

export const emptyChainData = (): ChainData => ({ movements: [], balances: new Map(), warnings: [] });

export function addBalance(balances: Map<string, number>, symbol: string, amount: number) {
  if (!Number.isFinite(amount) || amount === 0) return;
  balances.set(symbol, (balances.get(symbol) ?? 0) + amount);
}
