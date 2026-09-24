import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ConnectionInfo } from '../src/lib/sync-types.ts';

/**
 * Le credenziali restano sul computer dell'utente, fuori dalla cartella del progetto
 * (così non finiscono per errore in git o in uno ZIP), leggibili solo dal suo utente.
 */
export const DATA_DIR = process.env.FINANZA_HOME || join(homedir(), '.finanza');
const FILE = join(DATA_DIR, 'connections.json');

export interface StoredConnection {
  id: string;
  provider: string;
  label: string;
  createdAt: string;
  lastSyncAt?: string;
  credentials: Record<string, string>;
}

async function readAll(): Promise<StoredConnection[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, 'utf8'));
    return Array.isArray(parsed.connections) ? parsed.connections : [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

async function writeAll(connections: StoredConnection[]) {
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${FILE}.tmp`;
  await writeFile(tmp, JSON.stringify({ connections }, null, 2), { mode: 0o600 });
  await rename(tmp, FILE);
  await chmod(FILE, 0o600).catch(() => {});
}

export function mask(value: string): string {
  if (!value) return '';
  if (value.length <= 8) return '••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

export function toInfo(c: StoredConnection, secretKeys: Set<string>): ConnectionInfo {
  const masked: Record<string, string> = {};
  for (const [k, v] of Object.entries(c.credentials)) masked[k] = secretKeys.has(k) ? mask(v) : v;
  return { id: c.id, provider: c.provider, label: c.label, createdAt: c.createdAt, lastSyncAt: c.lastSyncAt, masked };
}

export const store = {
  list: readAll,
  async get(id: string) {
    return (await readAll()).find((c) => c.id === id);
  },
  async add(c: Omit<StoredConnection, 'id' | 'createdAt'>) {
    const all = await readAll();
    const created: StoredConnection = { ...c, id: randomUUID(), createdAt: new Date().toISOString() };
    await writeAll([...all, created]);
    return created;
  },
  async update(id: string, patch: Partial<Omit<StoredConnection, 'id'>>) {
    const all = await readAll();
    const i = all.findIndex((c) => c.id === id);
    if (i === -1) return undefined;
    all[i] = { ...all[i], ...patch };
    await writeAll(all);
    return all[i];
  },
  async remove(id: string) {
    const all = await readAll();
    await writeAll(all.filter((c) => c.id !== id));
  },
};
