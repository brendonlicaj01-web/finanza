import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { findTransfers, type Confidence, type TransferPair } from '../lib/transfers';
import { date as fmtDate, money, qty } from '../lib/format';
import { Card, Empty, PageHead, Tile } from '../components/ui';

const CONF_LABEL: Record<Confidence, string> = { alta: 'Probabile', media: 'Possibile', bassa: 'Da verificare' };

/** Trasferimenti tra i propri conti riconosciuti nei dati (passo 1: solo analisi, nessuna modifica). */
export function Transfers() {
  const { data, result } = useStore();
  const analysis = useMemo(() => findTransfers(data, result.saleGains), [data, result.saleGains]);
  const [showLow, setShowLow] = useState(false);

  const accounts = new Map(data.accounts.map((a) => [a.id, a.name]));
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  const visible = analysis.pairs.filter((p) => showLow || p.confidence !== 'bassa');
  const securities = visible.filter((p) => p.kind === 'titoli');
  const cash = visible.filter((p) => p.kind === 'liquidita');
  const hidden = analysis.pairs.length - visible.length;

  const fakeGains = securities.reduce((s, p) => s + (p.recordedGain ?? 0), 0);
  const doubled = cash.reduce((s, p) => s + (p.out.amount ?? 0), 0);

  const route = (p: TransferPair) => (
    <>
      <div className="cell-title">
        {accounts.get(p.out.accountId) ?? '—'} → {accounts.get(p.in.accountId) ?? '—'}
      </div>
      <div className="cell-sub">
        {fmtDate(p.out.date)}
        {p.days !== 0 && ` → ${fmtDate(p.in.date)}`}
      </div>
    </>
  );
  const badge = (p: TransferPair) => (
    <>
      <span className={`badge conf-${p.confidence}`}>{CONF_LABEL[p.confidence]}</span>
      <div className="cell-sub">{p.reasons.join(', ')}</div>
    </>
  );

  return (
    <div className="stack">
      <PageHead
        title="Trasferimenti tra conti"
        sub="Movimenti che sembrano spostamenti tra i tuoi conti (non compravendite né versamenti). Per ora è solo un'analisi: non viene modificato nulla."
      />

      <div className="tiles">
        <Tile label="Titoli e crypto trasferiti" value={securities.length} sub="coppie uscita → entrata" />
        <Tile
          label="Plus/minus da trasferimenti"
          value={money(fakeGains, { sign: true })}
          sub="oggi contate come realizzate, ma non c'è stata vendita"
        />
        <Tile label="Bonifici tra conti" value={cash.length} sub={`${money(doubled)} contati come versamenti e prelievi`} />
      </div>

      <Card title="Titoli e crypto" sub="Chi invia registra una vendita, chi riceve un acquisto al valore del giorno.">
        {securities.length === 0 ? (
          <Empty title="Nessun trasferimento riconosciuto" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Da → a</th>
                  <th>Strumento</th>
                  <th className="num">Quantità</th>
                  <th className="num hide-mobile">Valore</th>
                  <th className="num">Plus/minus registrata</th>
                  <th>Affidabilità</th>
                </tr>
              </thead>
              <tbody>
                {securities.map((p) => {
                  const a = assets.get(p.in.assetId ?? '') ?? assets.get(p.out.assetId ?? '');
                  return (
                    <tr key={`${p.out.id}-${p.in.id}`}>
                      <td>{route(p)}</td>
                      <td>
                        <div className="cell-title">{a?.symbol}</div>
                        {a && a.name !== a.symbol && <div className="cell-sub">{a.name}</div>}
                      </td>
                      <td className="num">
                        {qty(p.out.quantity ?? 0)}
                        {p.difference > 0 && <div className="cell-sub">arrivati {qty(p.in.quantity ?? 0)}</div>}
                      </td>
                      <td className="num hide-mobile">{money((p.out.quantity ?? 0) * (p.out.price ?? 0))}</td>
                      <td className="num">{p.recordedGain !== undefined ? money(p.recordedGain, { sign: true }) : '—'}</td>
                      <td>{badge(p)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title="Liquidità" sub="Bonifici tra i tuoi conti: il conto che invia registra un prelievo, quello che riceve un versamento.">
        {cash.length === 0 ? (
          <Empty title="Nessun bonifico tra conti riconosciuto" />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Da → a</th>
                  <th className="num">Importo</th>
                  <th className="hide-mobile">Descrizione</th>
                  <th>Affidabilità</th>
                </tr>
              </thead>
              <tbody>
                {cash.map((p) => (
                  <tr key={`${p.out.id}-${p.in.id}`}>
                    <td>{route(p)}</td>
                    <td className="num">
                      {money(p.out.amount ?? 0)}
                      {p.difference > 0 && <div className="cell-sub">arrivati {money(p.in.amount ?? 0)}</div>}
                    </td>
                    <td className="small hide-mobile">{p.out.note || p.in.note || '—'}</td>
                    <td>{badge(p)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {analysis.unmatched.length > 0 && (
        <Card
          title="Senza controparte"
          sub="La fonte li indica come trasferimenti, ma l'altra metà non è in nessun conto dell'app (es. wallet personale o conto non collegato)."
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Conto</th>
                  <th>Strumento</th>
                  <th className="num">Quantità</th>
                </tr>
              </thead>
              <tbody>
                {analysis.unmatched.map((t) => (
                  <tr key={t.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                    <td>{accounts.get(t.accountId)}</td>
                    <td>
                      {assets.get(t.assetId ?? '')?.symbol}{' '}
                      <span className="badge">{t.type === 'vendita' ? 'in uscita' : 'in entrata'}</span>
                    </td>
                    <td className="num">{qty(t.quantity ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <label className="check">
        <input type="checkbox" checked={showLow} onChange={(e) => setShowLow(e.target.checked)} />
        <span>
          Mostra anche le coppie da verificare{hidden > 0 && !showLow ? ` (${hidden} nascoste)` : ''}
          <br />
          <span className="small muted">
            Abbinamenti deboli: per esempio con un saldo iniziale stimato o con quantità che differiscono molto.
          </span>
        </span>
      </label>
      <p className="small muted">
        Sotto l'affidabilità trovi perché due movimenti sono stati abbinati. Nel prossimo passo potrai confermare le
        coppie: a quel punto non conteranno più come vendite, acquisti, versamenti o prelievi.
      </p>
    </div>
  );
}
