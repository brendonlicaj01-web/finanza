import type { SyncResult } from '../sync-types';

/** Un foglio letto da un file (xls, xlsx, csv): righe di celle grezze. */
export interface Sheet {
  name: string;
  rows: unknown[][];
}

export interface ImportOptions {
  /** Aggiunge depositi/prelievi speculari: per file che non contengono i movimenti di liquidità. */
  balanceCash: boolean;
  /** Identificativi già presenti nel conto di destinazione (per evitare doppioni tra formati diversi). */
  existingIds: Set<string>;
  /** Simboli degli strumenti già presenti nell'app, per riconoscere nomi spezzati nelle descrizioni. */
  knownSymbols: string[];
  /** Scelte specifiche del formato (vedi FileImporter.options). */
  flags?: Record<string, boolean>;
}

export interface ImporterOption {
  key: string;
  label: string;
  hint?: string;
  default: boolean;
}

export interface FileImporter {
  id: string;
  /** Nome del broker, usato anche come nome del conto. */
  label: string;
  /** Cosa esportare e da dove, mostrato nella pagina di import. */
  howTo: string;
  /** Il file non contiene la liquidità: di default si bilanciano i movimenti. */
  needsCashBalance: boolean;
  /** Il broker esporta più file da importare insieme (es. OKX: Trading + Funding). */
  multiFile?: boolean;
  /** Scelte mostrate nell'anteprima di import. */
  options?: ImporterOption[];
  detect(sheets: Sheet[]): boolean;
  parse(sheets: Sheet[], options: ImportOptions): SyncResult;
}
