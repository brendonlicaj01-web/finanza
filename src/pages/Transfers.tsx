import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { findTransfers, type Confidence, type TransferPair } from '../lib/transfers';
import { date as fmtDate, money, qty } from '../lib/format';
import { OUTFLOW_QTY } from '../lib/types';
import { Card, Empty, PageHead, Tile } from '../components/ui';

const CONF_LABEL: Record<Confidence, string> = { alta: 'Probabile', media: 'Possibile', bassa: 'Da verificare' };

/**
 * Trasferimenti tra i propri conti riconosciuti nei dati. Le coppie con l'etichetta "Trasferimento crypto interno"
 * sono già calcolate come tali; le altre (vendita + acquisto, prelievo + versamento) sono solo segnalate.
 */
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

  const labeled = securities.filter((p) => p.labeled);
  const pending = securities.filter((p) => !p.labeled);
  const fakeGains = pending.reduce((s, p) => s + (p.recordedGain ?? 0), 0);
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
        sub="Movimenti che spostano crypto, titoli o liquidità tra i tuoi conti: non sono compravendite né versamenti."
      />

      <div className="tiles">
        <Tile
          label="Trasferimenti crypto interni"
          value={labeled.length}
          sub="costo di carico spostato, nessuna plusvalenza"
        />
        <Tile
          label="Ancora come vendita e acquisto"
          value={pending.length}
          sub={
            pending.length
              ? `${money(fakeGains, { sign: true })} contati come realizzati, ma non c'è stata vendita`
              : 'nessuna coppia da sistemare'
          }
        />
        <Tile label="Bonifici tra conti" value={cash.length} sub={`${money(doubled)} contati come versamenti e prelievi`} />
      </div>

      <Card
        title="Titoli e crypto"
        sub="Con l'etichetta «Trasferimento crypto interno» quantità e costo di carico passano da un conto all'altro. Le coppie ancora registrate come vendita e acquisto sono solo segnalate."
      >
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
                  <th className="num">Effetto oggi</th>
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
                      <td className="num">
                        {p.labeled ? (
                          <span className="badge conf-alta">Trasferimento crypto interno</span>
                        ) : (
                          <>
                            {p.recordedGain !== undefined ? money(p.recordedGain, { sign: true }) : '—'}
                            <div className="cell-sub">come vendita + acquisto</div>
                          </>
                        )}
                      </td>
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
                      <span className="badge">{OUTFLOW_QTY.includes(t.type) ? 'in uscita' : 'in entrata'}</span>
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
        Sotto l'affidabilità trovi perché due movimenti sono stati abbinati. Le crypto importate con le versioni
        precedenti (vendita + acquisto) ricevono l'etichetta reimportando i file di Trade Republic e OKX; Scalable si
        aggiorna alla prossima sincronizzazione.
      </p>
    </div>
  );
}
