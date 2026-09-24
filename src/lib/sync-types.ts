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
  warnings: string[];
}

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
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
}

export interface ConnectionInfo {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
  lastSyncAt?: string;
  /** Credenziali mascherate, mai i valori completi. */
  masked: Record<string, string>;
}
