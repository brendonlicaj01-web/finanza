import { ProviderError, type Provider } from './types.ts';

/** Fonte fittizia per provare il flusso senza rete. Attiva solo con FINANZA_MOCK=1. */
export const mock: Provider = {
  id: 'mock',
  label: 'Broker di prova',
  category: 'broker',
  description: 'Dati fittizi per provare la sincronizzazione (solo con FINANZA_MOCK=1).',
  available: true,
  fields: [{ key: 'apiKey', label: 'API key (qualsiasi, "errore" per simulare un rifiuto)', secret: true }],
  guide: ['Inserisci un valore qualsiasi.'],
  async test({ apiKey }) {
    if (apiKey === 'errore') throw new ProviderError('Broker di prova: chiave rifiutata (simulazione).');
  },
  async sync(_c, { currency }) {
    return {
      accountName: 'Broker di prova',
      accountKind: 'broker',
      currency,
      assets: [
        { key: 'IE00BK5BQT80', symbol: 'VWCE', name: 'Vanguard FTSE All-World', type: 'etf', isin: 'IE00BK5BQT80', price: 142.3 },
        { key: 'US0378331005', symbol: 'AAPL', name: 'Apple Inc.', type: 'azione', isin: 'US0378331005', price: 211.6 },
      ],
      transactions: [
        { externalId: 'mock:1', date: '2025-10-01', type: 'deposito', amount: 3000, fees: 0 },
        { externalId: 'mock:2', date: '2025-10-02', type: 'acquisto', assetKey: 'IE00BK5BQT80', quantity: 10, price: 128, fees: 2 },
        { externalId: 'mock:3', date: '2026-02-10', type: 'acquisto', assetKey: 'US0378331005', quantity: 5, price: 190, fees: 1 },
        { externalId: 'mock:4', date: '2026-05-15', type: 'dividendo', assetKey: 'US0378331005', amount: 1.1, fees: 0.17 },
      ],
      holdings: [
        { assetKey: 'IE00BK5BQT80', quantity: 30, costPrice: 101.5 },
        { assetKey: 'US0378331005', quantity: 5 },
      ],
      cash: 812.4,
      warnings: ['Dati di prova: non sono reali.'],
    };
  },
};
