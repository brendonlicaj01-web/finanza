import type { AppData } from './types';

/** Dati di esempio per esplorare l'app. Prezzi e importi sono inventati. */
export function demoData(todayIso: string): AppData {
  const year = Number(todayIso.slice(0, 4));
  const d = (offsetYears: number, md: string) => `${year + offsetYears}-${md}`;

  const data: AppData = {
    version: 1,
    settings: { currency: 'EUR', trackCash: true },
    accounts: [
      { id: 'acc-broker', name: 'Broker principale', kind: 'broker' },
      { id: 'acc-banca', name: 'Conto deposito', kind: 'banca' },
      { id: 'acc-wallet', name: 'Wallet crypto', kind: 'wallet' },
    ],
    assets: [
      { id: 'a-vwce', symbol: 'VWCE', name: 'Vanguard FTSE All-World Acc', type: 'etf', price: 142.3, taxRate: 26, priceUpdatedAt: todayIso },
      { id: 'a-agg', symbol: 'AGGH', name: 'iShares Core Global Aggregate Bond', type: 'etf', price: 5.12, taxRate: 26, priceUpdatedAt: todayIso },
      { id: 'a-btp', symbol: 'BTP 2033', name: 'BTP 4,35% 2033', type: 'obbligazione', price: 104.1, taxRate: 12.5, priceUpdatedAt: todayIso },
      { id: 'a-enel', symbol: 'ENEL', name: 'Enel S.p.A.', type: 'azione', price: 7.45, taxRate: 26, priceUpdatedAt: todayIso },
      { id: 'a-btc', symbol: 'BTC', name: 'Bitcoin', type: 'crypto', price: 61500, taxRate: 26, priceUpdatedAt: todayIso },
      { id: 'a-gold', symbol: 'SGLD', name: 'Invesco Physical Gold ETC', type: 'materia_prima', price: 248.6, taxRate: 26, priceUpdatedAt: todayIso },
    ],
    transactions: [
      { id: 't1', date: d(-2, '01-10'), type: 'deposito', accountId: 'acc-broker', amount: 25000, fees: 0 },
      { id: 't2', date: d(-2, '01-12'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-vwce', quantity: 80, price: 98.4, fees: 2.95 },
      { id: 't3', date: d(-2, '02-03'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-agg', quantity: 1200, price: 4.88, fees: 2.95 },
      { id: 't4', date: d(-2, '03-15'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-enel', quantity: 600, price: 6.1, fees: 2.95 },
      { id: 't5', date: d(-2, '05-20'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-btp', quantity: 50, price: 99.2, fees: 2.95 },
      { id: 't6', date: d(-2, '07-24'), type: 'dividendo', accountId: 'acc-broker', assetId: 'a-enel', amount: 95.46, fees: 0, note: 'Netto ritenuta' },
      { id: 't7', date: d(-1, '01-22'), type: 'dividendo', accountId: 'acc-broker', assetId: 'a-enel', amount: 99.9, fees: 0 },
      { id: 't8', date: d(-1, '02-05'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-vwce', quantity: 20, price: 112.1, fees: 2.95 },
      { id: 't9', date: d(-1, '04-11'), type: 'vendita', accountId: 'acc-broker', assetId: 'a-enel', quantity: 250, price: 7.02, fees: 2.95 },
      { id: 't10', date: d(-1, '05-20'), type: 'dividendo', accountId: 'acc-broker', assetId: 'a-btp', amount: 94.84, fees: 0, note: 'Cedola netta' },
      { id: 't11', date: d(-1, '06-01'), type: 'deposito', accountId: 'acc-wallet', amount: 3000, fees: 0 },
      { id: 't12', date: d(-1, '06-02'), type: 'acquisto', accountId: 'acc-wallet', assetId: 'a-btc', quantity: 0.045, price: 58200, fees: 4.5 },
      { id: 't13', date: d(-1, '09-09'), type: 'deposito', accountId: 'acc-banca', amount: 5000, fees: 0 },
      { id: 't14', date: d(-1, '12-31'), type: 'interessi', accountId: 'acc-banca', amount: 111, fees: 0, note: 'Netto imposte' },
      { id: 't15', date: d(-1, '12-31'), type: 'commissione', accountId: 'acc-banca', amount: 12.5, fees: 0, note: 'Imposta di bollo' },
      { id: 't16', date: d(0, '01-15'), type: 'deposito', accountId: 'acc-broker', amount: 4000, fees: 0 },
      { id: 't17', date: d(0, '01-16'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-gold', quantity: 8, price: 221.4, fees: 2.95 },
      { id: 't18', date: d(0, '01-16'), type: 'acquisto', accountId: 'acc-broker', assetId: 'a-vwce', quantity: 15, price: 131.8, fees: 2.95 },
      { id: 't19', date: d(0, '01-24'), type: 'dividendo', accountId: 'acc-broker', assetId: 'a-enel', amount: 72.15, fees: 0 },
    ].filter((t) => t.date <= todayIso) as AppData['transactions'],
    snapshots: [],
  };

  // Storico mensile plausibile degli ultimi 12 mesi: capitale versato reale, patrimonio simulato.
  const start = new Date(year - 1, Number(todayIso.slice(5, 7)) - 1, 1);
  for (let i = 0; i < 12; i++) {
    const dt = new Date(start.getFullYear(), start.getMonth() + i, 1);
    const iso = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-01`;
    const invested = data.transactions
      .filter((t) => t.date <= iso)
      .reduce((s, t) => s + (t.type === 'deposito' ? t.amount ?? 0 : t.type === 'prelievo' ? -(t.amount ?? 0) : 0), 0);
    const growth = 1 + 0.12 + 0.05 * (i / 11) + 0.02 * Math.sin(i * 1.3);
    data.snapshots.push({ date: iso, invested, netWorth: Math.round(invested * growth) });
  }
  return data;
}
