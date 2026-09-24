import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react';
import type { Account, AppData, Asset, Settings, Transaction } from './lib/types';
import { emptyData } from './lib/types';
import { loadData, saveData } from './lib/storage';
import { computePortfolio, type PortfolioResult } from './lib/portfolio';
import { setCurrency, today } from './lib/format';
import { mergeSync } from './lib/sync';
import type { SyncResult } from './lib/sync-types';

export type Action =
  | { type: 'upsertAccount'; account: Account }
  | { type: 'deleteAccount'; id: string }
  | { type: 'upsertAsset'; asset: Asset }
  | { type: 'deleteAsset'; id: string }
  | { type: 'setPrices'; prices: Record<string, number> }
  | { type: 'upsertTransaction'; tx: Transaction }
  | { type: 'deleteTransaction'; id: string }
  | { type: 'updateSettings'; settings: Partial<Settings> }
  | { type: 'replace'; data: AppData }
  | { type: 'applySync'; connection: { id: string; label: string }; result: SyncResult; today: string }
  | {
      type: 'applyImport';
      connection: { id: string; label: string };
      result: SyncResult;
      today: string;
      /** Conto esistente in cui importare (altrimenti ne viene creato uno nuovo). */
      targetAccountId?: string;
    }
  | { type: 'reset' };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const copy = list.slice();
  copy[i] = item;
  return copy;
}

function reducer(state: AppData, action: Action): AppData {
  switch (action.type) {
    case 'upsertAccount':
      return { ...state, accounts: upsert(state.accounts, action.account) };
    case 'deleteAccount':
      return {
        ...state,
        accounts: state.accounts.filter((a) => a.id !== action.id),
        transactions: state.transactions.filter((t) => t.accountId !== action.id),
      };
    case 'upsertAsset':
      return { ...state, assets: upsert(state.assets, action.asset) };
    case 'deleteAsset':
      return {
        ...state,
        assets: state.assets.filter((a) => a.id !== action.id),
        transactions: state.transactions.filter((t) => t.assetId !== action.id),
      };
    case 'setPrices': {
      const now = today();
      return {
        ...state,
        assets: state.assets.map((a) =>
          action.prices[a.id] !== undefined && action.prices[a.id] !== a.price
            ? { ...a, price: action.prices[a.id], priceUpdatedAt: now }
            : a,
        ),
      };
    }
    case 'upsertTransaction':
      return { ...state, transactions: upsert(state.transactions, action.tx) };
    case 'deleteTransaction':
      return { ...state, transactions: state.transactions.filter((t) => t.id !== action.id) };
    case 'updateSettings':
      return { ...state, settings: { ...state.settings, ...action.settings } };
    case 'replace':
      return action.data;
    case 'applySync':
      return mergeSync(state, action.connection, action.result, action.today).data;
    case 'applyImport':
      return mergeSync(withTarget(state, action.connection.id, action.targetAccountId), action.connection, action.result, action.today)
        .data;
    case 'reset':
      return emptyData();
  }
}

/** Valore speciale di destinazione: importa in un conto nuovo. */
export const NEW_ACCOUNT = '__nuovo__';

/**
 * Collega un conto esistente alla fonte di import, così `mergeSync` lo usa come destinazione.
 * Con NEW_ACCOUNT scollega la fonte da ogni conto: `mergeSync` ne creerà uno nuovo.
 */
export function withTarget(state: AppData, connectionId: string, targetAccountId?: string): AppData {
  if (!targetAccountId) return state;
  if (targetAccountId === NEW_ACCOUNT) {
    return {
      ...state,
      accounts: state.accounts.map((a) => (a.connectionId === connectionId ? { ...a, connectionId: undefined } : a)),
    };
  }
  return {
    ...state,
    accounts: state.accounts.map((a) =>
      a.id === targetAccountId
        ? { ...a, connectionId }
        : a.connectionId === connectionId
          ? { ...a, connectionId: undefined }
          : a,
    ),
  };
}

/** Aggiorna (o aggiunge) la fotografia del patrimonio di oggi, usata per il grafico storico. */
function withTodaySnapshot(data: AppData, result: PortfolioResult): AppData {
  if (data.transactions.length === 0) return data;
  const date = today();
  const snap = {
    date,
    netWorth: Math.round(result.summary.netWorth * 100) / 100,
    invested:
      Math.round((data.settings.trackCash ? result.summary.netDeposits : result.summary.cost) * 100) / 100,
  };
  const last = data.snapshots[data.snapshots.length - 1];
  if (last && last.date === date && last.netWorth === snap.netWorth && last.invested === snap.invested) {
    return data;
  }
  const snapshots = data.snapshots.filter((s) => s.date !== date);
  snapshots.push(snap);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  return { ...data, snapshots };
}

interface Store {
  data: AppData;
  result: PortfolioResult;
  dispatch: (a: Action) => void;
}

const Ctx = createContext<Store | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [data, dispatch] = useReducer(reducer, undefined, loadData);
  const result = useMemo(() => computePortfolio(data), [data]);
  setCurrency(data.settings.currency);

  useEffect(() => {
    saveData(withTodaySnapshot(data, result));
  }, [data, result]);

  const withSnapshot = useMemo(() => withTodaySnapshot(data, result), [data, result]);
  const value = useMemo(() => ({ data: withSnapshot, result, dispatch }), [withSnapshot, result]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error('useStore fuori da StoreProvider');
  return s;
}
