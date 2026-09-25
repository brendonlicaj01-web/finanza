import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { quantityAt, sortTransactions } from '../lib/portfolio';
import { transferPlan } from '../lib/transfers';
import { ASSET_TX, OUTFLOW_QTY, TRADE_TX, TRANSFER_TX, TX_TYPES, multiplierOf, type Transaction, type TxType } from '../lib/types';
import { date as fmtDate, money, price, parseNumber, qty, today } from '../lib/format';
import { uid } from '../lib/id';
import { Card, Empty, Field, Icon, Modal, PageHead } from '../components/ui';

const TX_LABELS = new Map(TX_TYPES.map((t) => [t.value, t.label]));
/** Effetto sulla liquidità: segno usato per colorare/mostrare l'importo. */
const OUTFLOW: TxType[] = ['acquisto', 'prelievo', 'commissione'];

function txTotal(tx: Transaction, multiplier = 1): number {
  if (TRADE_TX.includes(tx.type)) {
    const gross = (tx.quantity ?? 0) * (tx.price ?? 0) * multiplier;
    if (TRANSFER_TX.includes(tx.type)) return gross; // valore spostato, non un incasso o una spesa
    return tx.type === 'acquisto' ? gross + tx.fees : gross - tx.fees;
  }
  if (tx.type === 'dividendo' || tx.type === 'interessi') return (tx.amount ?? 0) - tx.fees;
  return (tx.amount ?? 0) + (tx.type === 'deposito' ? -tx.fees : tx.fees);
}

export function Transactions() {
  const { data, dispatch } = useStore();
  const [editing, setEditing] = useState<Transaction | 'new' | null>(null);
  const [filter, setFilter] = useState({ account: '', type: '', asset: '', year: '' });

  const accounts = new Map(data.accounts.map((a) => [a.id, a]));
  const assets = new Map(data.assets.map((a) => [a.id, a]));
  // Vendite/acquisti confermati come trasferimento tra conti e i loro movimenti speculari (non conteggiati).
  const plan = useMemo(() => transferPlan(data), [data]);
  const years = useMemo(
    () => [...new Set(data.transactions.map((t) => t.date.slice(0, 4)))].sort().reverse(),
    [data.transactions],
  );
  const list = useMemo(
    () =>
      sortTransactions(data.transactions)
        .reverse()
        .filter(
          (t) =>
            (!filter.account || t.accountId === filter.account) &&
            (!filter.type || t.type === filter.type) &&
            (!filter.asset || t.assetId === filter.asset) &&
            (!filter.year || t.date.startsWith(filter.year)),
        ),
    [data.transactions, filter],
  );

  const canAdd = data.accounts.length > 0;

  return (
    <div className="stack">
      <PageHead
        title="Transazioni"
        sub={`${data.transactions.length} movimenti registrati`}
        actions={
          <>
            <a className="btn" href="#collegamenti">
              <Icon name="upload" /> Importa da file
            </a>
            <button className="btn btn-primary" disabled={!canAdd} onClick={() => setEditing('new')}>
              <Icon name="plus" /> Nuova transazione
            </button>
          </>
        }
      />
      {!canAdd && (
        <div className="alert">Crea prima un conto nella sezione Conti, oppure importa un file del tuo broker.</div>
      )}

      {data.transactions.length > 0 && (
        <div className="row" role="group" aria-label="Filtri">
          <select
            className="input"
            style={{ width: 'auto' }}
            value={filter.account}
            onChange={(e) => setFilter({ ...filter, account: e.target.value })}
            aria-label="Filtra per conto"
          >
            <option value="">Tutti i conti</option>
            {data.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={filter.type}
            onChange={(e) => setFilter({ ...filter, type: e.target.value })}
            aria-label="Filtra per tipo"
          >
            <option value="">Tutti i tipi</option>
            {TX_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={filter.asset}
            onChange={(e) => setFilter({ ...filter, asset: e.target.value })}
            aria-label="Filtra per strumento"
          >
            <option value="">Tutti gli strumenti</option>
            {data.assets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.symbol}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: 'auto' }}
            value={filter.year}
            onChange={(e) => setFilter({ ...filter, year: e.target.value })}
            aria-label="Filtra per anno"
          >
            <option value="">Tutti gli anni</option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      )}

      <Card>
        {list.length === 0 ? (
          <Empty title={data.transactions.length ? 'Nessun risultato' : 'Nessuna transazione'}>
            <p>
              {data.transactions.length
                ? 'Nessuna transazione corrisponde ai filtri.'
                : 'Registra depositi, acquisti, vendite e dividendi per calcolare le tue posizioni.'}
            </p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Data</th>
                  <th>Tipo</th>
                  <th>Dettaglio</th>
                  <th className="hide-mobile">Conto</th>
                  <th className="num">Importo</th>
                </tr>
              </thead>
              <tbody>
                {list.map((t) => {
                  const asset = t.assetId ? assets.get(t.assetId) : undefined;
                  const total = txTotal(t, multiplierOf(asset));
                  const out = OUTFLOW.includes(t.type);
                  const moved = TRANSFER_TX.includes(t.type) || plan.asTransfer.has(t.id);
                  const ignored = plan.ignore.has(t.id);
                  const giro = plan.giroconti.has(t.id);
                  return (
                    <tr key={t.id} className="clickable" onClick={() => setEditing(t)}>
                      <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(t.date)}</td>
                      <td>
                        <span className="badge">{TX_LABELS.get(t.type)}</span>
                      </td>
                      <td>
                        {asset && <div className="cell-title">{asset.symbol}</div>}
                        <div className="cell-sub">
                          {[
                            TRADE_TX.includes(t.type) ? `${qty(t.quantity ?? 0)} × ${price(t.price ?? 0)}` : '',
                            t.note,
                            t.fees > 0 ? `comm. ${money(t.fees)}` : '',
                            plan.asTransfer.has(t.id) ? 'trasferimento tra conti confermato' : '',
                            ignored ? 'movimento automatico del trasferimento, non conteggiato' : '',
                            giro ? 'bonifico tra conti confermato' : '',
                            t.externalId ? 'importata' : '',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="hide-mobile">{accounts.get(t.accountId)?.name}</td>
                      {moved || ignored || giro ? (
                        <td className="num muted" title="Valore spostato tra i tuoi conti: non è un incasso né una spesa">
                          ⇄ {money(Math.abs(total))}
                        </td>
                      ) : (
                        <td className={`num ${out ? '' : 'pos'}`}>
                          {out ? '−' : '+'}
                          {money(Math.abs(total))}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <TransactionForm
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={(tx) => {
            dispatch({ type: 'upsertTransaction', tx });
            setEditing(null);
          }}
          onDelete={(id) => {
            dispatch({ type: 'deleteTransaction', id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function TransactionForm({
  initial,
  onClose,
  onSave,
  onDelete,
}: {
  initial?: Transaction;
  onClose: () => void;
  onSave: (tx: Transaction) => void;
  onDelete: (id: string) => void;
}) {
  const { data } = useStore();
  const str = (n?: number) => (n === undefined ? '' : String(n).replace('.', ','));
  const [f, setF] = useState({
    type: initial?.type ?? ('acquisto' as TxType),
    date: initial?.date ?? today(),
    accountId: initial?.accountId ?? data.accounts[0]?.id ?? '',
    assetId: initial?.assetId ?? data.assets[0]?.id ?? '',
    quantity: str(initial?.quantity),
    price: str(initial?.price),
    amount: str(initial?.amount),
    fees: str(initial?.fees) || '0',
    note: initial?.note ?? '',
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const isTrade = TRADE_TX.includes(f.type);
  const needsAsset = ASSET_TX.includes(f.type);
  const q = parseNumber(f.quantity);
  const p = parseNumber(f.price);
  const fees = parseNumber(f.fees || '0');
  const mult = multiplierOf(data.assets.find((a) => a.id === f.assetId));
  const gross = isTrade && q > 0 && p >= 0 ? q * p * mult : NaN;
  const isTransfer = TRANSFER_TX.includes(f.type);
  const leaving = OUTFLOW_QTY.includes(f.type);
  const held =
    leaving && f.assetId
      ? quantityAt(data.transactions, f.accountId, f.assetId, f.date, initial?.id)
      : 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!f.date) return setError('Inserisci una data.');
    if (!f.accountId) return setError('Seleziona un conto.');
    if (Number.isNaN(fees) || fees < 0) return setError('Commissioni non valide.');
    const tx: Transaction = {
      id: initial?.id ?? uid(),
      date: f.date,
      type: f.type,
      accountId: f.accountId,
      fees,
      note: f.note.trim() || undefined,
      // Una transazione importata resta riconoscibile (niente doppioni), ma le sincronizzazioni non la sovrascrivono più.
      ...(initial?.externalId ? { externalId: initial.externalId, rev: initial.rev, edited: true } : {}),
    };
    if (needsAsset) {
      if (!f.assetId) {
        if (f.type !== 'dividendo') return setError('Seleziona uno strumento (puoi crearlo nella sezione Strumenti).');
      } else tx.assetId = f.assetId;
    }
    if (isTrade) {
      if (!(q > 0)) return setError('La quantità deve essere maggiore di zero.');
      if (!(p >= 0) || Number.isNaN(p)) return setError('Prezzo non valido.');
      if (leaving && q > held + 1e-9)
        return setError(
          `Non puoi ${f.type === 'vendita' ? 'vendere' : 'trasferire'} più di quanto possiedi alla data indicata (${qty(held)}).`,
        );
      tx.quantity = q;
      tx.price = p;
    } else {
      const amount = parseNumber(f.amount);
      if (!(amount > 0)) return setError("L'importo deve essere maggiore di zero.");
      tx.amount = amount;
    }
    onSave(tx);
  };

  return (
    <Modal title={initial ? 'Modifica transazione' : 'Nuova transazione'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Tipo" className="full">
            <select className="input" value={f.type} onChange={set('type')}>
              {TX_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Data">
            <input className="input" type="date" value={f.date} onChange={set('date')} required />
          </Field>
          <Field label="Conto">
            <select className="input" value={f.accountId} onChange={set('accountId')}>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
          {needsAsset && (
            <Field label="Strumento">
              <select className="input" value={f.assetId} onChange={set('assetId')}>
                {f.type === 'dividendo' && <option value="">— Nessuno —</option>}
                {data.assets.filter((a) => !isTransfer || a.type === 'crypto' || a.id === f.assetId).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.symbol} · {a.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {isTrade ? (
            <>
              <Field label="Quantità" hint={leaving ? `Posseduti alla data: ${qty(held)}` : undefined}>
                <input className="input" inputMode="decimal" value={f.quantity} onChange={set('quantity')} placeholder="0" />
              </Field>
              <Field
                label={isTransfer ? 'Valore unitario del giorno' : 'Prezzo unitario'}
                hint={
                  isTransfer
                    ? "Solo informativo: il costo di carico arriva dal conto di provenienza. Se l'altra metà non è tra i tuoi conti, l'entrata usa questo valore."
                    : Number.isFinite(gross)
                      ? `Controvalore ${money(gross)}`
                      : undefined
                }
              >
                <input className="input" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0,00" />
              </Field>
            </>
          ) : (
            <Field
              label="Importo"
              hint={f.type === 'dividendo' || f.type === 'interessi' ? 'Lordo o netto: le commissioni/ritenute vengono sottratte.' : undefined}
            >
              <input className="input" inputMode="decimal" value={f.amount} onChange={set('amount')} placeholder="0,00" />
            </Field>
          )}
          <Field label={f.type === 'dividendo' || f.type === 'interessi' ? 'Ritenute / commissioni' : 'Commissioni'}>
            <input className="input" inputMode="decimal" value={f.fees} onChange={set('fees')} />
          </Field>
          <Field label="Note" className="full">
            <input className="input" value={f.note} onChange={set('note')} placeholder="Facoltative" />
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
                onClick={() => confirm('Eliminare questa transazione?') && onDelete(initial.id)}
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
