import type { AppData, Asset, Transaction } from './types';
import type { SyncResult } from './sync-types';
import { computePortfolio, quantityAt } from './portfolio';
import { uid } from './id';

export interface MergeStats {
  added: number;
  newAssets: number;
  adjustments: number;
  warnings: string[];
}

const EPS = 1e-8;

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Unisce i dati di una sincronizzazione nell'archivio dell'app:
 * - un conto per collegamento;
 * - strumenti riconosciuti per ISIN o simbolo, altrimenti creati;
 * - transazioni aggiunte una sola volta (chiave `externalId`), senza toccare quelle modificate a mano;
 * - quantità e liquidità allineate ai saldi reali. Alla prima sincronizzazione la differenza diventa
 *   un saldo iniziale datato il giorno prima della prima operazione importata (così le vendite
 *   successive trovano i titoli); dopo, un allineamento alla data odierna.
 */
export function mergeSync(
  data: AppData,
  connection: { id: string; label: string },
  result: SyncResult,
  today: string,
): { data: AppData; stats: MergeStats } {
  const warnings = [...result.warnings];
  let accounts = data.accounts;
  let account = accounts.find((a) => a.connectionId === connection.id);
  if (!account) {
    account = { id: uid(), name: connection.label || result.accountName, kind: result.accountKind, connectionId: connection.id };
    accounts = [...accounts, account];
  }
  const accountId = account.id;
  const firstSync = !data.transactions.some((t) => t.accountId === accountId);

  // ---- Strumenti ----
  const assets: Asset[] = data.assets.slice();
  const keyToId = new Map<string, string>();
  let newAssets = 0;
  for (const sa of result.assets) {
    const symbol = sa.symbol.toUpperCase();
    let i = sa.isin ? assets.findIndex((a) => a.isin === sa.isin) : -1;
    if (i === -1) {
      i = assets.findIndex(
        (a) => a.symbol.toUpperCase() === symbol && (!a.isin || !sa.isin || a.isin === sa.isin) && a.type === sa.type,
      );
    }
    if (i === -1) {
      assets.push({
        id: uid(),
        symbol,
        name: sa.name,
        type: sa.type,
        price: sa.price ?? 0,
        priceUpdatedAt: sa.price !== undefined ? today : undefined,
        taxRate: 26,
        isin: sa.isin,
      });
      i = assets.length - 1;
      newAssets++;
    } else {
      const a = assets[i];
      assets[i] = {
        ...a,
        isin: a.isin ?? sa.isin,
        ...(sa.price !== undefined && sa.price > 0 ? { price: sa.price, priceUpdatedAt: today } : {}),
      };
    }
    keyToId.set(sa.key, assets[i].id);
  }

  // ---- Transazioni ----
  const known = new Set(data.transactions.map((t) => t.externalId).filter(Boolean));
  const incoming: Transaction[] = [];
  for (const st of result.transactions) {
    if (known.has(st.externalId)) continue;
    known.add(st.externalId);
    const assetId = st.assetKey ? keyToId.get(st.assetKey) : undefined;
    if (st.assetKey && !assetId && st.type !== 'dividendo') {
      warnings.push(`Transazione ${st.externalId} ignorata: strumento ${st.assetKey} sconosciuto.`);
      continue;
    }
    incoming.push({
      id: uid(),
      date: st.date,
      type: st.type,
      accountId,
      assetId,
      quantity: st.quantity,
      price: st.price,
      amount: st.amount,
      fees: st.fees,
      note: st.note,
      externalId: st.externalId,
    });
  }
  let transactions = [...data.transactions, ...incoming];

  // ---- Allineamento ai saldi reali ----
  const accountTx = transactions.filter((t) => t.accountId === accountId);
  const earliest = accountTx.reduce((m, t) => (t.date < m ? t.date : m), today);
  const adjDate = firstSync && accountTx.length ? dayBefore(earliest) : today;
  const label = firstSync ? 'Saldo iniziale' : 'Allineamento al saldo';
  const adjustments: Transaction[] = [];
  const assetById = new Map(assets.map((a) => [a.id, a]));

  if (result.holdings) {
    const actual = new Map<string, { quantity: number; costPrice?: number }>();
    for (const h of result.holdings) {
      const id = keyToId.get(h.assetKey);
      if (id) actual.set(id, { quantity: (actual.get(id)?.quantity ?? 0) + h.quantity, costPrice: h.costPrice });
    }
    // Quantità netta "grezza" (acquisti − vendite, senza troncare le vendite scoperte):
    // la differenza con il saldo reale è esattamente ciò che manca all'inizio o è cambiato fuori.
    const net = (assetId: string) => quantityAt(transactions, accountId, assetId, '9999-12-31');
    const ids = new Set([
      ...actual.keys(),
      ...accountTx.filter((t) => t.assetId && (t.type === 'acquisto' || t.type === 'vendita')).map((t) => t.assetId!),
    ]);
    for (const assetId of ids) {
      const have = net(assetId);
      const want = actual.get(assetId)?.quantity ?? 0;
      const diff = want - have;
      if (Math.abs(diff) <= Math.max(EPS, Math.abs(want) * 1e-6)) continue;
      const asset = assetById.get(assetId);
      const price = actual.get(assetId)?.costPrice ?? asset?.price ?? 0;
      adjustments.push({
        id: uid(),
        // Un eccesso (titoli trasferiti altrove) si registra oggi: prima non c'erano ancora.
        date: diff > 0 ? adjDate : today,
        type: diff > 0 ? 'acquisto' : 'vendita',
        accountId,
        assetId,
        quantity: Math.abs(diff),
        price: diff > 0 ? price : asset?.price ?? price,
        fees: 0,
        note: `${label} (${connection.label})${diff > 0 && actual.get(assetId)?.costPrice === undefined ? ': prezzo di carico da verificare' : ''}`,
        externalId: `${connection.id}:adj:${assetId}:${adjDate}:${Date.now()}`,
      });
    }
  }

  if (result.cash !== undefined) {
    // Liquidità calcolata includendo le rettifiche titoli appena create.
    const computed = computePortfolio({ ...data, accounts, assets, transactions: [...transactions, ...adjustments] });
    const have = computed.cash.find((c) => c.accountId === accountId)?.cash ?? 0;
    const diff = result.cash - have;
    if (Math.abs(diff) >= 0.01) {
      adjustments.push({
        id: uid(),
        date: adjDate,
        type: diff > 0 ? 'deposito' : 'prelievo',
        accountId,
        amount: Math.round(Math.abs(diff) * 100) / 100,
        fees: 0,
        note: `${label} liquidità (${connection.label})`,
        externalId: `${connection.id}:adjcash:${adjDate}:${Date.now()}`,
      });
    }
  }

  transactions = [...transactions, ...adjustments];
  return {
    data: { ...data, accounts, assets, transactions },
    stats: { added: incoming.length, newAssets, adjustments: adjustments.length, warnings },
  };
}
