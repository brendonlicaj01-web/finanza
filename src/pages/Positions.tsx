import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { aggregateByAsset } from '../lib/portfolio';
import { ASSET_TYPES } from '../lib/types';
import { money, price, pct, qty } from '../lib/format';
import { Card, Delta, Empty, PageHead } from '../components/ui';

const TYPE_LABELS = new Map(ASSET_TYPES.map((t) => [t.value, t.label]));

export function Positions() {
  const { data, result } = useStore();
  const [showClosed, setShowClosed] = useState(false);
  const [byAccount, setByAccount] = useState(false);

  const aggregated = useMemo(() => aggregateByAsset(result, data), [result, data]);
  const rows = aggregated.filter((p) => showClosed || p.quantity > 0);
  const totals = rows.reduce(
    (t, p) => ({
      value: t.value + p.marketValue,
      cost: t.cost + p.cost,
      unrealized: t.unrealized + p.unrealized,
      realized: t.realized + p.realized,
      income: t.income + p.income,
    }),
    { value: 0, cost: 0, unrealized: 0, realized: 0, income: 0 },
  );

  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const perAccount = result.positions
    .filter((p) => showClosed || p.quantity > 0)
    .sort((a, b) => b.marketValue - a.marketValue);

  return (
    <div className="stack">
      <PageHead
        title="Posizioni"
        sub="Prezzo medio calcolato con il metodo del costo medio ponderato, commissioni incluse."
        actions={
          <>
            <label className="check small">
              <input type="checkbox" checked={byAccount} onChange={(e) => setByAccount(e.target.checked)} />
              Dettaglio per conto
            </label>
            <label className="check small">
              <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
              Mostra posizioni chiuse
            </label>
          </>
        }
      />
      <Card>
        {rows.length === 0 ? (
          <Empty title="Nessuna posizione">
            <p>Registra un acquisto nella sezione Transazioni per vedere qui le tue posizioni.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strumento</th>
                  {byAccount && <th>Conto</th>}
                  <th className="num">Quantità</th>
                  <th className="num">Prezzo medio</th>
                  <th className="num">Prezzo attuale</th>
                  <th className="num">Valore</th>
                  {!byAccount && <th className="num hide-mobile">Peso</th>}
                  <th className="num">P&L latente</th>
                  <th className="num hide-mobile">Realizzato</th>
                  <th className="num hide-mobile">Proventi</th>
                </tr>
              </thead>
              <tbody>
                {byAccount
                  ? perAccount.map((p) => {
                      const asset = assets.get(p.assetId);
                      if (!asset) return null;
                      return (
                        <tr key={`${p.accountId}-${p.assetId}`}>
                          <td>
                            <div className="cell-title">{asset.symbol}</div>
                            <div className="cell-sub">{asset.name}</div>
                          </td>
                          <td>{accounts.get(p.accountId)?.name}</td>
                          <td className="num">{qty(p.quantity)}</td>
                          <td className="num">{p.quantity > 0 ? price(p.avgPrice) : '—'}</td>
                          <td className="num">{price(asset.price)}</td>
                          <td className="num">{money(p.marketValue)}</td>
                          <td className="num">
                            <Delta value={p.unrealized} />
                            <div className="cell-sub">{pct(p.unrealizedPct, { sign: true })}</div>
                          </td>
                          <td className="num hide-mobile">
                            <Delta value={p.realized} />
                          </td>
                          <td className="num hide-mobile">{money(p.income)}</td>
                        </tr>
                      );
                    })
                  : rows.map((p) => (
                      <tr key={p.asset.id}>
                        <td>
                          <div className="cell-title">
                            {p.asset.symbol} <span className="badge">{TYPE_LABELS.get(p.asset.type)}</span>
                          </div>
                          <div className="cell-sub">
                            {p.asset.name}
                            {p.accounts.length > 0 && ` · ${p.accounts.map((a) => a.name).join(', ')}`}
                          </div>
                        </td>
                        <td className="num">{qty(p.quantity)}</td>
                        <td className="num">{p.quantity > 0 ? price(p.avgPrice) : '—'}</td>
                        <td className="num">{price(p.asset.price)}</td>
                        <td className="num">{money(p.marketValue)}</td>
                        <td className="num hide-mobile">{pct(p.weight)}</td>
                        <td className="num">
                          <Delta value={p.unrealized} />
                          <div className="cell-sub">{pct(p.unrealizedPct, { sign: true })}</div>
                        </td>
                        <td className="num hide-mobile">
                          <Delta value={p.realized} />
                        </td>
                        <td className="num hide-mobile">{money(p.income)}</td>
                      </tr>
                    ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={byAccount ? 5 : 4}>Totale</td>
                  <td className="num">{money(totals.value)}</td>
                  {!byAccount && <td className="num hide-mobile">{totals.value > 0 ? '100%' : ''}</td>}
                  <td className="num">
                    <Delta value={totals.unrealized} />
                  </td>
                  <td className="num hide-mobile">
                    <Delta value={totals.realized} />
                  </td>
                  <td className="num hide-mobile">{money(totals.income)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
