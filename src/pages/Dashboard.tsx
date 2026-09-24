import { useMemo } from 'react';
import { useStore } from '../store';
import { aggregateByAsset, allocationByAccount, allocationByType } from '../lib/portfolio';
import { ASSET_TYPES, type AssetType } from '../lib/types';
import { money, pct, today } from '../lib/format';
import { demoData } from '../lib/demo';
import { AllocationBars, NetWorthChart } from '../components/charts';
import { Card, Delta, Empty, PageHead, Tile } from '../components/ui';
import type { Page } from '../App';

const TYPE_LABELS = Object.fromEntries(ASSET_TYPES.map((t) => [t.value, t.label])) as Record<AssetType, string>;

export function Dashboard({ go }: { go: (p: Page) => void }) {
  const { data, result, dispatch } = useStore();
  const s = result.summary;
  const byType = useMemo(() => allocationByType(result, data, TYPE_LABELS), [result, data]);
  const byAccount = useMemo(() => allocationByAccount(result, data), [result, data]);
  const top = useMemo(
    () => aggregateByAsset(result, data).filter((p) => p.quantity > 0).slice(0, 5),
    [result, data],
  );

  if (data.transactions.length === 0) {
    return (
      <>
        <PageHead title="Panoramica" />
        <Card>
          <Empty title="Benvenuto in Finanza">
            <p>
              Tieni traccia di conti, investimenti e liquidità in un unico posto. I dati restano solo nel tuo
              browser.
            </p>
            <p className="small muted">
              Per iniziare: crea un conto, aggiungi gli strumenti che possiedi e registra le transazioni.
            </p>
            <div className="row">
              <button className="btn btn-primary" onClick={() => go(data.accounts.length ? 'transazioni' : 'conti')}>
                {data.accounts.length ? 'Registra una transazione' : 'Crea il primo conto'}
              </button>
              <button className="btn" onClick={() => dispatch({ type: 'replace', data: demoData(today()) })}>
                Carica dati di esempio
              </button>
            </div>
          </Empty>
        </Card>
      </>
    );
  }

  const gainBase = data.settings.trackCash && s.netDeposits > 0 ? s.netDeposits : s.cost;
  const outdated = data.assets.filter(
    (a) => result.positions.some((p) => p.assetId === a.id && p.quantity > 0) && isStale(a.priceUpdatedAt),
  );

  return (
    <div className="stack">
      <PageHead title="Panoramica" />

      {result.warnings.length > 0 && (
        <div className="alert" role="alert">
          <strong>Controlla le transazioni</strong>
          <ul>
            {result.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {outdated.length > 0 && (
        <div className="alert">
          Prezzi non aggiornati da oltre 7 giorni: {outdated.map((a) => a.symbol).join(', ')}.{' '}
          <a href="#strumenti" onClick={() => go('strumenti')}>
            Aggiorna i prezzi
          </a>
        </div>
      )}

      <Card>
        <div className="hero">
          <div>
            <div className="hero-label">Patrimonio totale</div>
            <div className="hero-value">{money(s.netWorth)}</div>
          </div>
          <div className="hero-delta">
            <Delta value={s.totalGain} percent={gainBase > 0 ? s.totalGain / gainBase : undefined} />{' '}
            <span className="muted">guadagno complessivo</span>
          </div>
        </div>
      </Card>

      <div className="tiles">
        <Tile label="Investimenti" value={money(s.marketValue)} sub={`Costo di carico ${money(s.cost)}`} />
        {data.settings.trackCash && (
          <Tile label="Liquidità" value={money(s.cash)} sub={`Versato netto ${money(s.netDeposits)}`} />
        )}
        <Tile
          label="P&L latente"
          value={<Delta value={s.unrealized} />}
          sub={`${pct(s.unrealizedPct, { sign: true })} sul costo`}
        />
        <Tile label="P&L realizzato" value={<Delta value={s.realized} />} sub="Da vendite chiuse" />
        <Tile label="Dividendi e interessi" value={money(s.income)} sub={`Costi extra ${money(s.fees)}`} />
        <Tile
          label="Imposte stimate"
          value={money(s.estimatedTax)}
          sub="Su plusvalenze latenti, se vendessi oggi"
        />
      </div>

      {data.snapshots.length >= 2 && (
        <Card title="Andamento" sub="Una fotografia al giorno, registrata quando usi l'app">
          <NetWorthChart snapshots={data.snapshots} />
        </Card>
      )}

      <div className="grid-2">
        <Card title="Allocazione per tipo">
          {byType.length ? <AllocationBars slices={byType} /> : <p className="muted">Nessuna posizione.</p>}
        </Card>
        <Card title="Allocazione per conto">
          {byAccount.length ? <AllocationBars slices={byAccount} /> : <p className="muted">Nessun conto.</p>}
        </Card>
      </div>

      <Card
        title="Principali posizioni"
        actions={
          <button className="btn btn-ghost" onClick={() => go('posizioni')}>
            Vedi tutte
          </button>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Strumento</th>
                <th className="num">Valore</th>
                <th className="num hide-mobile">Peso</th>
                <th className="num">P&L latente</th>
              </tr>
            </thead>
            <tbody>
              {top.map((p) => (
                <tr key={p.asset.id}>
                  <td>
                    <div className="cell-title">{p.asset.symbol}</div>
                    <div className="cell-sub hide-mobile">{p.asset.name}</div>
                  </td>
                  <td className="num">{money(p.marketValue)}</td>
                  <td className="num hide-mobile">{pct(p.weight)}</td>
                  <td className="num">
                    <Delta value={p.unrealized} />
                    <div className="cell-sub">{pct(p.unrealizedPct, { sign: true })}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

function isStale(iso?: string): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > 7 * 86400000;
}
