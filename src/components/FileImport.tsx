import { useMemo, useRef, useState } from 'react';
import { useStore, withTarget } from '../store';
import { detectImporter, importers, readSheets, type FileImporter, type Sheet } from '../lib/importers';
import { mergeSync } from '../lib/sync';
import { date as fmtDate, money, qty, today } from '../lib/format';
import { TX_TYPES } from '../lib/types';
import { Card, Field, Icon, Modal } from './ui';

const TX_LABELS = new Map(TX_TYPES.map((t) => [t.value, t.label]));

interface Pending {
  file: File;
  importer: FileImporter;
  sheets: Sheet[];
}

/** Zona di trascinamento per importare gli export dei broker (letti solo nel browser). */
export function FileImport() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [queue, setQueue] = useState<Pending[]>([]);
  const [error, setError] = useState('');
  const [over, setOver] = useState(false);
  const [done, setDone] = useState('');

  const handle = async (files: FileList | File[]) => {
    setError('');
    setDone('');
    const found: Pending[] = [];
    const problems: string[] = [];
    for (const file of Array.from(files)) {
      try {
        const sheets = await readSheets(file);
        const importer = detectImporter(sheets);
        if (importer) found.push({ file, importer, sheets });
        else problems.push(`"${file.name}": formato non riconosciuto.`);
      } catch (e) {
        problems.push(`"${file.name}": ${(e as Error).message}`);
      }
    }
    // Prima i file dei titoli, poi quelli del conto: così i controlli anti-doppione funzionano.
    found.sort((a, b) => importers.indexOf(b.importer) - importers.indexOf(a.importer));
    setQueue((q) => [...q, ...found]);
    if (problems.length) setError(problems.join(' '));
  };

  return (
    <Card title="Importa da file" sub="Trascina qui l'export del tuo broker: viene letto solo sul tuo computer.">
      <div
        className={`dropzone ${over ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void handle(e.dataTransfer.files);
        }}
      >
        <Icon name="upload" size={22} />
        <div>
          Trascina qui il file (.xls, .xlsx, .csv) oppure{' '}
          <button type="button" className="linklike" onClick={() => inputRef.current?.click()}>
            sceglilo dal computer
          </button>
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          accept=".xls,.xlsx,.csv,text/csv,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => {
            if (e.target.files) void handle(e.target.files);
            e.target.value = '';
          }}
        />
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="small pos" role="status">
          ✓ {done}
        </p>
      )}
      <details className="small muted formats">
        <summary>Formati supportati e dove scaricarli</summary>
        <ul>
          {importers.map((i) => (
            <li key={i.id}>
              <strong>{i.label}</strong>: {i.howTo}
            </li>
          ))}
        </ul>
        <p>Altri broker (Directa, Degiro, Trade Republic, Scalable) in arrivo.</p>
      </details>
      {queue[0] && (
        <ImportPreview
          key={queue[0].file.name + queue[0].file.lastModified}
          pending={queue[0]}
          onDone={(msg) => {
            if (msg) setDone(msg);
            setQueue((q) => q.slice(1));
          }}
        />
      )}
    </Card>
  );
}

function ImportPreview({ pending, onDone }: { pending: Pending; onDone: (message?: string) => void }) {
  const { data, dispatch } = useStore();
  const { importer, sheets, file } = pending;
  const connectionId = `file:${importer.label.toLowerCase().replace(/\s+/g, '-')}`;
  const linked = data.accounts.find((a) => a.connectionId === connectionId);
  const [target, setTarget] = useState<string>(linked?.id ?? '');
  const [balanceCash, setBalanceCash] = useState(importer.needsCashBalance);

  const preview = useMemo(() => {
    try {
      const base = withTarget(data, connectionId, target || undefined);
      const account = base.accounts.find((a) => a.connectionId === connectionId);
      const existingIds = new Set(
        base.transactions.filter((t) => t.accountId === account?.id && t.externalId).map((t) => t.externalId!),
      );
      const result = importer.parse(sheets, {
        balanceCash,
        existingIds,
        knownSymbols: data.assets.map((a) => a.symbol),
      });
      const merged = mergeSync(base, { id: connectionId, label: importer.label }, result, today());
      const added = merged.data.transactions.filter((t) => !base.transactions.some((b) => b.id === t.id));
      return { result, stats: merged.stats, added, assets: merged.data.assets, error: '' };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [data, connectionId, target, balanceCash, importer, sheets]);

  const confirm = () => {
    if (!preview.result) return;
    dispatch({
      type: 'applyImport',
      connection: { id: connectionId, label: importer.label },
      result: preview.result,
      today: today(),
      targetAccountId: target || undefined,
    });
    onDone(`${file.name}: ${preview.stats!.added} transazioni importate.`);
  };

  const assetName = (id?: string) => (id ? (preview.assets?.find((a) => a.id === id)?.symbol ?? '') : '');

  const dates = preview.added?.map((t) => t.date).sort() ?? [];
  const already = (preview.result?.transactions.length ?? 0) - (preview.stats?.added ?? 0);

  return (
    <Modal title={`Importa ${importer.label}`} onClose={() => onDone()}>
      <div className="stack" style={{ gap: 12 }}>
        <p className="small muted" style={{ margin: 0 }}>
          File: <strong>{file.name}</strong>
        </p>
        <Field label="Conto di destinazione">
          <select className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{linked ? `${linked.name} (usato negli import precedenti)` : `Nuovo conto «${importer.label}»`}</option>
            {data.accounts
              .filter((a) => a.id !== linked?.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </Field>
        {importer.needsCashBalance && (
          <label className="check">
            <input type="checkbox" checked={balanceCash} onChange={(e) => setBalanceCash(e.target.checked)} />
            <span>
              Bilancia la liquidità
              <br />
              <span className="small muted">
                Il file non contiene bonifici e saldo: ogni acquisto viene registrato come pagato dal conto corrente,
                così la liquidità del conto titoli non va in negativo.
              </span>
            </span>
          </label>
        )}

        {preview.error ? (
          <p className="error">{preview.error}</p>
        ) : (
          <>
            <div className="tiles">
              <div className="card">
                <div className="tile-label">Nuove transazioni</div>
                <div className="tile-value">{preview.stats!.added}</div>
                {dates.length > 0 && (
                  <div className="tile-sub">
                    {fmtDate(dates[0])} – {fmtDate(dates[dates.length - 1])}
                  </div>
                )}
              </div>
              <div className="card">
                <div className="tile-label">Già presenti</div>
                <div className="tile-value">{already}</div>
                <div className="tile-sub">saltate, nessun doppione</div>
              </div>
              <div className="card">
                <div className="tile-label">Nuovi strumenti</div>
                <div className="tile-value">{preview.stats!.newAssets}</div>
                {preview.stats!.adjustments > 0 && (
                  <div className="tile-sub">{preview.stats!.adjustments} allineamenti al saldo</div>
                )}
              </div>
            </div>
            {preview.added!.length > 0 && (
              <div className="table-wrap preview-table">
                <table>
                  <thead>
                    <tr>
                      <th>Data</th>
                      <th>Tipo</th>
                      <th>Dettaglio</th>
                      <th className="num">Q.tà / importo</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.added!.slice(0, 50).map((t) => (
                      <tr key={t.id}>
                        <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                        <td>
                          <span className="badge">{TX_LABELS.get(t.type)}</span>
                        </td>
                        <td className="small">{assetName(t.assetId) || t.note}</td>
                        <td className="num">{t.quantity !== undefined ? qty(t.quantity) : money(t.amount ?? 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preview.added!.length > 50 && <p className="small muted">…e altre {preview.added!.length - 50}.</p>}
              </div>
            )}
            {preview.stats!.warnings.length > 0 && (
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {preview.stats!.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      <div className="modal-foot">
        <span />
        <div className="row">
          <button type="button" className="btn" onClick={() => onDone()}>
            Annulla
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!!preview.error || !preview.stats || preview.stats.added === 0}
            onClick={confirm}
          >
            Importa
          </button>
        </div>
      </div>
    </Modal>
  );
}
