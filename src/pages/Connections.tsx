import { useEffect, useMemo, useState } from 'react';
import { isReady, redirectUrl, useSync } from '../sync';
import { useStore } from '../store';
import type { BankInfo, ConnectionInfo, ProviderInfo } from '../lib/sync-types';
import { Card, Empty, Field, Icon, Modal, PageHead } from '../components/ui';
import { FileImport } from '../components/FileImport';

const CATEGORIES: { id: ProviderInfo['category']; label: string }[] = [
  { id: 'broker', label: 'Broker' },
  { id: 'crypto', label: 'Exchange crypto' },
  { id: 'banca', label: 'Banche' },
];

const COUNTRIES = [
  ['IT', 'Italia'],
  ['DE', 'Germania'],
  ['FR', 'Francia'],
  ['ES', 'Spagna'],
  ['NL', 'Paesi Bassi'],
  ['BE', 'Belgio'],
  ['AT', 'Austria'],
  ['PT', 'Portogallo'],
  ['IE', 'Irlanda'],
  ['LU', 'Lussemburgo'],
  ['FI', 'Finlandia'],
  ['LT', 'Lituania'],
];

const DAY = 86_400_000;

function when(iso?: string): string {
  if (!iso) return 'mai';
  const d = new Date(iso);
  return d.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function Connections() {
  const { serverUp, providers, connections, status, busy, sync, syncAll, remove, refresh } = useSync();
  const [adding, setAdding] = useState<ProviderInfo | null>(null);
  const [authorizing, setAuthorizing] = useState<ConnectionInfo | null>(null);
  const [removing, setRemoving] = useState<ConnectionInfo | null>(null);
  const byId = new Map(providers.map((p) => [p.id, p]));

  if (serverUp === false) {
    return (
      <div className="stack">
        <PageHead title="Collegamenti" />
        <FileImport />
        <Card>
          <Empty title="Collegamenti automatici non disponibili">
            <p>
              I collegamenti automatici funzionano quando l'app è avviata sul tuo computer con il file
              <strong> Avvia Finanza</strong> (o <code>npm start</code>): è lì che vengono custodite le chiavi API.
            </p>
            <div className="row">
              <button className="btn" onClick={() => void refresh()}>
                Riprova
              </button>
            </div>
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageHead
        title="Collegamenti"
        sub="Importa operazioni, saldi e prezzi da broker, exchange e banche: in automatico o da file."
        actions={
          connections.length > 0 && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void syncAll()}>
              <Icon name="sync" /> {busy ? 'Sincronizzazione…' : 'Sincronizza tutto'}
            </button>
          )
        }
      />

      <FileImport />

      {connections.length > 0 && (
        <Card title="I tuoi collegamenti">
          <div className="conn-list">
            {connections.map((c) => {
              const p = byId.get(c.provider);
              const st = status[c.id];
              return (
                <div className="conn-row" key={c.id}>
                  <div className="conn-main">
                    <div className="cell-title">{c.label}</div>
                    <div className="cell-sub">
                      {p?.label ?? c.provider} · ultimo aggiornamento {when(c.lastSyncAt)}
                    </div>
                    {c.auth && <AuthLine auth={c.auth} />}
                    {st?.message && (
                      <div className={`small ${st.running ? 'muted' : st.ok ? 'pos' : 'neg'}`} role="status">
                        {st.running ? '⟳ ' : st.ok ? '✓ ' : '✕ '}
                        {st.message}
                      </div>
                    )}
                    {st?.warnings && st.warnings.length > 0 && (
                      <details className="small muted">
                        <summary>
                          {st.warnings.length} {st.warnings.length === 1 ? 'avviso' : 'avvisi'}
                        </summary>
                        <ul>
                          {st.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </div>
                  <div className="row">
                    {c.auth && (!c.auth.authorized || expiresSoon(c.auth.validUntil)) && (
                      <button className="btn btn-primary" onClick={() => setAuthorizing(c)}>
                        {c.auth.authorized ? 'Rinnova consenso' : 'Autorizza banca'}
                      </button>
                    )}
                    <button className="btn" disabled={st?.running || !isReady(c)} onClick={() => void sync(c.id)}>
                      <Icon name="sync" /> Sincronizza
                    </button>
                    <button
                      className="btn btn-ghost"
                      aria-label={`Rimuovi ${c.label}`}
                      onClick={() => setRemoving(c)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {serverUp === null ? (
        <p className="muted">Connessione al server locale…</p>
      ) : (
        CATEGORIES.map((cat) => {
          const list = providers.filter((p) => p.category === cat.id);
          if (!list.length) return null;
          return (
            <section key={cat.id} className="stack" style={{ gap: 10 }}>
              <h2>{cat.label}</h2>
              <div className="provider-grid">
                {list.map((p) => (
                  <div className="card provider-card" key={p.id}>
                    <div className="cell-title">{p.label}</div>
                    <p className="small muted">{p.description}</p>
                    {p.available ? (
                      <button className="btn" onClick={() => setAdding(p)}>
                        <Icon name="plus" /> Collega
                      </button>
                    ) : (
                      <span className="badge">In arrivo</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          );
        })
      )}

      <p className="small muted">
        Le chiavi API restano solo su questo computer (cartella <code>~/.finanza</code>, leggibile solo dal tuo
        utente) e non vengono mai mostrate per intero. Usa sempre chiavi con permessi di <strong>sola lettura</strong>.
      </p>

      {adding && (
        <AddConnection
          provider={adding}
          onClose={() => setAdding(null)}
          onCreated={(c) => {
            setAdding(null);
            if (adding.requiresAuth) setAuthorizing(c);
            else void sync(c.id);
          }}
        />
      )}
      {authorizing && <AuthorizeBank connection={authorizing} onClose={() => setAuthorizing(null)} />}
      {removing && <RemoveConnection connection={removing} onRemove={remove} onClose={() => setRemoving(null)} />}
    </div>
  );
}

/** Rimozione di un collegamento: di norma se ne va anche il conto con le transazioni importate. */
function RemoveConnection({
  connection,
  onRemove,
  onClose,
}: {
  connection: ConnectionInfo;
  onRemove: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { data, dispatch } = useStore();
  const account = data.accounts.find((a) => a.connectionId === connection.id);
  const txCount = account ? data.transactions.filter((t) => t.accountId === account.id).length : 0;
  const [withData, setWithData] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const confirmRemove = async () => {
    setBusy(true);
    setError('');
    try {
      await onRemove(connection.id);
      if (account && withData) dispatch({ type: 'deleteAccount', id: account.id });
      // Altrimenti il conto diventa manuale: le transazioni restano, senza più legame con il collegamento.
      else if (account) dispatch({ type: 'upsertAccount', account: { ...account, connectionId: undefined } });
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={`Rimuovi "${connection.label}"`} onClose={onClose}>
      <div className="stack" style={{ gap: 12 }}>
        <p style={{ margin: 0 }}>Le chiavi e gli indirizzi di questo collegamento vengono cancellati da questo computer.</p>
        {account ? (
          <label className="check">
            <input type="checkbox" checked={withData} onChange={(e) => setWithData(e.target.checked)} />
            <span>
              Elimina anche il conto <strong>{account.name}</strong> e le sue {txCount}{' '}
              {txCount === 1 ? 'transazione' : 'transazioni'}
              <br />
              <span className="small muted">
                {withData
                  ? 'Posizioni, liquidità e report non conterranno più nulla di questo collegamento.'
                  : "Il conto resta nell'app come conto manuale, con le transazioni già importate."}
              </span>
            </span>
          </label>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            Nessun conto è stato ancora creato da questo collegamento.
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="modal-foot">
        <span />
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void confirmRemove()}>
            <Icon name="trash" /> Rimuovi
          </button>
        </div>
      </div>
    </Modal>
  );
}

function expiresSoon(iso?: string) {
  return !!iso && Date.parse(iso) - Date.now() < 14 * DAY;
}

function AuthLine({ auth }: { auth: NonNullable<ConnectionInfo['auth']> }) {
  if (!auth.authorized) {
    return (
      <div className="small neg">
        ✕ {auth.validUntil ? 'Consenso della banca scaduto' : 'Accesso alla banca da autorizzare'}
      </div>
    );
  }
  const until = auth.validUntil ? new Date(auth.validUntil).toLocaleDateString('it-IT') : undefined;
  return (
    <div className={`small ${expiresSoon(auth.validUntil) ? 'neg' : 'muted'}`}>
      {auth.bank ? `${auth.bank} · ` : ''}
      {until ? `consenso valido fino al ${until}` : 'consenso attivo'}
      {expiresSoon(auth.validUntil) && ' — in scadenza, rinnovalo'}
    </div>
  );
}

function AuthorizeBank({ connection, onClose }: { connection: ConnectionInfo; onClose: () => void }) {
  const { listBanks, authorize, completeAuth, refresh, connections, sync } = useSync();
  const [country, setCountry] = useState('IT');
  const [banks, setBanks] = useState<BankInfo[] | null>(null);
  const [query, setQuery] = useState('');
  const [chosen, setChosen] = useState<BankInfo | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [pasted, setPasted] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setBanks(null);
    setChosen(null);
    listBanks(connection.id, country)
      .then((b) => alive && setBanks(b))
      .catch((e) => alive && (setError((e as Error).message), setBanks([])));
    return () => {
      alive = false;
    };
  }, [connection.id, country, listBanks]);

  // Mentre l'utente è sul sito della banca, controlla periodicamente se l'autorizzazione è arrivata.
  const current = connections.find((c) => c.id === connection.id);
  const wasAuthorized = useMemo(() => connection.auth?.validUntil, [connection]);
  useEffect(() => {
    if (!waiting) return;
    const t = setInterval(() => void refresh(), 3000);
    return () => clearInterval(t);
  }, [waiting, refresh]);
  useEffect(() => {
    if (waiting && current?.auth?.authorized && current.auth.validUntil !== wasAuthorized) {
      onClose();
      void sync(connection.id);
    }
  }, [waiting, current, wasAuthorized, onClose, sync, connection.id]);

  const filtered = (banks ?? []).filter((b) => b.name.toLowerCase().includes(query.trim().toLowerCase()));

  const go = async () => {
    if (!chosen) return;
    setError('');
    // La finestra va aperta subito (nel clic), altrimenti il browser la blocca.
    const win = window.open('', '_blank');
    try {
      const url = await authorize(connection.id, chosen);
      if (win) win.location.href = url;
      else window.location.href = url;
      setWaiting(true);
    } catch (e) {
      win?.close();
      setError((e as Error).message);
    }
  };

  const manual = async () => {
    setError('');
    try {
      await completeAuth(connection.id, pasted);
      onClose();
      void sync(connection.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Modal title={`Autorizza la banca · ${connection.label}`} onClose={onClose}>
      {!waiting ? (
        <div className="stack" style={{ gap: 12 }}>
          <div className="form-grid">
            <Field label="Paese">
              <select className="input" value={country} onChange={(e) => setCountry(e.target.value)}>
                {COUNTRIES.map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cerca la banca">
              <input className="input" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="es. Intesa" />
            </Field>
          </div>
          <div className="bank-list" role="listbox" aria-label="Banche">
            {banks === null && <p className="small muted">Caricamento delle banche…</p>}
            {banks !== null && filtered.length === 0 && <p className="small muted">Nessuna banca trovata.</p>}
            {filtered.slice(0, 80).map((b) => (
              <button
                key={`${b.country}-${b.name}`}
                type="button"
                role="option"
                aria-selected={chosen?.name === b.name}
                className="bank-item"
                onClick={() => setChosen(b)}
              >
                {b.logo && <img src={b.logo} alt="" width={20} height={20} loading="lazy" />}
                {b.name}
              </button>
            ))}
          </div>
          <p className="small muted">
            Verrai portato sul sito della tua banca per confermare l'accesso in sola lettura. Al termine la finestra si
            chiude da sola e la sincronizzazione parte in automatico.
          </p>
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <p>
            Completa l'accesso nella finestra di <strong>{chosen?.name}</strong>. Questa pagina si aggiorna da sola.
          </p>
          <Field
            label="Non torna in automatico? Incolla qui l'indirizzo della pagina finale"
            hint="Serve se la banca ti ha mandato a una pagina che non si apre: copia l'indirizzo dalla barra del browser."
          >
            <input className="input mono" value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={`${redirectUrl()}?code=…`} />
          </Field>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-foot">
        <span />
        <div className="row">
          <button type="button" className="btn" onClick={onClose}>
            Annulla
          </button>
          {!waiting ? (
            <button type="button" className="btn btn-primary" disabled={!chosen} onClick={() => void go()}>
              Vai alla banca
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!pasted.trim()} onClick={() => void manual()}>
              Conferma
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function AddConnection({
  provider,
  onClose,
  onCreated,
}: {
  provider: ProviderInfo;
  onClose: () => void;
  onCreated: (c: ConnectionInfo) => void;
}) {
  const { add } = useSync();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(provider.fields.filter((f) => f.options?.length).map((f) => [f.key, f.options![0].value])),
  );
  const [label, setLabel] = useState(provider.label);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const missing = provider.fields.find((f) => !f.optional && !values[f.key]?.trim());
    if (missing) return setError(`Compila il campo "${missing.label}".`);
    setSaving(true);
    setError('');
    try {
      onCreated(await add(provider.id, label, values));
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  return (
    <Modal title={`Collega ${provider.label}`} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <ol className="guide small">
          {provider.guide.map((g, i) => (
            <li key={i}>
              {g.includes('{redirectUrl}') ? (
                <>
                  {g.split('{redirectUrl}')[0]}
                  <code>{redirectUrl()}</code>
                  {g.split('{redirectUrl}')[1]}
                </>
              ) : (
                g
              )}
            </li>
          ))}
        </ol>
        {provider.docsUrl && (
          <p className="small">
            <a href={provider.docsUrl} target="_blank" rel="noreferrer">
              Guida ufficiale di {provider.label} ↗
            </a>
          </p>
        )}
        <div className="form-grid">
          <Field label="Nome del conto nell'app" className="full">
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} />
          </Field>
          {provider.fields.map((f) => (
            <Field key={f.key} label={f.label} className="full">
              {f.options ? (
                <select
                  className="input"
                  value={values[f.key] ?? f.options[0]?.value}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                >
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.multiline ? (
                <textarea
                  className="input mono"
                  rows={5}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              ) : (
                <input
                  className={`input ${f.secret ? 'mono' : ''}`}
                  type={f.secret ? 'password' : 'text'}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={f.placeholder}
                  value={values[f.key] ?? ''}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-foot">
          <span className="small muted">{saving ? 'Verifica delle credenziali…' : ''}</span>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Verifica…' : provider.requiresAuth ? 'Salva e scegli la banca' : 'Collega e sincronizza'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
