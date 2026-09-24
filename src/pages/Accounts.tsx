import { useState } from 'react';
import { useStore } from '../store';
import { ACCOUNT_KINDS, type Account, type AccountKind } from '../lib/types';
import { money } from '../lib/format';
import { uid } from '../lib/id';
import { Card, Delta, Empty, Field, Icon, Modal, PageHead } from '../components/ui';

const KIND_LABELS = new Map(ACCOUNT_KINDS.map((k) => [k.value, k.label]));

export function Accounts() {
  const { data, result, dispatch } = useStore();
  const [editing, setEditing] = useState<Account | 'new' | null>(null);

  const stats = (id: string) => {
    const pos = result.positions.filter((p) => p.accountId === id);
    const cash = data.settings.trackCash ? (result.cash.find((c) => c.accountId === id)?.cash ?? 0) : 0;
    const invested = pos.reduce((s, p) => s + p.marketValue, 0);
    const unrealized = pos.reduce((s, p) => s + p.unrealized, 0);
    return { cash, invested, unrealized, total: invested + cash, open: pos.filter((p) => p.quantity > 0).length };
  };

  return (
    <div className="stack">
      <PageHead
        title="Conti"
        sub="Broker, banche e wallet in cui detieni investimenti e liquidità."
        actions={
          <button className="btn btn-primary" onClick={() => setEditing('new')}>
            <Icon name="plus" /> Nuovo conto
          </button>
        }
      />
      <Card>
        {data.accounts.length === 0 ? (
          <Empty title="Nessun conto">
            <p>Crea un conto per ogni broker, banca o wallet che utilizzi.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Conto</th>
                  <th className="num">Investimenti</th>
                  {data.settings.trackCash && <th className="num">Liquidità</th>}
                  <th className="num hide-mobile">P&L latente</th>
                  <th className="num">Totale</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((a) => {
                  const s = stats(a.id);
                  return (
                    <tr key={a.id} className="clickable" onClick={() => setEditing(a)}>
                      <td>
                        <div className="cell-title">{a.name}</div>
                        <div className="cell-sub">
                          {KIND_LABELS.get(a.kind)} · {s.open} {s.open === 1 ? 'posizione' : 'posizioni'}
                          {a.note && ` · ${a.note}`}
                        </div>
                      </td>
                      <td className="num">{money(s.invested)}</td>
                      {data.settings.trackCash && (
                        <td className={`num ${s.cash < -0.005 ? 'neg' : ''}`}>{money(s.cash)}</td>
                      )}
                      <td className="num hide-mobile">
                        <Delta value={s.unrealized} />
                      </td>
                      <td className="num cell-title">{money(s.total)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data.settings.trackCash && result.cash.some((c) => c.cash < -0.005) && (
        <div className="alert">
          Un conto ha liquidità negativa: probabilmente mancano dei depositi. Registrali come transazioni di tipo
          “Deposito”, oppure disattiva il tracciamento della liquidità nelle Impostazioni.
        </div>
      )}

      {editing && (
        <AccountForm
          initial={editing === 'new' ? undefined : editing}
          txCount={editing === 'new' ? 0 : data.transactions.filter((t) => t.accountId === editing.id).length}
          onClose={() => setEditing(null)}
          onSave={(account) => {
            dispatch({ type: 'upsertAccount', account });
            setEditing(null);
          }}
          onDelete={(id) => {
            dispatch({ type: 'deleteAccount', id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function AccountForm({
  initial,
  txCount,
  onClose,
  onSave,
  onDelete,
}: {
  initial?: Account;
  txCount: number;
  onClose: () => void;
  onSave: (a: Account) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<AccountKind>(initial?.kind ?? 'broker');
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState('');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Inserisci un nome.');
    onSave({ id: initial?.id ?? uid(), name: name.trim(), kind, note: note.trim() || undefined });
  };

  return (
    <Modal title={initial ? 'Modifica conto' : 'Nuovo conto'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Nome" className="full">
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="es. Directa" />
          </Field>
          <Field label="Tipo">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as AccountKind)}>
              {ACCOUNT_KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Note">
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Facoltative" />
          </Field>
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-foot">
          <div>
            {initial && (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() =>
                  confirm(
                    txCount
                      ? `Eliminare "${initial.name}" e le sue ${txCount} transazioni?`
                      : `Eliminare "${initial.name}"?`,
                  ) && onDelete(initial.id)
                }
              >
                <Icon name="trash" /> Elimina
              </button>
            )}
          </div>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Annulla
            </button>
            <button type="submit" className="btn btn-primary">
              Salva
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
