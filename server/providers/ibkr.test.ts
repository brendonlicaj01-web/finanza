import { describe, expect, it } from 'vitest';
import { flexDate, parseFlexStatement } from './ibkr.ts';

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="finanza" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20250101" toDate="20251231" period="Last365CalendarDays" whenGenerated="20251231;120000">
<AccountInformation accountId="U1234567" currency="EUR" name="Mario Rossi" />
<Trades>
<Trade accountId="U1234567" currency="USD" fxRateToBase="0.9" assetCategory="STK" subCategory="COMMON" symbol="AAPL" description="APPLE INC" conid="265598" isin="US0378331005" tradeID="111" transactionID="9001" tradeDate="20250110" dateTime="20250110;153000" quantity="10" tradePrice="200" proceeds="-2000" ibCommission="-1" ibCommissionCurrency="USD" taxes="0" buySell="BUY" levelOfDetail="EXECUTION" multiplier="1" />
<Trade accountId="U1234567" currency="USD" fxRateToBase="0.9" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="265598" isin="US0378331005" tradeID="110" transactionID="9000" tradeDate="20250110" quantity="10" tradePrice="200" proceeds="-2000" ibCommission="-1" buySell="BUY" levelOfDetail="ORDER" />
<Trade accountId="U1234567" currency="EUR" fxRateToBase="1" assetCategory="STK" subCategory="ETF" symbol="VWCE" description="VANGUARD FTSE ALL-WORLD" conid="1" isin="IE00BK5BQT80" tradeID="112" transactionID="9002" tradeDate="20250301" quantity="-5" tradePrice="120" proceeds="600" ibCommission="-1.25" ibCommissionCurrency="EUR" buySell="SELL" levelOfDetail="EXECUTION" />
<Trade accountId="U1234567" currency="USD" fxRateToBase="0.9" assetCategory="CASH" symbol="EUR.USD" tradeID="113" transactionID="9003" tradeDate="20250109" quantity="2000" tradePrice="1.1" buySell="BUY" levelOfDetail="EXECUTION" />
</Trades>
<CashTransactions>
<CashTransaction currency="USD" fxRateToBase="0.9" assetCategory="STK" symbol="AAPL" isin="US0378331005" conid="265598" description="AAPL CASH DIVIDEND" dateTime="20250515;202000" amount="2.5" type="Dividends" transactionID="7001" levelOfDetail="DETAIL" />
<CashTransaction currency="USD" fxRateToBase="0.9" assetCategory="STK" symbol="AAPL" isin="US0378331005" conid="265598" description="AAPL US TAX" dateTime="20250515;202000" amount="-0.38" type="Withholding Tax" transactionID="7002" levelOfDetail="DETAIL" />
<CashTransaction currency="EUR" fxRateToBase="1" description="CASH RECEIPTS" dateTime="20250105" amount="5000" type="Deposits/Withdrawals" transactionID="7003" levelOfDetail="DETAIL" />
<CashTransaction currency="EUR" fxRateToBase="1" description="EUR CREDIT INT" dateTime="20250603" amount="3.1" type="Broker Interest Received" transactionID="7004" levelOfDetail="DETAIL" />
<CashTransaction currency="USD" fxRateToBase="0.9" description="MARKET DATA" dateTime="20250603" amount="-10" type="Other Fees" transactionID="7005" levelOfDetail="DETAIL" />
<CashTransaction currency="EUR" fxRateToBase="1" description="SUMMARY" dateTime="20250603" amount="999" type="Deposits/Withdrawals" levelOfDetail="SUMMARY" />
</CashTransactions>
<OpenPositions>
<OpenPosition currency="USD" fxRateToBase="0.92" assetCategory="STK" symbol="AAPL" description="APPLE INC" conid="265598" isin="US0378331005" position="10" markPrice="230" positionValue="2300" costBasisMoney="2001" levelOfDetail="SUMMARY" />
<OpenPosition currency="EUR" fxRateToBase="1" assetCategory="STK" subCategory="ETF" symbol="VWCE" description="VANGUARD FTSE ALL-WORLD" conid="1" isin="IE00BK5BQT80" position="15" markPrice="130" positionValue="1950" costBasisMoney="1500" levelOfDetail="SUMMARY" />
<OpenPosition currency="EUR" fxRateToBase="1" assetCategory="STK" symbol="VWCE" isin="IE00BK5BQT80" position="15" levelOfDetail="LOT" />
</OpenPositions>
<CashReport>
<CashReportCurrency currency="BASE_SUMMARY" endingCash="3210.55" />
<CashReportCurrency currency="EUR" endingCash="3000" />
</CashReport>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

describe('parseFlexStatement', () => {
  const r = parseFlexStatement(XML, 'EUR');

  it('importa solo le esecuzioni e ignora le conversioni valutarie', () => {
    const trades = r.transactions.filter((t) => t.externalId.startsWith('ibkr:trade:'));
    expect(trades.map((t) => t.externalId)).toEqual(['ibkr:trade:9001', 'ibkr:trade:9002']);
    const [buy, sell] = trades;
    expect(buy).toMatchObject({ type: 'acquisto', date: '2025-01-10', assetKey: 'US0378331005', quantity: 10 });
    expect(buy.price).toBeCloseTo(180); // 200 USD × 0,9
    expect(buy.fees).toBeCloseTo(0.9);
    expect(sell).toMatchObject({ type: 'vendita', quantity: 5, price: 120, fees: 1.25 });
  });

  it('classifica i movimenti di cassa e sottrae la ritenuta al dividendo', () => {
    const byId = Object.fromEntries(r.transactions.map((t) => [t.externalId, t]));
    expect(byId['ibkr:cash:7001']).toMatchObject({ type: 'dividendo', assetKey: 'US0378331005', amount: 2.25, fees: 0.34 });
    expect(byId['ibkr:cash:7002']).toBeUndefined();
    expect(byId['ibkr:cash:7003']).toMatchObject({ type: 'deposito', amount: 5000, date: '2025-01-05' });
    expect(byId['ibkr:cash:7004']).toMatchObject({ type: 'interessi', amount: 3.1 });
    expect(byId['ibkr:cash:7005']).toMatchObject({ type: 'commissione', amount: 9 });
    expect(r.transactions.some((t) => t.amount === 999)).toBe(false);
  });

  it('legge posizioni, prezzi in valuta base, costo di carico e liquidità', () => {
    expect(r.holdings).toHaveLength(2);
    const aapl = r.holdings!.find((h) => h.assetKey === 'US0378331005')!;
    expect(aapl.quantity).toBe(10);
    expect(aapl.costPrice).toBeCloseTo(184.092);
    const asset = r.assets.find((a) => a.key === 'US0378331005')!;
    expect(asset).toMatchObject({ symbol: 'AAPL', type: 'azione', isin: 'US0378331005' });
    expect(asset.price).toBeCloseTo(211.6);
    expect(r.assets.find((a) => a.key === 'IE00BK5BQT80')!.type).toBe('etf');
    expect(r.cash).toBe(3210.55);
    expect(r.accountName).toBe('Interactive Brokers U1234567');
    expect(r.warnings).toEqual([]);
  });

  it('segnala una valuta base diversa', () => {
    expect(parseFlexStatement(XML, 'CHF').warnings[0]).toMatch(/valuta base/);
  });
});

describe('flexDate', () => {
  it('accetta i formati di data Flex', () => {
    expect(flexDate('20250115')).toBe('2025-01-15');
    expect(flexDate('2025-01-15, 09:30:00')).toBe('2025-01-15');
    expect(flexDate('20250115;093000')).toBe('2025-01-15');
    expect(flexDate('')).toBe('');
  });
});
