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

/** Banca fittizia con flusso di autorizzazione simulato. Attiva solo con FINANZA_MOCK=1. */
export const mockBank: Provider = {
  id: 'mockbank',
  label: 'Banca di prova',
  category: 'banca',
  description: 'Open banking simulato (solo con FINANZA_MOCK=1).',
  available: true,
  requiresAuth: true,
  fields: [
    { key: 'applicationId', label: 'ID applicazione (qualsiasi)' },
    {
      key: 'movements',
      label: 'Cosa importare',
      options: [
        { value: 'saldo', label: 'Solo il saldo' },
        { value: 'movimenti', label: 'Saldo e movimenti' },
      ],
    },
  ],
  guide: ['Redirect URL da registrare: {redirectUrl}'],
  auth: {
    async listBanks(_c, country) {
      return [
        { name: 'Banca Alfa', country },
        { name: 'Banca Beta', country },
      ];
    },
    async startAuth(_c, _bank, redirectUrl, state) {
      // La "banca" rimanda subito indietro con un codice valido.
      return `${redirectUrl}?code=codice-prova&state=${encodeURIComponent(state)}`;
    },
    async completeAuth(_c, code) {
      if (code !== 'codice-prova') throw new ProviderError('Codice non valido.');
      return {
        sessionId: 'sessione-prova',
        validUntil: new Date(Date.now() + 10 * 86_400_000).toISOString(),
        bank: 'Banca Alfa',
      };
    },
    status(c) {
      return { authorized: !!c.sessionId, validUntil: c.validUntil, bank: c.bank };
    },
  },
  async test() {},
  async sync(c, { currency }) {
    if (!c.sessionId) throw new ProviderError('Autorizza prima l\'accesso alla banca.');
    return {
      accountName: 'Banca Alfa',
      accountKind: 'banca',
      currency,
      assets: [],
      transactions:
        c.movements === 'movimenti'
          ? [
              { externalId: 'mb:1', date: '2026-08-27', type: 'deposito', amount: 1800, fees: 0, note: 'Stipendio' },
              { externalId: 'mb:2', date: '2026-09-02', type: 'prelievo', amount: 64.3, fees: 0, note: 'Supermercato' },
            ]
          : [],
      cash: 2500.5,
      warnings: ['Il consenso della banca scade tra 10 giorni: rinnovalo per continuare a sincronizzare.'],
    };
  },
};
