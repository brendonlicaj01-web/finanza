import { useMemo, useState } from 'react';
import { useStore } from '../store';
import { ASSET_TYPES, type Asset, type AssetType } from '../lib/types';
import { date as fmtDate, parseNumber, qty, today } from '../lib/format';
import { uid } from '../lib/id';
import { findDuplicates } from '../lib/assets';
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

  // Stessa crypto (o stesso ISIN) registrata più volte da fonti diverse.
  const duplicates = useMemo(() => findDuplicates(data), [data]);
  const usage = (assetId: string) => {
    const txs = data.transactions.filter((t) => t.assetId === assetId);
    const accounts = [...new Set(txs.map((t) => data.accounts.find((a) => a.id === t.accountId)?.name ?? '—'))];
    return `${txs.length} ${txs.length === 1 ? 'transazione' : 'transazioni'}${accounts.length ? ` (${accounts.join(', ')})` : ''}`;
  };
  const merge = (primaryId: string, otherIds: string[]) => dispatch({ type: 'mergeAssets', primaryId, otherIds });

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
      {duplicates.length > 0 && (
        <Card
          title="Strumenti doppi"
          sub="La stessa crypto (o lo stesso ISIN) arriva con nomi diversi da fonti diverse, es. «Bitcoin» di Scalable e «BTC» degli exchange. Unendoli hai una posizione sola e i trasferimenti tra i conti si abbinano meglio."
        >
          <div className="table-wrap">
            <table>
              <tbody>
                {duplicates.map((g) => (
                  <tr key={g.key}>
                    <td>
                      <div className="cell-title">{g.primary.symbol}</div>
                      <div className="cell-sub">{usage(g.primary.id)}</div>
                    </td>
                    <td>
                      {g.others.map((o) => (
                        <div key={o.id} className="small">
                          anche come <strong>{o.symbol}</strong>
                          {o.name !== o.symbol && ` · ${o.name}`}
                          {o.isin && ` · ${o.isin}`} — {usage(o.id)}
                        </div>
                      ))}
                    </td>
                    <td className="num">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() =>
                          confirm(
                            `Unire ${g.others.map((o) => `«${o.symbol}»`).join(', ')} in «${g.primary.symbol}»? Le transazioni passano a ${g.primary.symbol}; l'operazione non si può annullare (conviene un backup in Impostazioni).`,
                          ) && merge(g.primary.id, g.others.map((o) => o.id))
                        }
                      >
                        Unisci in {g.primary.symbol}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

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
          others={editing === 'new' ? [] : data.assets.filter((a) => a.id !== editing.id)}
          onMerge={(otherId) => {
            if (editing === 'new') return;
            merge(editing.id, [otherId]);
            setEditing(null);
          }}
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
  others,
  onClose,
  onSave,
  onDelete,
  onMerge,
}: {
  initial?: Asset;
  txCount: number;
  /** Altri strumenti che si possono unire a questo. */
  others: Asset[];
  onClose: () => void;
  onSave: (a: Asset) => void;
  onDelete: (id: string) => void;
  onMerge: (otherId: string) => void;
}) {
  const [mergeId, setMergeId] = useState('');
  const [f, setF] = useState({
    symbol: initial?.symbol ?? '',
    name: initial?.name ?? '',
    type: initial?.type ?? ('etf' as AssetType),
    price: initial ? String(initial.price).replace('.', ',') : '',
    taxRate: String(initial?.taxRate ?? 26).replace('.', ','),
    isin: initial?.isin ?? '',
    percent: initial?.priceMultiplier === 0.01,
  });
  const [error, setError] = useState('');
  const set = (k: Exclude<keyof typeof f, 'percent'>) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const price = parseNumber(f.price || '0');
    const taxRate = parseNumber(f.taxRate);
    if (!f.symbol.trim()) return setError('Inserisci un simbolo, ticker o ISIN.');
    if (!(price >= 0)) return setError('Prezzo non valido.');
    if (!(taxRate >= 0 && taxRate <= 100)) return setError("L'aliquota deve essere tra 0 e 100.");
    const isin = f.isin.trim().toUpperCase();
    if (isin && !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return setError('ISIN non valido (12 caratteri, es. IE00BK5BQT80).');
    const priceChanged = !initial || initial.price !== price;
    onSave({
      ...initial,
      id: initial?.id ?? uid(),
      isin: isin || undefined,
      priceMultiplier: f.percent ? 0.01 : undefined,
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
          <Field label="ISIN (facoltativo)">
            <input className="input mono" value={f.isin} onChange={set('isin')} placeholder="es. IT0005713539" />
          </Field>
          <label className="check full">
            <input type="checkbox" checked={f.percent} onChange={(e) => setF({ ...f, percent: e.target.checked })} />
            <span>
              Prezzo in percentuale del nominale
              <br />
              <span className="small muted">
                Per obbligazioni e titoli di Stato: quantità = valore nominale (es. 3.000), prezzo = % (es. 100,03).
              </span>
            </span>
          </label>
        </div>
        {initial && others.length > 0 && (
          <div className="stack" style={{ gap: 6, marginTop: 14 }}>
            <Field label="Unisci un altro strumento in questo">
              <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                <select className="input" style={{ minWidth: 0 }} value={mergeId} onChange={(e) => setMergeId(e.target.value)}>
                  <option value="">Scegli lo strumento doppio…</option>
                  {[...others]
                    .sort((a, b) => Number(b.type === initial.type) - Number(a.type === initial.type) || a.symbol.localeCompare(b.symbol))
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.symbol}
                        {a.name !== a.symbol ? ` · ${a.name}` : ''}
                        {a.isin ? ` · ${a.isin}` : ''}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  disabled={!mergeId}
                  onClick={() => {
                    const other = others.find((a) => a.id === mergeId);
                    if (other && confirm(`Unire «${other.symbol}» in «${initial.symbol}»? Le sue transazioni passano a ${initial.symbol} e «${other.symbol}» viene eliminato.`)) onMerge(other.id);
                  }}
                >
                  Unisci
                </button>
              </div>
            </Field>
          </div>
        )}
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

