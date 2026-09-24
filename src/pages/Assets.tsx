import { useState } from 'react';
import { useStore } from '../store';
import { ASSET_TYPES, type Asset, type AssetType } from '../lib/types';
import { date as fmtDate, parseNumber, qty, today } from '../lib/format';
import { uid } from '../lib/id';
import { Card, Empty, Field, Icon, Modal, PageHead } from '../components/ui';

const TYPE_LABELS = new Map(ASSET_TYPES.map((t) => [t.value, t.label]));

export function Assets() {
  const { data, result, dispatch } = useStore();
  const [editing, setEditing] = useState<Asset | 'new' | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});

  const held = new Map<string, number>();
  for (const p of result.positions) held.set(p.assetId, (held.get(p.assetId) ?? 0) + p.quantity);
  const sorted = [...data.assets].sort(
    (a, b) => Number((held.get(b.id) ?? 0) > 0) - Number((held.get(a.id) ?? 0) > 0) || a.symbol.localeCompare(b.symbol),
  );

  const dirty = Object.entries(prices).filter(([id, v]) => {
    const n = parseNumber(v);
    return Number.isFinite(n) && n >= 0 && n !== data.assets.find((a) => a.id === id)?.price;
  });

  const savePrices = () => {
    dispatch({ type: 'setPrices', prices: Object.fromEntries(dirty.map(([id, v]) => [id, parseNumber(v)])) });
    setPrices({});
  };

  return (
    <div className="stack">
      <PageHead
        title="Strumenti"
        sub="Azioni, ETF, obbligazioni, crypto e altro. Aggiorna qui i prezzi correnti."
        actions={
          <>
            {dirty.length > 0 && (
              <button className="btn btn-primary" onClick={savePrices}>
                Salva {dirty.length} {dirty.length === 1 ? 'prezzo' : 'prezzi'}
              </button>
            )}
            <button className="btn" onClick={() => setEditing('new')}>
              <Icon name="plus" /> Nuovo strumento
            </button>
          </>
        }
      />
      <Card>
        {sorted.length === 0 ? (
          <Empty title="Nessuno strumento">
            <p>Aggiungi i titoli, gli ETF o le crypto che possiedi o vuoi monitorare.</p>
          </Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Strumento</th>
                  <th className="hide-mobile">Tipo</th>
                  <th className="num">Quantità</th>
                  <th className="num" style={{ width: 160 }}>
                    Prezzo attuale
                  </th>
                  <th className="hide-mobile">Aggiornato</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sorted.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <div className="cell-title">{a.symbol}</div>
                      <div className="cell-sub">{a.name}</div>
                    </td>
                    <td className="hide-mobile">
                      <span className="badge">{TYPE_LABELS.get(a.type)}</span>
                    </td>
                    <td className="num">{qty(held.get(a.id) ?? 0)}</td>
                    <td className="num">
                      <input
                        className="input"
                        style={{ textAlign: 'right', minWidth: 110 }}
                        inputMode="decimal"
                        aria-label={`Prezzo di ${a.symbol}`}
                        value={prices[a.id] ?? String(a.price).replace('.', ',')}
                        onChange={(e) => setPrices({ ...prices, [a.id]: e.target.value })}
                        onKeyDown={(e) => e.key === 'Enter' && savePrices()}
                      />
                    </td>
                    <td className="hide-mobile small muted">{a.priceUpdatedAt ? fmtDate(a.priceUpdatedAt) : 'mai'}</td>
                    <td className="num">
                      <button className="btn btn-ghost" onClick={() => setEditing(a)} aria-label={`Modifica ${a.symbol}`}>
                        <Icon name="edit" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {editing && (
        <AssetForm
          initial={editing === 'new' ? undefined : editing}
          txCount={editing === 'new' ? 0 : data.transactions.filter((t) => t.assetId === editing.id).length}
          onClose={() => setEditing(null)}
          onSave={(asset) => {
            dispatch({ type: 'upsertAsset', asset });
            setEditing(null);
          }}
          onDelete={(id) => {
            dispatch({ type: 'deleteAsset', id });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function AssetForm({
  initial,
  txCount,
  onClose,
  onSave,
  onDelete,
}: {
  initial?: Asset;
  txCount: number;
  onClose: () => void;
  onSave: (a: Asset) => void;
  onDelete: (id: string) => void;
}) {
  const [f, setF] = useState({
    symbol: initial?.symbol ?? '',
    name: initial?.name ?? '',
    type: initial?.type ?? ('etf' as AssetType),
    price: initial ? String(initial.price).replace('.', ',') : '',
    taxRate: String(initial?.taxRate ?? 26).replace('.', ','),
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const price = parseNumber(f.price || '0');
    const taxRate = parseNumber(f.taxRate);
    if (!f.symbol.trim()) return setError('Inserisci un simbolo, ticker o ISIN.');
    if (!(price >= 0)) return setError('Prezzo non valido.');
    if (!(taxRate >= 0 && taxRate <= 100)) return setError("L'aliquota deve essere tra 0 e 100.");
    const priceChanged = !initial || initial.price !== price;
    onSave({
      id: initial?.id ?? uid(),
      symbol: f.symbol.trim().toUpperCase(),
      name: f.name.trim() || f.symbol.trim().toUpperCase(),
      type: f.type,
      price,
      taxRate,
      priceUpdatedAt: priceChanged ? today() : initial?.priceUpdatedAt,
    });
  };

  return (
    <Modal title={initial ? `Modifica ${initial.symbol}` : 'Nuovo strumento'} onClose={onClose}>
      <form onSubmit={submit} noValidate>
        <div className="form-grid">
          <Field label="Simbolo / ISIN">
            <input className="input" value={f.symbol} onChange={set('symbol')} placeholder="es. VWCE" />
          </Field>
          <Field label="Tipo">
            <select
              className="input"
              value={f.type}
              onChange={(e) => {
                const type = e.target.value as AssetType;
                setF({ ...f, type });
              }}
            >
              {ASSET_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Nome" className="full">
            <input className="input" value={f.name} onChange={set('name')} placeholder="es. Vanguard FTSE All-World" />
          </Field>
          <Field label="Prezzo attuale">
            <input className="input" inputMode="decimal" value={f.price} onChange={set('price')} placeholder="0,00" />
          </Field>
          <Field label="Aliquota plusvalenze (%)" hint="26% standard, 12,5% titoli di Stato e equiparati.">
            <input className="input" inputMode="decimal" value={f.taxRate} onChange={set('taxRate')} />
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
                      ? `Eliminare ${initial.symbol} e le sue ${txCount} transazioni?`
                      : `Eliminare ${initial.symbol}?`,
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

