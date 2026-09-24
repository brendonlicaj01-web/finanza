import type { ProviderInfo, SyncResult } from '../../src/lib/sync-types.ts';

export interface SyncOptions {
  /** Valuta base dell'app (es. EUR). */
  currency: string;
  /** Scarica solo i dati successivi a questa data (ISO), se la fonte lo consente. */
  since?: string;
}

export interface Bank {
  name: string;
  country: string;
  logo?: string;
  /** Durata massima del consenso concessa dalla banca, in secondi. */
  maxConsentSeconds?: number;
}

/** Fonti che richiedono un'autorizzazione dell'utente sul sito della banca (open banking). */
export interface BankAuth {
  listBanks(credentials: Record<string, string>, country: string): Promise<Bank[]>;
  /** Restituisce l'indirizzo della banca a cui mandare l'utente. */
  startAuth(credentials: Record<string, string>, bank: Bank, redirectUrl: string, state: string): Promise<string>;
  /** Scambia il codice ricevuto con una sessione; restituisce i campi da salvare nelle credenziali. */
  completeAuth(credentials: Record<string, string>, code: string): Promise<Record<string, string>>;
  status(credentials: Record<string, string>): { authorized: boolean; validUntil?: string; bank?: string };
}

export interface Provider extends ProviderInfo {
  auth?: BankAuth;
  /** Verifica le credenziali con una chiamata leggera; lancia un errore leggibile se non valide. */
  test(credentials: Record<string, string>): Promise<void>;
  sync(credentials: Record<string, string>, options: SyncOptions): Promise<SyncResult>;
}

/** Errore con messaggio pensato per l'utente. */
export class ProviderError extends Error {}
