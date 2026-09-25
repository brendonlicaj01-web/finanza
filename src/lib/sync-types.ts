/** Tipi condivisi tra il server locale (server/) e l'app nel browser. */
import type { AccountKind, AssetType, TxType } from './types';

export interface SyncAsset {
  /** Chiave stabile presso la fonte (ISIN, conid, simbolo…), usata dalle transazioni. */
  key: string;
  symbol: string;
  name: string;
  type: AssetType;
  isin?: string;
  /** Prezzo corrente in valuta base. */
  price?: number;
  /** Data del prezzo, se non è quello di oggi (es. ultimo scambio letto da un file). */
  priceDate?: string;
  /** Convenzione di prezzo della fonte (0,01 = prezzo in % del nominale). */
  priceMultiplier?: number;
  /** Aliquota fiscale suggerita, se la fonte permette di dedurla (es. titoli di Stato 12,5%). */
  taxRate?: number;
}

export interface SyncTx {
  externalId: string;
  date: string;
  type: TxType;
  assetKey?: string;
  quantity?: number;
  price?: number;
  amount?: number;
  fees: number;
  note?: string;
  /**
   * Versione dei dati: se è più alta di quella già salvata (es. ora ci sono prezzo e commissioni dal dettaglio),
   * la transazione esistente con lo stesso `externalId` viene aggiornata, salvo modifiche fatte a mano.
   */
  rev?: number;
  /**
   * Scambio: vendita e acquisto con lo stesso `pair` valgono uguale (il costo di ciò che si riceve è il valore di
   * ciò che si dà). Usato quando i prezzi vengono aggiunti dopo la lettura del file.
   */
  pair?: string;
}

export interface SyncHolding {
  assetKey: string;
  quantity: number;
  /** Prezzo medio di carico secondo la fonte, se disponibile (valuta base). */
  costPrice?: number;
}

export interface SyncResult {
  accountName: string;
  accountKind: AccountKind;
  /** Valuta base in cui sono espressi prezzi e importi. */
  currency: string;
  assets: SyncAsset[];
  transactions: SyncTx[];
  /** Saldi reali attuali: servono ad allineare le quantità calcolate. */
  holdings?: SyncHolding[];
  /** Liquidità reale attuale in valuta base. */
  cash?: number;
  /**
   * Il risultato contiene tutto lo storico della fonte: gli allineamenti automatici creati in passato
   * (quando lo storico era incompleto) vengono ricalcolati da zero.
   */
  complete?: boolean;
  /**
   * Transazioni importate in passato che la fonte non produce più (es. il movimento di liquidità speculare di un
   * trasferimento, prima registrato come vendita + prelievo): si eliminano, salvo modifiche fatte a mano.
   */
  remove?: string[];
  warnings: string[];
}

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
  /** Se presente, il campo è una scelta tra queste opzioni (la prima è predefinita). */
  options?: { value: string; label: string }[];
}

export interface ProviderInfo {
  id: string;
  label: string;
  category: 'broker' | 'crypto' | 'banca';
  description: string;
  fields: ProviderField[];
  /** Passaggi per ottenere le credenziali. */
  guide: string[];
  docsUrl?: string;
  available: boolean;
  /** Serve un'autorizzazione sul sito della banca dopo aver inserito le credenziali. */
  requiresAuth?: boolean;
}

export interface BankInfo {
  name: string;
  country: string;
  logo?: string;
  maxConsentSeconds?: number;
}

export interface ConnectionInfo {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
  lastSyncAt?: string;
  /** Credenziali mascherate, mai i valori completi. */
  masked: Record<string, string>;
  /** Stato dell'autorizzazione bancaria, per le fonti che la richiedono. */
  auth?: { authorized: boolean; validUntil?: string; bank?: string };
}
