import type { ProviderInfo, SyncResult } from '../../src/lib/sync-types.ts';

export interface SyncOptions {
  /** Valuta base dell'app (es. EUR). */
  currency: string;
  /** Scarica solo i dati successivi a questa data (ISO), se la fonte lo consente. */
  since?: string;
}

export interface Provider extends ProviderInfo {
  /** Verifica le credenziali con una chiamata leggera; lancia un errore leggibile se non valide. */
  test(credentials: Record<string, string>): Promise<void>;
  sync(credentials: Record<string, string>, options: SyncOptions): Promise<SyncResult>;
}

/** Errore con messaggio pensato per l'utente. */
export class ProviderError extends Error {}
