export type AssetType =
  | 'azione'
  | 'etf'
  | 'obbligazione'
  | 'fondo'
  | 'crypto'
  | 'materia_prima'
  | 'altro';

export const ASSET_TYPES: { value: AssetType; label: string }[] = [
  { value: 'azione', label: 'Azione' },
  { value: 'etf', label: 'ETF' },
  { value: 'obbligazione', label: 'Obbligazione' },
  { value: 'fondo', label: 'Fondo' },
  { value: 'crypto', label: 'Crypto' },
  { value: 'materia_prima', label: 'Materia prima' },
  { value: 'altro', label: 'Altro' },
];

export type AccountKind = 'broker' | 'banca' | 'wallet' | 'altro';

export const ACCOUNT_KINDS: { value: AccountKind; label: string }[] = [
  { value: 'broker', label: 'Broker' },
  { value: 'banca', label: 'Banca' },
  { value: 'wallet', label: 'Wallet crypto' },
  { value: 'altro', label: 'Altro' },
];

export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  note?: string;
  /** Collegamento automatico (broker/exchange) da cui arrivano i dati del conto. */
  connectionId?: string;
}

export interface Asset {
  id: string;
  /** Ticker o ISIN, es. "VWCE" o "IT0005580136". */
  symbol: string;
  name: string;
  type: AssetType;
  /** Prezzo corrente in valuta base, inserito manualmente. */
  price: number;
  priceUpdatedAt?: string;
  /** Aliquota fiscale sulle plusvalenze, in percentuale (26 standard, 12.5 titoli di Stato). */
  taxRate: number;
  isin?: string;
  /**
   * Valore di 1 unità di prezzo per 1 unità di quantità. 1 per azioni/ETF/crypto;
   * 0,01 per obbligazioni con quantità nominale e prezzo in percentuale (es. 3.000 × 100 % = 3.000 €).
   */
  priceMultiplier?: number;
}

/** Moltiplicatore effettivo di uno strumento (1 se non indicato). */
export const multiplierOf = (a?: Pick<Asset, 'priceMultiplier'>) => a?.priceMultiplier || 1;

export type TxType =
  | 'acquisto'
  | 'vendita'
  | 'dividendo'
  | 'interessi'
  | 'deposito'
  | 'prelievo'
  | 'commissione'
  | 'trasf_uscita'
  | 'trasf_entrata';

export const TX_TYPES: { value: TxType; label: string }[] = [
  { value: 'acquisto', label: 'Acquisto' },
  { value: 'vendita', label: 'Vendita' },
  { value: 'dividendo', label: 'Dividendo / cedola' },
  { value: 'interessi', label: 'Interessi' },
  { value: 'deposito', label: 'Deposito' },
  { value: 'prelievo', label: 'Prelievo' },
  { value: 'commissione', label: 'Commissione / imposta' },
  { value: 'trasf_uscita', label: 'Trasferimento crypto interno (uscita)' },
  { value: 'trasf_entrata', label: 'Trasferimento crypto interno (entrata)' },
];

/**
 * Trasferimenti di crypto tra i propri conti o wallet: spostano quantità e costo di carico, non sono
 * compravendite (nessuna plus/minusvalenza) né versamenti o prelievi di liquidità.
 */
export const TRANSFER_TX: TxType[] = ['trasf_uscita', 'trasf_entrata'];
/** Tipi che si riferiscono a uno strumento. */
export const ASSET_TX: TxType[] = ['acquisto', 'vendita', 'dividendo', ...TRANSFER_TX];
/**
 * Tipi con quantità × prezzo; gli altri usano `amount`. Per i trasferimenti il prezzo è il valore del giorno,
 * usato come costo di carico solo se l'altra metà del trasferimento non è tra i conti dell'app.
 */
export const TRADE_TX: TxType[] = ['acquisto', 'vendita', ...TRANSFER_TX];
/** Movimenti che aumentano la quantità posseduta in un conto. */
export const INFLOW_QTY: TxType[] = ['acquisto', 'trasf_entrata'];
/** Movimenti che riducono la quantità posseduta in un conto. */
export const OUTFLOW_QTY: TxType[] = ['vendita', 'trasf_uscita'];

export interface Transaction {
  id: string;
  /** Data ISO YYYY-MM-DD. */
  date: string;
  type: TxType;
  accountId: string;
  assetId?: string;
  quantity?: number;
  /** Prezzo unitario (acquisto/vendita). */
  price?: number;
  /** Importo netto per dividendi, interessi, depositi, prelievi, commissioni. */
  amount?: number;
  fees: number;
  note?: string;
  /** Identificativo univoco presso la fonte esterna: evita duplicati nelle sincronizzazioni. */
  externalId?: string;
  /** Versione dei dati della fonte: una sincronizzazione con dati più completi aggiorna la transazione. */
  rev?: number;
  /** Modificata a mano: le sincronizzazioni non la toccano più. */
  edited?: boolean;
}

export interface Snapshot {
  date: string;
  /** Patrimonio totale (investimenti + liquidità). */
  netWorth: number;
  /** Capitale versato (depositi − prelievi) o, senza tracciamento liquidità, costo di carico. */
  invested: number;
}

export interface Settings {
  currency: string;
  /** Se attivo, la liquidità dei conti viene calcolata dalle transazioni. */
  trackCash: boolean;
  /** Sincronizza i collegamenti automaticamente all'apertura dell'app. */
  autoSync: boolean;
  /** Ore minime tra due sincronizzazioni automatiche dello stesso collegamento. */
  autoSyncHours: number;
}

/**
 * Riferimento stabile a una transazione: per quelle importate vale l'identificativo della fonte (sopravvive a
 * sincronizzazioni e reimport), per quelle manuali l'id interno.
 */
export interface TxRef {
  id: string;
  accountId: string;
  externalId?: string;
}

/** Decisione dell'utente su una coppia uscita/entrata tra due conti. */
export interface TransferLink {
  id: string;
  out: TxRef;
  in: TxRef;
  /** Confermato: è un trasferimento tra conti propri. Rifiutato: non lo è, non riproporlo. */
  status: 'confermato' | 'rifiutato';
  /** Data della decisione (ISO). */
  decidedAt: string;
}

export interface AppData {
  version: 1;
  accounts: Account[];
  assets: Asset[];
  transactions: Transaction[];
  snapshots: Snapshot[];
  settings: Settings;
  /** Trasferimenti tra conti confermati o scartati dall'utente. */
  transferLinks?: TransferLink[];
}

export const emptyData = (): AppData => ({
  version: 1,
  accounts: [],
  assets: [],
  transactions: [],
  snapshots: [],
  settings: { currency: 'EUR', trackCash: true, autoSync: true, autoSyncHours: 6 },
});
