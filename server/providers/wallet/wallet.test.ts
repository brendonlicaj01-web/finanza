import { describe, expect, it } from 'vitest';
import { detectFamily, parseAddresses } from './detect.ts';
import { deriveAddress, esploraMovements, readEsplora, scriptsFor, usedAddresses } from './utxo.ts';
import { EVM_CHAINS, ScanUnavailable, evmMovements, isSpamToken, makeScan, readEvm, type Scan } from './evm.ts';
import { solanaMovements, type SolTx } from './solana.ts';
import { tronHex, tronMovements } from './tron.ts';
import { xrpMovements } from './others.ts';
import { PriceBook } from './prices.ts';
import { walletToSync } from './index.ts';
import { readZerion, zerionMovements, type ZTransaction } from './zerion.ts';
import { fromUnits } from './http.ts';
import { emptyChainData, type ChainData } from './types.ts';
import { mergeSync } from '../../../src/lib/sync.ts';
import { computePortfolio } from '../../../src/lib/portfolio.ts';
import { findTransfers } from '../../../src/lib/transfers.ts';
import { emptyData } from '../../../src/lib/types.ts';

const ME = '0x1111111111111111111111111111111111111111';
const OTHER = '0x2222222222222222222222222222222222222222';
const T = (iso: string) => String(Date.parse(iso) / 1000);

/** Prezzi fissi per i test: niente rete. */
const fixedPrices = (table: Record<string, number>) => ({
  at: (s: string) => table[s.toUpperCase()],
  latest: (s: string) => table[s.toUpperCase()],
  has: (s: string) => s.toUpperCase() in table,
});

describe('riconoscimento degli indirizzi', () => {
  it('capisce la rete dal formato', () => {
    expect(detectFamily('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu')).toBe('bitcoin');
    expect(detectFamily('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe('bitcoin');
    expect(detectFamily('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')).toBe('bitcoin');
    expect(detectFamily('zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs')).toBe('bitcoin-xpub');
    expect(detectFamily(ME)).toBe('evm');
    expect(detectFamily('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV')).toBe('solana');
    expect(detectFamily('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('tron');
    expect(detectFamily('rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh')).toBe('xrp');
    expect(detectFamily('ltc1qg82vq0s2wlnnvsv6dfa3v2n3pj3cjh0hx3dk3p')).toBe('litecoin');
    expect(detectFamily('DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L')).toBe('dogecoin');
    expect(detectFamily('GAHK7EEG2WWHVKDNT4CEQFZGKF2LGDSW2IVM4S5DP42RBW3K6BTODB4A')).toBe('stellar');
    expect(detectFamily('EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N')).toBe('ton');
    expect(detectFamily('una frase segreta')).toBeUndefined();
  });

  it('legge un elenco con nomi, commenti e doppioni', () => {
    const { valid, invalid } = parseAddresses(`Ledger bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu\n# commento\n\nMetaMask ${ME.toUpperCase().replace('0X', '0x')}\n${ME}\nparola`);
    expect(valid).toEqual([
      { address: 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', family: 'bitcoin' },
      { address: ME, family: 'evm' },
    ]);
    expect(invalid).toEqual(['parola']);
  });
});

describe('Bitcoin', () => {
  it('deriva gli indirizzi dalle chiavi pubbliche estese (vettori ufficiali BIP84 e BIP49)', () => {
    const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    expect(scriptsFor(zpub)).toEqual(['p2wpkh']);
    expect(deriveAddress(zpub, 'p2wpkh', 0, 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
    expect(deriveAddress(zpub, 'p2wpkh', 0, 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
    expect(deriveAddress(zpub, 'p2wpkh', 1, 0)).toBe('bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el');
  });

  it('trova gli indirizzi usati con il limite di 20 vuoti', async () => {
    const zpub = 'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
    const usedSet = new Set([deriveAddress(zpub, 'p2wpkh', 0, 0), deriveAddress(zpub, 'p2wpkh', 0, 5), deriveAddress(zpub, 'p2wpkh', 1, 0)]);
    const calls: string[] = [];
    const get = async <R,>(url: string) => {
      calls.push(url);
      const a = url.split('/address/')[1];
      return { chain_stats: { tx_count: usedSet.has(a) ? 2 : 0 } } as R;
    };
    const used = await usedAddresses(zpub, get);
    expect(new Set(used)).toEqual(usedSet);
    // Ricezione: indirizzi 0-19 e 20-39 (l'ultimo usato è il 5), resto: 0-19 e 20-39.
    expect(calls).toHaveLength(80);
  });

  it('calcola entrate, uscite e commissione rispetto agli indirizzi propri', () => {
    const own = new Set(['bc1me', 'bc1change']);
    const txs = [
      // Ricevuti 0,5 BTC.
      { txid: 'a', fee: 500, status: { confirmed: true, block_time: 1_700_000_000 }, vin: [{ prevout: { scriptpubkey_address: 'bc1x', value: 60_000_000 } }], vout: [{ scriptpubkey_address: 'bc1me', value: 50_000_000 }, { scriptpubkey_address: 'bc1x', value: 9_999_500 }] },
      // Inviati 0,2 BTC con resto a sé stessi e 1.000 sat di commissione.
      { txid: 'b', fee: 1000, status: { confirmed: true, block_time: 1_700_100_000 }, vin: [{ prevout: { scriptpubkey_address: 'bc1me', value: 50_000_000 } }], vout: [{ scriptpubkey_address: 'bc1y', value: 20_000_000 }, { scriptpubkey_address: 'bc1change', value: 29_999_000 }] },
      // Non confermata: ignorata.
      { txid: 'c', fee: 1, status: { confirmed: false }, vin: [], vout: [{ scriptpubkey_address: 'bc1me', value: 1 }] },
    ];
    expect(esploraMovements('bitcoin', 'BTC', txs, own)).toEqual([
      { chain: 'bitcoin', hash: 'a', time: 1_700_000_000_000, symbol: 'BTC', amount: 0.5, fee: undefined },
      { chain: 'bitcoin', hash: 'b', time: 1_700_100_000_000, symbol: 'BTC', amount: -0.2, fee: 0.00001 },
    ]);
  });

  it('legge saldo e storico paginato da un\'API Esplora', async () => {
    const pages: Record<string, unknown> = {
      'https://mempool.space/api/address/bc1me': { chain_stats: { funded_txo_sum: 150_000_000, spent_txo_sum: 50_000_000, tx_count: 26 } },
      'https://mempool.space/api/address/bc1me/txs/chain': Array.from({ length: 25 }, (_, i) => ({ txid: `t${i}`, status: { confirmed: true, block_time: 1_700_000_000 + i }, vin: [], vout: [{ scriptpubkey_address: 'bc1me', value: 1_000_000 }] })),
      'https://mempool.space/api/address/bc1me/txs/chain/t24': [{ txid: 't25', status: { confirmed: true, block_time: 1_600_000_000 }, vin: [], vout: [{ scriptpubkey_address: 'bc1me', value: 75_000_000 }] }],
    };
    const d = await readEsplora('bitcoin', ['bc1me'], async <R,>(url: string) => pages[url] as R);
    expect(d.balances.get('BTC')).toBe(1);
    expect(d.movements).toHaveLength(26);
  });
});

describe('Ethereum e reti compatibili', () => {
  const eth = EVM_CHAINS[0];
  const normal = [
    // Ricevuti 1 ETH.
    { hash: '0xa', timeStamp: T('2025-01-01'), from: OTHER, to: ME, value: '1000000000000000000', gasUsed: '21000', gasPrice: '1', isError: '0' },
    // Inviati 0,4 ETH, gas 21000 × 10 gwei.
    { hash: '0xb', timeStamp: T('2025-02-01'), from: ME, to: OTHER, value: '400000000000000000', gasUsed: '21000', gasPrice: '10000000000', isError: '0' },
    // Transazione fallita: si paga solo il gas.
    { hash: '0xc', timeStamp: T('2025-03-01'), from: ME, to: OTHER, value: '5000000000000000000', gasUsed: '30000', gasPrice: '10000000000', isError: '1' },
  ];
  const tokens = [
    { hash: '0xd', timeStamp: T('2025-04-01'), from: OTHER, to: ME, value: '250000000', contractAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimal: '6' },
    // USDC falso (contratto diverso) e token pubblicitario: ignorati.
    { hash: '0xe', timeStamp: T('2025-04-02'), from: OTHER, to: ME, value: '999000000', contractAddress: '0xbad0000000000000000000000000000000000bad', tokenSymbol: 'USDC', tokenName: 'USD Coin', tokenDecimal: '6' },
    { hash: '0xf', timeStamp: T('2025-04-03'), from: OTHER, to: ME, value: '1', contractAddress: '0xbad1', tokenSymbol: 'Visit x.com', tokenName: 'Claim reward', tokenDecimal: '0' },
    // Trasferimento a valore zero ("avvelenamento" della cronologia): ignorato.
    { hash: '0x10', timeStamp: T('2025-04-04'), from: ME, to: OTHER, value: '0', contractAddress: '0xdac17f958d2ee523a2206206994597c13d831ec7', tokenSymbol: 'USDT', tokenName: 'Tether USD', tokenDecimal: '6' },
  ];
  const internal = [{ hash: '0x11', timeStamp: T('2025-05-01'), from: '0xcontract', to: ME, value: '100000000000000000', isError: '0' }];

  it('ricava entrate, uscite, gas e token, scartando imitazioni e pubblicità', () => {
    const skipped = new Set<string>();
    const m = evmMovements(eth, ME, normal, internal, tokens, skipped);
    const by = Object.fromEntries(m.map((x) => [`${x.hash}:${x.symbol}`, x]));
    expect(by['0xa:ETH']).toMatchObject({ amount: 1, fee: undefined });
    expect(by['0xb:ETH'].amount).toBeCloseTo(-0.4, 12);
    expect(by['0xb:ETH'].fee).toBeCloseTo(0.00021, 12);
    expect(by['0xc:ETH']).toMatchObject({ amount: 0 });
    expect(by['0xc:ETH'].fee).toBeCloseTo(0.0003, 12);
    expect(by['0xd:USDC']).toMatchObject({ amount: 250 });
    expect(by['0x11:ETH']).toMatchObject({ amount: 0.1 });
    expect(by['0xe:USDC']).toBeUndefined();
    expect(Object.keys(by).some((k) => k.startsWith('0x10'))).toBe(false);
    expect(skipped.size).toBe(2);
  });

  it('riconosce le imitazioni dei token più diffusi', () => {
    expect(isSpamToken('ethereum', 'USDT', 'Tether USD', '0xdAC17F958D2ee523a2206206994597C13D831ec7')).toBe(false);
    expect(isSpamToken('ethereum', 'USDT', 'Tether USD', '0x1234')).toBe(true);
    expect(isSpamToken('ethereum', 'UNI', 'Uniswap', '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984')).toBe(false);
    expect(isSpamToken('ethereum', 'ETH', 'Ether', '0x1')).toBe(true);
    expect(isSpamToken('ethereum', 'ZKS', 'Visit zksync-claim.io', '0x1')).toBe(true);
  });

  it('cerca l\'indirizzo su tutte le reti e salta quelle vuote', async () => {
    const calls: string[] = [];
    const scan: Scan = async <R,>(chain: { id: string }, p: Record<string, string>) => {
      calls.push(`${chain.id}:${p.action}`);
      // BNB Chain non coperta da Routescan: si ripiega sul nodo pubblico.
      if (chain.id === 'bsc') throw new ScanUnavailable('404');
      if (chain.id !== 'base') return [] as R[];
      if (p.action === 'txlist') return normal as R[];
      if (p.action === 'tokentx') return [{ ...tokens[0], contractAddress: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' }] as R[];
      if (p.action === 'balance') return '600000000000000000';
      return [] as R[];
    };
    const rpcs: string[] = [];
    const get = (async (url: string) => {
      rpcs.push(url);
      return { result: url.includes('bnbchain') ? '0xde0b6b3a7640000' : '0x0' };
    }) as never;
    const d = await readEvm([ME], { scan, get, chains: EVM_CHAINS.filter((c) => ['ethereum', 'base', 'bsc'].includes(c.id)) });
    expect(d.balances.get('ETH')).toBeCloseTo(0.6);
    expect(d.balances.get('USDC')).toBe(250);
    // BNB Chain non coperta: solo saldo dal nodo pubblico, con il suggerimento della chiave Zerion.
    expect(d.balances.get('BNB')).toBe(1);
    expect(d.warnings.join(' ')).toMatch(/BNB Chain: letto solo il saldo della moneta della rete\. Per token e storico aggiungi una chiave Zerion/);
    expect(d.warnings.join(' ')).toMatch(/Reti EVM con movimenti: Base/);
    // Ethereum vuoto: solo il sondaggio (2 richieste), niente storico.
    expect(calls.filter((c) => c.startsWith('ethereum'))).toEqual(['ethereum:txlist', 'ethereum:tokentx']);
    expect(d.movements.every((m) => m.chain === 'base')).toBe(true);
  });
});

describe('Solana, Tron, XRP', () => {
  it('Solana: variazioni di SOL (commissione a parte) e token noti', () => {
    const me = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
    const tx: SolTx = {
      blockTime: 1_700_000_000,
      meta: {
        fee: 5000,
        preBalances: [2_000_005_000, 0],
        postBalances: [1_000_000_000, 1_000_000_000],
        preTokenBalances: [{ accountIndex: 2, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: me, uiTokenAmount: { amount: '0', decimals: 6 } }],
        postTokenBalances: [
          { accountIndex: 2, mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', owner: me, uiTokenAmount: { amount: '150000000', decimals: 6 } },
          { accountIndex: 3, mint: 'Unknown111111111111111111111111111111111111', owner: me, uiTokenAmount: { amount: '5', decimals: 0 } },
        ],
      },
      transaction: { message: { accountKeys: [{ pubkey: me }, { pubkey: 'Other' }] } },
    };
    const unknown = new Set<string>();
    expect(solanaMovements(me, 'sig', tx, unknown)).toEqual([
      { chain: 'solana', hash: 'sig', time: 1_700_000_000_000, symbol: 'SOL', amount: -1, fee: 0.000005 },
      { chain: 'solana', hash: 'sig', time: 1_700_000_000_000, symbol: 'USDC', amount: 150 },
    ]);
    expect(unknown.size).toBe(1);
  });

  it('Tron: TRX e USDT ufficiale, scartando le imitazioni', () => {
    const me = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    expect(tronHex(me)).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    const trx = [
      { txID: 't1', block_timestamp: 1_700_000_000_000, ret: [{ contractRet: 'SUCCESS', fee: 1_100_000 }], raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { amount: 5_000_000, owner_address: '41a614f803b6fd780986a42c78ec9c7f77e6ded13c', to_address: '41ffff' } } }] } },
    ];
    const trc20 = [
      { transaction_id: 'u1', block_timestamp: 1_700_000_100_000, from: 'TX', to: me, value: '25000000', token_info: { symbol: 'USDT', name: 'Tether USD', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 } },
      { transaction_id: 'u2', block_timestamp: 1_700_000_200_000, from: 'TX', to: me, value: '99000000', token_info: { symbol: 'USDT', name: 'Tether USD', address: 'TFakeUsdt', decimals: 6 } },
    ];
    const skipped = new Set<string>();
    expect(tronMovements(me, trx, trc20, skipped)).toEqual([
      { chain: 'tron', hash: 't1', time: 1_700_000_000_000, symbol: 'TRX', amount: -5, fee: 1.1 },
      { chain: 'tron', hash: 'u1', time: 1_700_000_100_000, symbol: 'USDT', amount: 25 },
    ]);
    expect(skipped.size).toBe(1);
  });

  it('XRP: variazione del saldo dai nodi modificati, commissione a parte', () => {
    const me = 'rMe';
    const entries = [
      { tx: { Account: 'rOther', Fee: '12', date: 700_000_000 }, hash: 'in', validated: true, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: me, Balance: '30000000' }, PreviousFields: { Balance: '10000000' } } }] } },
      { tx: { Account: me, Fee: '12', date: 700_100_000 }, hash: 'out', validated: true, meta: { TransactionResult: 'tesSUCCESS', AffectedNodes: [{ ModifiedNode: { LedgerEntryType: 'AccountRoot', FinalFields: { Account: me, Balance: '24999988' }, PreviousFields: { Balance: '30000000' } } }] } },
    ];
    expect(xrpMovements(me, entries)).toEqual([
      { chain: 'xrp', hash: 'in', time: (700_000_000 + 946_684_800) * 1000, symbol: 'XRP', amount: 20, fee: undefined },
      { chain: 'xrp', hash: 'out', time: (700_100_000 + 946_684_800) * 1000, symbol: 'XRP', amount: -5, fee: 0.000012 },
    ]);
  });
});

describe('prezzi', () => {
  it('usa la coppia in euro, altrimenti quella in USDT convertita, e 1/EURUSDT per le stablecoin', async () => {
    const day = (s: string) => Date.parse(`${s}T00:00:00Z`);
    const book = new PriceBook(
      {
        binanceDaily: async (pair: string): Promise<Record<string, number>> => {
          if (pair === 'BTCEUR') return { '2025-01-01': 90000 };
          if (pair === 'EURUSDT') return { '2025-01-01': 1.25 };
          if (pair === 'PEPEUSDT') return { '2025-01-01': 0.00002 };
          return {};
        },
        cryptocompareDaily: async () => ({}),
      },
      null,
    );
    await book.prepare(['BTC', 'PEPE', 'USDC', 'WBTC', 'NONEXISTENT', 'EURC'], day('2025-01-01'));
    expect(book.at('BTC', day('2025-01-01'))).toBe(90000);
    expect(book.at('WBTC', day('2025-01-03'))).toBe(90000); // stesso prezzo di BTC, ultimo giorno disponibile
    expect(book.at('PEPE', day('2025-01-01'))).toBeCloseTo(0.000016);
    expect(book.at('USDC', day('2025-01-01'))).toBeCloseTo(0.8);
    expect(book.at('EURC', day('2025-01-01'))).toBe(1);
    expect(book.has('NONEXISTENT')).toBe(false);
    expect(book.missing.has('NONEXISTENT')).toBe(true);
  });

  it('per gli anni prima delle coppie in euro usa CryptoCompare', async () => {
    const day = (x: string) => Date.parse(`${x}T00:00:00Z`);
    const book = new PriceBook(
      {
        binanceDaily: async (pair: string): Promise<Record<string, number>> => (pair === 'BTCEUR' ? { '2020-01-03': 6500 } : {}),
        cryptocompareDaily: async () => ({ '2018-01-01': 11000, '2020-01-03': 6400 }),
      },
      null,
    );
    await book.prepare(['BTC'], day('2018-01-01'));
    expect(book.at('BTC', day('2018-06-01'))).toBe(11000);
    expect(book.at('BTC', day('2020-01-03'))).toBe(6500); // Binance ha la precedenza
    expect(book.at('BTC', day('2017-01-01'))).toBe(11000); // prima della serie: il primo prezzo noto
  });

  it('Routescan: indirizzo senza chiave; una rete non coperta passa al nodo pubblico', async () => {
    const urls: string[] = [];
    const ok = makeScan((async (url: string) => {
      urls.push(url);
      return { status: '1', message: 'OK', result: [] };
    }) as never);
    await ok(EVM_CHAINS[2], { module: 'account', action: 'txlist', address: ME });
    expect(urls[0]).toBe(`https://api.routescan.io/v2/network/mainnet/evm/8453/etherscan/api?module=account&action=txlist&address=${ME}`);
    const missing = makeScan((async () => {
      throw new Error('Routescan ha risposto con errore 404.');
    }) as never);
    await expect(missing(EVM_CHAINS[7], { module: 'account', action: 'txlist', address: ME })).rejects.toBeInstanceOf(ScanUnavailable);
  });

  it('converte le quantità intere senza perdere precisione', () => {
    expect(fromUnits('1000000000000000000', 18)).toBe(1);
    expect(fromUnits('123', 6)).toBe(0.000123);
    expect(fromUnits('-250000000', 8)).toBe(-2.5);
  });
});

describe('dal wallet all\'app', () => {
  const chain = (movements: ChainData['movements'], balances: Record<string, number>): ChainData => ({
    ...emptyChainData(),
    movements,
    balances: new Map(Object.entries(balances)),
  });
  const prices = fixedPrices({ ETH: 3000, USDC: 0.9, BTC: 60000 });
  const day = (s: string) => Date.parse(`${s}T12:00:00Z`);

  it('entrate e uscite sono trasferimenti interni, gli scambi compravendite, il gas a parte', () => {
    const r = walletToSync(
      [
        chain(
          [
            { chain: 'ethereum', hash: '0xa', time: day('2025-01-01'), symbol: 'ETH', amount: 1 },
            // Invio con commissione: la commissione esce insieme all'invio.
            { chain: 'ethereum', hash: '0xb', time: day('2025-02-01'), symbol: 'ETH', amount: -0.4, fee: 0.001 },
            // Scambio su DEX: 0,1 ETH → 290 USDC, con gas.
            { chain: 'ethereum', hash: '0xc', time: day('2025-03-01'), symbol: 'ETH', amount: -0.1, fee: 0.002 },
            { chain: 'ethereum', hash: '0xc', time: day('2025-03-01'), symbol: 'USDC', amount: 290 },
            // Token senza prezzo: ignorato.
            { chain: 'ethereum', hash: '0xd', time: day('2025-03-02'), symbol: 'SHITCOIN', amount: 1e6 },
          ],
          { ETH: 0.497, USDC: 290, SHITCOIN: 1e6 },
        ),
      ],
      prices,
    );
    const by = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(by['wallet:ethereum:0xa:ETH']).toMatchObject({ type: 'trasf_entrata', quantity: 1, price: 3000 });
    expect(by['wallet:ethereum:0xb:ETH']).toMatchObject({ type: 'trasf_uscita', quantity: 0.401 });
    expect(by['wallet:ethereum:0xc:ETH']).toMatchObject({ type: 'vendita', quantity: 0.1, price: 3000 });
    // Costo dei 290 USDC = 0,1 ETH × 3000 € (non il prezzo di listino).
    expect(by['wallet:ethereum:0xc:USDC'].type).toBe('acquisto');
    expect(by['wallet:ethereum:0xc:USDC'].price! * 290).toBeCloseTo(300);
    expect(by['wallet:ethereum:0xc:gas']).toMatchObject({ type: 'trasf_uscita', quantity: 0.002 });
    expect(Object.keys(by).some((k) => k.includes('SHITCOIN'))).toBe(false);
    expect(r.holdings).toEqual([
      { assetKey: 'crypto:ETH', quantity: 0.497 },
      { assetKey: 'crypto:USDC', quantity: 290 },
    ]);
    expect(r.warnings.join(' ')).toMatch(/1 monete senza prezzo di mercato ignorate: SHITCOIN/);
    expect(r).toMatchObject({ accountKind: 'wallet', cash: 0, complete: true });

    // Nell'app: nessun allineamento necessario, liquidità a zero.
    const { data, stats } = mergeSync(emptyData(), { id: 'w', label: 'Ledger' }, r, '2025-06-01');
    expect(stats.adjustments).toBe(0);
    const p = computePortfolio(data);
    expect(p.warnings).toEqual([]);
    expect(p.cash[0].cash).toBeCloseTo(0);
  });

  it('BTC ritirato da un exchange e arrivato nel wallet: il costo di carico segue le monete', () => {
    let data = emptyData();
    // Exchange: acquisto e prelievo verso il wallet (etichettato come trasferimento dall'import OKX).
    data = mergeSync(data, { id: 'file:okx', label: 'OKX' }, {
      accountName: 'OKX',
      accountKind: 'wallet',
      currency: 'EUR',
      assets: [{ key: 'crypto:BTC', symbol: 'BTC', name: 'BTC', type: 'crypto' }],
      transactions: [
        { externalId: 'okx:1', date: '2025-01-02', type: 'deposito', amount: 2000, fees: 0 },
        { externalId: 'okx:2', date: '2025-01-03', type: 'acquisto', assetKey: 'crypto:BTC', quantity: 0.05, price: 40000, fees: 0 },
        { externalId: 'okx:3', date: '2025-06-10', type: 'trasf_uscita', assetKey: 'crypto:BTC', quantity: 0.05, price: 60000, fees: 0 },
      ],
      warnings: [],
    }, '2025-07-01').data;
    const r = walletToSync(
      [chain([{ chain: 'bitcoin', hash: 'tx1', time: day('2025-06-10'), symbol: 'BTC', amount: 0.0499 }], { BTC: 0.0499 })],
      prices,
    );
    data = mergeSync(data, { id: 'w', label: 'Ledger' }, r, '2025-07-01').data;
    const p = computePortfolio(data);
    const ledger = data.accounts.find((a) => a.name === 'Ledger')!;
    const pos = p.positions.find((x) => x.accountId === ledger.id)!;
    expect(pos.quantity).toBeCloseTo(0.0499);
    expect(pos.cost).toBeCloseTo(2000);
    expect(p.summary.realized).toBe(0);
    expect(findTransfers(data).pairs[0]).toMatchObject({ labeled: true, confidence: 'alta' });
  });
});

describe('Zerion (con chiave gratuita)', () => {
  const tx = (o: Partial<ZTransaction['attributes']>, chain = 'base'): ZTransaction => ({
    attributes: { hash: '0xh', mined_at: '2025-05-01T10:00:00Z', status: 'confirmed', sent_from: ME, ...o },
    relationships: { chain: { data: { id: chain } } },
  });

  it('interpreta invii, ricezioni e scambi con i valori in euro del momento', () => {
    // Scambio: 0,1 ETH → 300 USDC, commissione 0,0005 ETH pagata dall'utente.
    const swap = zerionMovements(ME, tx({
      operation_type: 'trade',
      fee: { fungible_info: { symbol: 'ETH' }, quantity: { float: 0.0005 }, price: 3000, value: 1.5 },
      transfers: [
        { fungible_info: { symbol: 'ETH' }, direction: 'out', quantity: { float: 0.1 }, price: 3000, value: 300 },
        { fungible_info: { symbol: 'USDC' }, direction: 'in', quantity: { float: 300 }, price: 0.92, value: 276 },
      ],
    }));
    expect(swap).toEqual([
      { chain: 'base', hash: '0xh', time: Date.parse('2025-05-01T10:00:00Z'), symbol: 'ETH', amount: -0.1, price: 3000, fee: 0.0005 },
      { chain: 'base', hash: '0xh', time: Date.parse('2025-05-01T10:00:00Z'), symbol: 'USDC', amount: 300, price: 0.92 },
    ]);
    // Ricezione (la commissione l'ha pagata chi invia) e quantità come numero semplice.
    const recv = zerionMovements(ME, tx({ sent_from: OTHER, fee: { fungible_info: { symbol: 'SOL' }, quantity: 0.000005 }, transfers: [{ fungible_info: { symbol: 'SOL' }, direction: 'in', quantity: 2, value: 300 }] }, 'solana'));
    expect(recv).toEqual([{ chain: 'solana', hash: '0xh', time: Date.parse('2025-05-01T10:00:00Z'), symbol: 'SOL', amount: 2, price: 150 }]);
    // Fallita: solo la commissione; NFT e movimenti "self" ignorati.
    const failed = zerionMovements(ME, tx({ status: 'failed', fee: { fungible_info: { symbol: 'ETH' }, quantity: { float: 0.001 }, price: 3000 }, transfers: [{ fungible_info: { symbol: 'ETH' }, direction: 'out', quantity: 1 }] }));
    expect(failed).toEqual([{ chain: 'base', hash: '0xh', time: Date.parse('2025-05-01T10:00:00Z'), symbol: 'ETH', amount: 0, fee: 0.001, price: 3000 }]);
    expect(zerionMovements(ME, tx({ transfers: [{ fungible_info: null, direction: 'in', quantity: 1 }, { fungible_info: { symbol: 'ETH' }, direction: 'self', quantity: 1 }] }))).toEqual([]);
  });

  it('pagina lo storico, legge i saldi e usa l\'autenticazione Basic', async () => {
    const seen: { url: string; auth?: string }[] = [];
    const get = (async (url: string, init: { headers?: Record<string, string> }) => {
      seen.push({ url, auth: init.headers?.Authorization });
      if (url.includes('/positions/')) {
        return { data: [
          { attributes: { position_type: 'wallet', quantity: { float: 0.4 }, price: 3100, fungible_info: { symbol: 'ETH' } } },
          { attributes: { position_type: 'wallet', quantity: { float: 5 }, price: 1, fungible_info: { symbol: 'SCAM' }, flags: { is_trash: true } } },
        ] };
      }
      if (url.includes('page2')) return { data: [tx({ hash: '0x2', transfers: [{ fungible_info: { symbol: 'ETH' }, direction: 'out', quantity: 0.6, price: 3000 }] })], links: {} };
      return { data: [tx({ hash: '0x1', sent_from: OTHER, transfers: [{ fungible_info: { symbol: 'ETH' }, direction: 'in', quantity: 1, price: 2000 }] })], links: { next: 'https://api.zerion.io/v1/page2' } };
    }) as never;
    const d = await readZerion([ME], 'zk_dev_test', get);
    expect(d.movements.map((m) => [m.hash, m.amount])).toEqual([['0x1', 1], ['0x2', -0.6]]);
    expect([...d.balances]).toEqual([['ETH', 0.4]]);
    expect(d.prices?.get('ETH')).toBe(3100);
    expect(seen[0].url).toContain(`/wallets/${ME}/transactions/?currency=eur&page[size]=100&filter[trash]=only_non_trash`);
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('zk_dev_test:').toString('base64')}`);
  });

  it('chiave non valida: messaggio chiaro', async () => {
    const get = (async () => {
      throw new Error('Zerion ha risposto con errore 401.');
    }) as never;
    await expect(readZerion([ME], 'sbagliata', get)).rejects.toThrow(/Zerion: chiave API non valida/);
  });

  it('i prezzi della fonte valgono anche per monete che Binance non conosce', () => {
    const chains: ChainData[] = [{
      ...emptyChainData(),
      movements: [{ chain: 'base', hash: '0xa', time: Date.parse('2025-05-01T10:00:00Z'), symbol: 'AERO', amount: 100, price: 0.5 }],
      balances: new Map([['AERO', 100]]),
      prices: new Map([['AERO', 0.8]]),
    }];
    const r = walletToSync(chains, fixedPrices({}));
    expect(r.transactions[0]).toMatchObject({ type: 'trasf_entrata', quantity: 100, price: 0.5 });
    expect(r.assets[0]).toMatchObject({ symbol: 'AERO', price: 0.8 });
    expect(r.holdings).toEqual([{ assetKey: 'crypto:AERO', quantity: 100 }]);
  });
});
