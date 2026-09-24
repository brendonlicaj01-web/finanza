import { useRef, useState } from 'react';
import { useStore } from '../store';
import { parseData } from '../lib/storage';
import { download, transactionsToCsv } from '../lib/csv';
import { demoData } from '../lib/demo';
import { today } from '../lib/format';
import { Card, Field, Icon, PageHead } from '../components/ui';
import { getTheme, setTheme, type Theme } from '../theme';

const CURRENCIES = ['EUR', 'USD', 'CHF', 'GBP'];

export function Settings() {
  const { data, dispatch } = useStore();
  const fileRef = useRef<HTMLInputElement>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [theme, setThemeState] = useState<Theme>(getTheme());

  const importFile = async (file: File) => {
    try {
      const parsed = parseData(await file.text());
      if (
        data.transactions.length > 0 &&
        !confirm('Importando il backup sostituirai tutti i dati attuali. Continuare?')
      )
        return;
      dispatch({ type: 'replace', data: parsed });
      setMessage({
        ok: true,
        text: `Importati ${parsed.accounts.length} conti, ${parsed.assets.length} strumenti e ${parsed.transactions.length} transazioni.`,
      });
    } catch (e) {
      setMessage({ ok: false, text: `Importazione non riuscita: ${(e as Error).message}` });
    }
  };

  return (
    <div className="stack">
      <PageHead title="Impostazioni" />

      <Card title="Preferenze">
        <div className="form-grid">
          <Field label="Valuta di riferimento" hint="Tutti gli importi sono espressi in questa valuta.">
            <select
              className="input"
              value={data.settings.currency}
              onChange={(e) => dispatch({ type: 'updateSettings', settings: { currency: e.target.value } })}
            >
              {CURRENCIES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Tema">
            <select
              className="input"
              value={theme}
              onChange={(e) => {
                const t = e.target.value as Theme;
                setTheme(t);
                setThemeState(t);
              }}
            >
              <option value="auto">Automatico (sistema)</option>
              <option value="light">Chiaro</option>
              <option value="dark">Scuro</option>
            </select>
          </Field>
          <label className="check full">
            <input
              type="checkbox"
              checked={data.settings.trackCash}
              onChange={(e) => dispatch({ type: 'updateSettings', settings: { trackCash: e.target.checked } })}
            />
            <span>
              Traccia la liquidità dei conti
              <br />
              <span className="small muted">
                Calcola il saldo di ogni conto da depositi, prelievi, acquisti, vendite e proventi. Disattivalo se
                registri solo le operazioni sui titoli.
              </span>
            </span>
          </label>
        </div>
      </Card>

      <Card title="Backup e dati" sub="I dati sono salvati solo in questo browser. Esporta un backup regolarmente.">
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              download(`finanza-backup-${today()}.json`, JSON.stringify(data, null, 2), 'application/json')
            }
          >
            <Icon name="download" /> Esporta backup (JSON)
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Importa backup
          </button>
          <button
            className="btn"
            disabled={data.transactions.length === 0}
            onClick={() =>
              download(`finanza-transazioni-${today()}.csv`, '﻿' + transactionsToCsv(data), 'text/csv;charset=utf-8')
            }
          >
            <Icon name="download" /> Esporta transazioni (CSV)
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) importFile(file);
              e.target.value = '';
            }}
          />
        </div>
        {message && (
          <p className={message.ok ? 'pos small' : 'error'} role="status">
            {message.text}
          </p>
        )}
      </Card>

      <Card title="Zona pericolosa">
        <div className="row">
          <button
            className="btn"
            onClick={() =>
              (data.transactions.length === 0 || confirm('Sostituire i dati attuali con i dati di esempio?')) &&
              dispatch({ type: 'replace', data: demoData(today()) })
            }
          >
            Carica dati di esempio
          </button>
          <button
            className="btn btn-danger"
            onClick={() =>
              confirm('Eliminare definitivamente tutti i dati? Esporta prima un backup se vuoi conservarli.') &&
              dispatch({ type: 'reset' })
            }
          >
            <Icon name="trash" /> Elimina tutti i dati
          </button>
        </div>
      </Card>
    </div>
  );
}
