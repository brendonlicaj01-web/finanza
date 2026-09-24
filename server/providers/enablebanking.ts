import { createHash, createPrivateKey, createSign } from 'node:crypto';
import type { SyncResult, SyncTx } from '../../src/lib/sync-types.ts';
import { ProviderError, type Bank, type Provider } from './types.ts';

const API = 'https://api.enablebanking.com';
const DAY = 86_400_000;

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');

/** JWT RS256 richiesto da Enable Banking: kid = ID applicazione, validità massima 24 ore. */
export function makeJwt(applicationId: string, privateKeyPem: string, now = Date.now()): string {
  let key;
  try {
    key = createPrivateKey(privateKeyPem.replace(/\\n/g, '\n').trim());
  } catch {
    throw new ProviderError('Enable Banking: la chiave privata non è un file PEM valido.');
  }
  const iat = Math.floor(now / 1000);
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: applicationId.trim() }));
  const payload = b64url(
    JSON.stringify({ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp: iat + 3600 }),
  );
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key);
  return `${header}.${payload}.${b64url(signature)}`;
}

async function call<T>(
  creds: Record<string, string>,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const jwt = makeJwt(creds.applicationId, creds.privateKey);
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (e) {
    throw new ProviderError(`Enable Banking non raggiungibile: ${(e as Error).message}`);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    // risposta non JSON
  }
  if (!res.ok) {
    const detail = String(json.message ?? json.detail ?? json.error ?? text).slice(0, 200);
    if (res.status === 401) throw new ProviderError('Enable Banking: ID applicazione o chiave privata non validi.');
    if (res.status === 403 && /session|expired|consent/i.test(detail)) {
      throw new ProviderError('Consenso bancario scaduto o revocato: autorizza di nuovo la banca.');
    }
    throw new ProviderError(`Enable Banking (${res.status}): ${detail}`);
  }
  return json as T;
}

interface Amount {
  amount: string;
  currency: string;
}
interface EbAccount {
  uid: string;
  name?: string;
  currency?: string;
  account_id?: { iban?: string };
}
interface EbBalance {
  balance_amount: Amount;
  balance_type?: string;
}
export interface EbTransaction {
  entry_reference?: string;
  transaction_id?: string;
  transaction_amount: Amount;
  credit_debit_indicator?: 'CRDT' | 'DBIT';
  status?: string;
  booking_date?: string;
  value_date?: string;
  transaction_date?: string;
  remittance_information?: string[];
  creditor?: { name?: string };
  debtor?: { name?: string };
}

/** Ordine di preferenza dei tipi di saldo ISO 20022: contabile di chiusura, poi disponibile. */
const BALANCE_PREF = ['CLBD', 'ITBD', 'XPCD', 'ITAV', 'CLAV', 'OPBD'];

export function pickBalance(balances: EbBalance[]): EbBalance | undefined {
  for (const t of BALANCE_PREF) {
    const b = balances.find((x) => x.balance_type === t);
    if (b) return b;
  }
  return balances[0];
}

export function bankTxToSync(uid: string, t: EbTransaction): SyncTx | undefined {
  if (t.status && !['BOOK', 'BOOKED'].includes(t.status.toUpperCase())) return undefined;
  const raw = Number(t.transaction_amount?.amount);
  if (!Number.isFinite(raw) || raw === 0) return undefined;
  const debit = t.credit_debit_indicator ? t.credit_debit_indicator === 'DBIT' : raw < 0;
  const date = (t.booking_date || t.value_date || t.transaction_date || '').slice(0, 10);
  if (!date) return undefined;
  const counterpart = debit ? t.creditor?.name : t.debtor?.name;
  const note = [counterpart, (t.remittance_information ?? []).join(' ')].filter(Boolean).join(' – ').slice(0, 140);
  const ref =
    t.entry_reference ||
    t.transaction_id ||
    createHash('sha1').update(`${date}|${raw}|${note}`).digest('hex').slice(0, 16);
  return {
    externalId: `eb:${uid}:${ref}`,
    date,
    type: debit ? 'prelievo' : 'deposito',
    amount: Math.abs(raw),
    fees: 0,
    note: note || undefined,
  };
}

function accountsOf(creds: Record<string, string>): EbAccount[] {
  try {
    return JSON.parse(creds.accounts || '[]');
  } catch {
    return [];
  }
}

export const enablebanking: Provider = {
  id: 'enablebanking',
  label: 'Conti bancari (Enable Banking)',
  category: 'banca',
  description: 'Saldi (e se vuoi movimenti) dei conti correnti via open banking PSD2, gratis per i tuoi conti.',
  available: true,
  requiresAuth: true,
  docsUrl: 'https://enablebanking.com/docs/api/linked-accounts/',
  fields: [
    { key: 'applicationId', label: 'ID applicazione (Application ID)' },
    {
      key: 'privateKey',
      label: 'Chiave privata (file .pem, -----BEGIN PRIVATE KEY-----…)',
      secret: true,
      multiline: true,
    },
    {
      key: 'movements',
      label: 'Cosa importare',
      options: [
        { value: 'saldo', label: 'Solo il saldo (consigliato)' },
        { value: 'movimenti', label: 'Saldo e singoli movimenti' },
      ],
    },
  ],
  guide: [
    'Registrati gratis su enablebanking.com e apri il Control Panel → Applications → Add a new application.',
    'Ambiente: "Production". Redirect URL: {redirectUrl} (copialo esattamente). Scegli di generare la chiave nel browser: verrà scaricato un file .pem.',
    'Nella pagina dell\'applicazione premi "Activate by linking accounts" e collega i conti della tua banca: in questa modalità gratuita l\'app può leggere solo i conti collegati da te.',
    'Incolla qui l\'ID dell\'applicazione e il contenuto del file .pem (aprilo con un editor di testo).',
    'Dopo il salvataggio scegli la banca e autorizza l\'accesso: il consenso dura fino a 180 giorni, poi l\'app ti chiederà di rinnovarlo.',
  ],
  auth: {
    async listBanks(creds, country) {
      const r = await call<{ aspsps?: Record<string, unknown>[] }>(
        creds,
        `/aspsps?country=${encodeURIComponent(country)}&psu_type=personal`,
      );
      return (r.aspsps ?? [])
        .map((a) => ({
          name: String(a.name),
          country: String(a.country ?? country),
          logo: a.logo ? String(a.logo) : undefined,
          maxConsentSeconds: Number(a.maximum_consent_validity) || undefined,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    async startAuth(creds, bank: Bank, redirectUrl, state) {
      const seconds = Math.min(bank.maxConsentSeconds ?? 180 * 86400, 180 * 86400);
      const r = await call<{ url?: string }>(creds, '/auth', {
        method: 'POST',
        body: {
          access: { valid_until: new Date(Date.now() + seconds * 1000 - 60_000).toISOString() },
          aspsp: { name: bank.name, country: bank.country },
          state,
          redirect_url: redirectUrl,
          psu_type: 'personal',
        },
      });
      if (!r.url) throw new ProviderError('Enable Banking non ha restituito l\'indirizzo della banca.');
      return r.url;
    },
    async completeAuth(creds, code) {
      const r = await call<{
        session_id: string;
        accounts?: EbAccount[];
        aspsp?: { name?: string };
        access?: { valid_until?: string };
      }>(creds, '/sessions', { method: 'POST', body: { code } });
      if (!r.session_id) throw new ProviderError('Enable Banking: sessione non creata.');
      const accounts = (r.accounts ?? []).map((a) => ({
        uid: a.uid,
        name: a.name,
        currency: a.currency,
        account_id: { iban: a.account_id?.iban },
      }));
      if (!accounts.length) throw new ProviderError('La banca non ha condiviso alcun conto: riprova selezionandone almeno uno.');
      return {
        sessionId: r.session_id,
        accounts: JSON.stringify(accounts),
        validUntil: r.access?.valid_until ?? '',
        bank: r.aspsp?.name ?? '',
      };
    },
    status(creds) {
      const authorized = !!creds.sessionId && (!creds.validUntil || Date.parse(creds.validUntil) > Date.now());
      return { authorized, validUntil: creds.validUntil || undefined, bank: creds.bank || undefined };
    },
  },
  async test(creds) {
    await call(creds, '/application');
  },
  async sync(creds, { currency, since }): Promise<SyncResult> {
    if (!enablebanking.auth!.status(creds).authorized) {
      throw new ProviderError('Autorizza prima l\'accesso alla banca (pulsante "Autorizza banca").');
    }
    const warnings: string[] = [];
    const accounts = accountsOf(creds);
    const transactions: SyncTx[] = [];
    let cash = 0;

    for (const acc of accounts) {
      const label = acc.name || acc.account_id?.iban || acc.uid;
      const { balances = [] } = await call<{ balances?: EbBalance[] }>(creds, `/accounts/${acc.uid}/balances`);
      const bal = pickBalance(balances);
      if (!bal) {
        warnings.push(`Nessun saldo disponibile per il conto ${label}.`);
        continue;
      }
      if (bal.balance_amount.currency !== currency) {
        warnings.push(`Conto ${label} in ${bal.balance_amount.currency}: escluso (valuta dell'app ${currency}).`);
        continue;
      }
      cash += Number(bal.balance_amount.amount) || 0;

      if (creds.movements === 'movimenti') {
        const from = new Date(since ? Date.parse(since) - 7 * DAY : Date.now() - 365 * DAY).toISOString().slice(0, 10);
        const fetchAll = async (dateFrom: string) => {
          const list: EbTransaction[] = [];
          let key: string | undefined;
          for (let i = 0; i < 100; i++) {
            const q = `date_from=${dateFrom}${key ? `&continuation_key=${encodeURIComponent(key)}` : ''}`;
            const r = await call<{ transactions?: EbTransaction[]; continuation_key?: string }>(
              creds,
              `/accounts/${acc.uid}/transactions?${q}`,
            );
            list.push(...(r.transactions ?? []));
            key = r.continuation_key || undefined;
            if (!key) break;
          }
          return list;
        };
        let list: EbTransaction[];
        try {
          list = await fetchAll(from);
        } catch (e) {
          // Molte banche concedono solo 90 giorni di storico: riproviamo con un periodo più breve.
          if (since) throw e;
          list = await fetchAll(new Date(Date.now() - 89 * DAY).toISOString().slice(0, 10));
          warnings.push(`La banca concede solo gli ultimi 90 giorni di movimenti per il conto ${label}.`);
        }
        for (const t of list) {
          if (t.transaction_amount?.currency && t.transaction_amount.currency !== currency) continue;
          const s = bankTxToSync(acc.uid, t);
          if (s) transactions.push(s);
        }
      }
    }

    const validUntil = creds.validUntil ? Date.parse(creds.validUntil) : undefined;
    if (validUntil && validUntil - Date.now() < 14 * DAY) {
      warnings.push(
        `Il consenso della banca scade il ${new Date(validUntil).toLocaleDateString('it-IT')}: rinnovalo per continuare a sincronizzare.`,
      );
    }

    return {
      accountName: creds.bank || 'Conto bancario',
      accountKind: 'banca',
      currency,
      assets: [],
      transactions,
      cash: Math.round(cash * 100) / 100,
      warnings,
    };
  },
};
