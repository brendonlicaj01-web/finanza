import type { Provider } from './types.ts';
import { ibkr } from './ibkr.ts';
import { binance, coinbase, kraken } from './crypto.ts';
import { bitpanda } from './bitpanda.ts';
import { etoro } from './etoro.ts';
import { enablebanking } from './enablebanking.ts';
import { mock, mockBank } from './mock.ts';

export const providers: Provider[] = [
  ibkr,
  etoro,
  binance,
  kraken,
  coinbase,
  bitpanda,
  enablebanking,
];

if (process.env.FINANZA_MOCK === '1') providers.unshift(mock, mockBank);
