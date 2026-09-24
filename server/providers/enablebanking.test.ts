import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bankTxToSync, enablebanking, makeJwt, pickBalance } from './enablebanking.ts';

describe('Enable Banking', () => {
  it('firma un JWT RS256 verificabile con kid, iss e aud corretti', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const jwt = makeJwt('app-123', pem, Date.UTC(2026, 0, 1));
    const [h, p, sig] = jwt.split('.');
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'RS256', kid: 'app-123' });
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(payload).toMatchObject({ iss: 'enablebanking.com', aud: 'api.enablebanking.com' });
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(86400);
    expect(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, Buffer.from(sig, 'base64url'))).toBe(true);
    // Accetta anche la chiave incollata con "\n" letterali.
    expect(() => makeJwt('app', pem.replace(/\n/g, '\\n'))).not.toThrow();
    expect(() => makeJwt('app', 'non una chiave')).toThrow(/PEM/);
  });

  it('sceglie il saldo contabile se disponibile', () => {
    expect(
      pickBalance([
        { balance_type: 'ITAV', balance_amount: { amount: '90', currency: 'EUR' } },
        { balance_type: 'CLBD', balance_amount: { amount: '100', currency: 'EUR' } },
      ])?.balance_amount.amount,
    ).toBe('100');
    expect(pickBalance([])).toBeUndefined();
  });

  it('converte i movimenti contabilizzati', () => {
    expect(
      bankTxToSync('acc1', {
        entry_reference: 'R1',
        transaction_amount: { amount: '42.50', currency: 'EUR' },
        credit_debit_indicator: 'DBIT',
        status: 'BOOK',
        booking_date: '2026-03-02',
        creditor: { name: 'Supermercato' },
        remittance_information: ['Spesa'],
      }),
    ).toEqual({ externalId: 'eb:acc1:R1', date: '2026-03-02', type: 'prelievo', amount: 42.5, fees: 0, note: 'Supermercato – Spesa' });
    const noRef = bankTxToSync('acc1', {
      transaction_amount: { amount: '1500', currency: 'EUR' },
      credit_debit_indicator: 'CRDT',
      value_date: '2026-03-27',
      debtor: { name: 'Datore di lavoro' },
    })!;
    expect(noRef).toMatchObject({ type: 'deposito', amount: 1500, date: '2026-03-27' });
    expect(noRef.externalId).toMatch(/^eb:acc1:[0-9a-f]{16}$/);
    expect(bankTxToSync('acc1', { transaction_amount: { amount: '5', currency: 'EUR' }, status: 'PDNG', booking_date: '2026-03-02' })).toBeUndefined();
  });

  it('considera il consenso scaduto', () => {
    const status = enablebanking.auth!.status;
    expect(status({}).authorized).toBe(false);
    expect(status({ sessionId: 's', validUntil: '2000-01-01T00:00:00Z' }).authorized).toBe(false);
    expect(status({ sessionId: 's', validUntil: '2999-01-01T00:00:00Z', bank: 'Banca X' })).toEqual({
      authorized: true,
      validUntil: '2999-01-01T00:00:00Z',
      bank: 'Banca X',
    });
  });
});
