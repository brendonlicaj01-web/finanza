import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './lib/api';
import { mergeSync, type MergeStats } from './lib/sync';
import type { ConnectionInfo, ProviderInfo, SyncResult } from './lib/sync-types';
import { today } from './lib/format';
import { useStore } from './store';

export interface SyncStatus {
  running: boolean;
  ok?: boolean;
  message?: string;
  warnings?: string[];
}

interface SyncCtx {
  /** null = verifica in corso; false = app aperta senza server locale (es. build statica). */
  serverUp: boolean | null;
  providers: ProviderInfo[];
  connections: ConnectionInfo[];
  status: Record<string, SyncStatus>;
  busy: boolean;
  refresh(): Promise<void>;
  add(provider: string, label: string, credentials: Record<string, string>): Promise<ConnectionInfo>;
  remove(id: string): Promise<void>;
  sync(id: string, full?: boolean): Promise<void>;
  syncAll(): Promise<void>;
}

const Ctx = createContext<SyncCtx | null>(null);

function describe(stats: MergeStats): string {
  const parts: string[] = [];
  parts.push(stats.added === 1 ? '1 nuova transazione' : `${stats.added} nuove transazioni`);
  if (stats.newAssets) parts.push(stats.newAssets === 1 ? '1 nuovo strumento' : `${stats.newAssets} nuovi strumenti`);
  if (stats.adjustments) parts.push(stats.adjustments === 1 ? '1 allineamento' : `${stats.adjustments} allineamenti`);
  return parts.join(', ');
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const { data, dispatch } = useStore();
  const dataRef = useRef(data);
  dataRef.current = data;

  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [connections, setConnectionsState] = useState<ConnectionInfo[]>([]);
  // Ref sempre aggiornata: permette di sincronizzare subito un collegamento appena creato.
  const connsRef = useRef(connections);
  const setConnections = useCallback((next: ConnectionInfo[] | ((cs: ConnectionInfo[]) => ConnectionInfo[])) => {
    connsRef.current = typeof next === 'function' ? next(connsRef.current) : next;
    setConnectionsState(connsRef.current);
  }, []);
  const [status, setStatus] = useState<Record<string, SyncStatus>>({});
  const autoRan = useRef(false);
  const running = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    try {
      const [p, c] = await Promise.all([api<ProviderInfo[]>('/providers'), api<ConnectionInfo[]>('/connections')]);
      setProviders(p);
      setConnections(c);
      setServerUp(true);
    } catch {
      setServerUp(false);
    }
  }, [setConnections]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sync = useCallback(
    async (id: string, full = false) => {
      const conn = connsRef.current.find((c) => c.id === id);
      if (!conn || running.current.has(id)) return;
      running.current.add(id);
      setStatus((s) => ({ ...s, [id]: { running: true, message: 'Sincronizzazione in corso…' } }));
      try {
        const res = await api<{ result: SyncResult; connection?: ConnectionInfo }>(`/connections/${id}/sync`, {
          method: 'POST',
          body: { currency: dataRef.current.settings.currency, full },
        });
        const label = conn.label;
        const date = today();
        const { stats } = mergeSync(dataRef.current, { id, label }, res.result, date);
        dispatch({ type: 'applySync', connection: { id, label }, result: res.result, today: date });
        if (res.connection) setConnections((cs) => cs.map((c) => (c.id === id ? res.connection! : c)));
        setStatus((s) => ({ ...s, [id]: { running: false, ok: true, message: describe(stats), warnings: stats.warnings } }));
      } catch (e) {
        setStatus((s) => ({ ...s, [id]: { running: false, ok: false, message: (e as Error).message } }));
      } finally {
        running.current.delete(id);
      }
    },
    [dispatch, setConnections],
  );

  const syncAll = useCallback(async () => {
    for (const c of connsRef.current) await sync(c.id);
  }, [sync]);

  // Sincronizzazione automatica all'apertura, per i collegamenti non aggiornati di recente.
  useEffect(() => {
    // Solo una volta, al caricamento: i collegamenti aggiunti dopo vengono sincronizzati dal loro modulo.
    if (!serverUp || autoRan.current) return;
    autoRan.current = true;
    const { autoSync, autoSyncHours } = dataRef.current.settings;
    if (!autoSync) return;
    const stale = connections.filter(
      (c) => !c.lastSyncAt || Date.now() - Date.parse(c.lastSyncAt) > autoSyncHours * 3_600_000,
    );
    void (async () => {
      for (const c of stale) await sync(c.id);
    })();
  }, [serverUp, connections, sync]);

  const add = useCallback(async (provider: string, label: string, credentials: Record<string, string>) => {
    const created = await api<ConnectionInfo>('/connections', { method: 'POST', body: { provider, label, credentials } });
    setConnections((cs) => [...cs, created]);
    return created;
  }, [setConnections]);

  const remove = useCallback(async (id: string) => {
    await api(`/connections/${id}`, { method: 'DELETE' });
    setConnections((cs) => cs.filter((c) => c.id !== id));
  }, [setConnections]);

  const busy = Object.values(status).some((s) => s.running);
  const value = useMemo(
    () => ({ serverUp, providers, connections, status, busy, refresh, add, remove, sync, syncAll }),
    [serverUp, providers, connections, status, busy, refresh, add, remove, sync, syncAll],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSync(): SyncCtx {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSync fuori da SyncProvider');
  return s;
}
