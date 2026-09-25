/** Riconoscimento della rete dal formato dell'indirizzo pubblico. */

export type Family =
  | 'bitcoin'
  | 'bitcoin-xpub'
  | 'litecoin'
  | 'dogecoin'
  | 'evm'
  | 'solana'
  | 'tron'
  | 'xrp'
  | 'cardano'
  | 'ton'
  | 'stellar';

export const FAMILY_LABEL: Record<Family, string> = {
  bitcoin: 'Bitcoin',
  'bitcoin-xpub': 'Bitcoin (chiave pubblica estesa)',
  litecoin: 'Litecoin',
  dogecoin: 'Dogecoin',
  evm: 'Ethereum e reti compatibili',
  solana: 'Solana',
  tron: 'Tron',
  xrp: 'XRP Ledger',
  cardano: 'Cardano',
  ton: 'TON',
  stellar: 'Stellar',
};

const B58 = '[1-9A-HJ-NP-Za-km-z]';
const PATTERNS: [Family, RegExp][] = [
  ['bitcoin-xpub', /^[xyz]pub[1-9A-HJ-NP-Za-km-z]{100,112}$/],
  ['evm', /^0x[0-9a-fA-F]{40}$/],
  ['bitcoin', new RegExp(`^(bc1[02-9ac-hj-np-z]{11,71}|[13]${B58}{25,34})$`)],
  ['litecoin', new RegExp(`^(ltc1[02-9ac-hj-np-z]{11,71}|[LM]${B58}{26,33})$`)],
  ['dogecoin', new RegExp(`^D${B58}{33}$`)],
  ['tron', new RegExp(`^T${B58}{33}$`)],
  ['xrp', /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/],
  ['cardano', /^(addr1|stake1)[02-9ac-hj-np-z]{40,120}$/],
  ['ton', /^((EQ|UQ)[A-Za-z0-9_-]{46}|-?\d:[0-9a-fA-F]{64})$/],
  ['stellar', /^G[A-Z2-7]{55}$/],
  ['solana', new RegExp(`^${B58}{32,44}$`)],
];

export function detectFamily(address: string): Family | undefined {
  const a = address.trim();
  // Gli indirizzi Solana sono quasi sempre di 43-44 caratteri: prima di tutto, per non confonderli con altre reti.
  if (/^[1-9A-HJ-NP-Za-km-z]{40,44}$/.test(a)) return 'solana';
  return PATTERNS.find(([, re]) => re.test(a))?.[0];
}

export interface ParsedAddress {
  address: string;
  family: Family;
}

/**
 * Legge l'elenco di indirizzi (uno per riga). Ogni riga può avere un'etichetta davanti ("Ledger bc1q…"):
 * si usa l'ultima parola. Righe vuote e commenti (#) sono ignorati.
 */
export function parseAddresses(text: string): { valid: ParsedAddress[]; invalid: string[] } {
  const valid: ParsedAddress[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split(/[\n,;]+/)) {
    const clean = line.replace(/#.*$/, '').trim();
    if (!clean) continue;
    const token = clean.split(/\s+/).pop()!;
    const family = detectFamily(token);
    if (!family) {
      invalid.push(token);
      continue;
    }
    // Gli indirizzi EVM non distinguono maiuscole e minuscole.
    const address = family === 'evm' ? token.toLowerCase() : token;
    if (seen.has(address)) continue;
    seen.add(address);
    valid.push({ address, family });
  }
  return { valid, invalid };
}
