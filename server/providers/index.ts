import type { Provider } from './types.ts';
import { ibkr } from './ibkr.ts';
import { binance, coinbase, kraken, okx } from './crypto.ts';
import { bitpanda } from './bitpanda.ts';
import { mock } from './mock.ts';

const soon = (id: string, label: string, category: Provider['category'], description: string): Provider => ({
  id,
  label,
  category,
  description,
  available: false,
  fields: [],
  guide: [],
  async test() {},
  async sync() {
    throw new Error('Non ancora disponibile');
  },
});

export const providers: Provider[] = [
  ibkr,
  soon('etoro', 'eToro', 'broker', 'Posizioni e saldi tramite API pubblica eToro. In arrivo.'),
  binance,
  kraken,
  coinbase,
  okx,
  bitpanda,
  soon('enablebanking', 'Conti bancari (Enable Banking)', 'banca', 'Saldi e movimenti dei conti correnti via open banking PSD2. In arrivo.'),
];

if (process.env.FINANZA_MOCK === '1') providers.unshift(mock);
