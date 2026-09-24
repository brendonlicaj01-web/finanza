import { useState } from 'react';
import { useSync } from '../sync';
import type { ProviderInfo } from '../lib/sync-types';
import { Card, Empty, Field, Icon, Modal, PageHead } from '../components/ui';

const CATEGORIES: { id: ProviderInfo['category']; label: string }[] = [
  { id: 'broker', label: 'Broker' },
  { id: 'crypto', label: 'Exchange crypto' },
  { id: 'banca', label: 'Banche' },
];

function when(iso?: string): string {
  if (!iso) return 'mai';
  const d = new Date(iso);
  return d.toLocaleString('it-IT', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function Connections() {
  const { serverUp, providers, connections, status, busy, sync, syncAll, remove, refresh } = useSync();
  const [adding, setAdding] = useState<ProviderInfo | null>(null);
  const byId = new Map(providers.map((p) => [p.id, p]));

  if (serverUp === false) {
    return (
      <div className="stack">
        <PageHead title="Collegamenti" />
        <Card>
          <Empty title="Server locale non attivo">
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
        sub="Importa automaticamente operazioni, saldi e prezzi da broker ed exchange."
        actions={
          connections.length > 0 && (
            <button className="btn btn-primary" disabled={busy} onClick={() => void syncAll()}>
              <Icon name="sync" /> {busy ? 'Sincronizzazione…' : 'Sincronizza tutto'}
            </button>
          )
        }
      />

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
                    <button className="btn" disabled={st?.running} onClick={() => void sync(c.id)}>
                      <Icon name="sync" /> Sincronizza
                    </button>
                    <button
                      className="btn btn-ghost"
                      aria-label={`Rimuovi ${c.label}`}
                      onClick={() =>
                        confirm(
                          `Rimuovere il collegamento "${c.label}"? Le chiavi vengono cancellate da questo computer; conto e transazioni già importati restano nell'app.`,
                        ) && void remove(c.id)
                      }
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

      {adding && <AddConnection provider={adding} onClose={() => setAdding(null)} />}
    </div>
  );
}

function AddConnection({ provider, onClose }: { provider: ProviderInfo; onClose: () => void }) {
  const { add, sync } = useSync();
  const [values, setValues] = useState<Record<string, string>>({});
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
      const created = await add(provider.id, label, values);
      onClose();
      void sync(created.id);
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
            <li key={i}>{g}</li>
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
              {f.multiline ? (
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
              {saving ? 'Verifica…' : 'Collega e sincronizza'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
