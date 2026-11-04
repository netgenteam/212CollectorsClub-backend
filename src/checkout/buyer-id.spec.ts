import { Logger } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import {
  isBuyerIdRequired,
  resetBuyerIdSwitchWarnings,
  resolveBuyerId,
  validateBuyerId,
  type BuyerShippingContext,
} from './buyer-id.js';

const AGENCY: BuyerShippingContext = {
  format: 'agency',
  recipientIdDoc: 'V-12345678',
};
const FLAT: BuyerShippingContext = { format: 'flat', recipientIdDoc: null };
const SAVED: BuyerShippingContext = { format: 'saved', recipientIdDoc: null };

/** Runs `fn`, returns what it threw as `{status, errorCode, details}` (and fails if it did not). */
function failure(fn: () => unknown): {
  status: number;
  errorCode: string;
  details: Record<string, unknown> | undefined;
} {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(ApiException);
    const e = err as ApiException;
    const body = e.getResponse() as {
      errorCode: string;
      details?: Record<string, unknown>;
    };
    return {
      status: e.getStatus(),
      errorCode: body.errorCode,
      details: body.details,
    };
  }
  throw new Error('expected a throw');
}

const code = (fn: () => unknown): string => failure(fn).errorCode;
const where = (fn: () => unknown): string => {
  const d = failure(fn).details;
  return `${String(d?.field)}:${String(d?.reason)}`;
};

describe('validateBuyerId (AC2)', () => {
  describe('V / E: 6-9 digits', () => {
    it.each([
      ['V', '123456', 'V-123456'],
      ['V', '12345678', 'V-12345678'],
      ['V', '123456789', 'V-123456789'],
      ['E', '81234567', 'E-81234567'],
      ['V', '12.345.678', 'V-12345678'],
      ['V', ' 12 345 678 ', 'V-12345678'],
      ['E', '12-345-678', 'E-12345678'],
      ['V', '0123456', 'V-0123456'], // leading zeros count
    ])('%s %j is valid', (type, number, canonical) => {
      expect(validateBuyerId({ type, number }).canonical).toBe(canonical);
    });

    it.each([
      ['V', '12345', 'INVALID_LENGTH'],
      ['V', '1234567890', 'INVALID_LENGTH'],
      ['V', '123456789012', 'INVALID_LENGTH'],
      ['V', '1234', 'INVALID_LENGTH'],
      ['E', '12345', 'INVALID_LENGTH'],
      ['V', 'ABCDEFGH', 'INVALID_FORMAT'],
      ['V', '1234567A', 'INVALID_FORMAT'],
      ['V', 'V12345678', 'INVALID_FORMAT'], // the letter goes in `type`
      ['V', '****5678', 'INVALID_FORMAT'], // a masked value
      ['V', '1234 5678 9012 3456', 'INVALID_LENGTH'],
    ])('%s %j is BUYER_ID_INVALID (%s)', (type, number, reason) => {
      const f = failure(() => validateBuyerId({ type, number }));
      expect(f.status).toBe(400);
      expect(f.errorCode).toBe('BUYER_ID_INVALID');
      expect(f.details).toEqual({ field: 'buyerId.number', reason });
    });
  });

  describe('J / G: RIF of 9 digits with check digit', () => {
    // J-07013380-5 is the published RIF of Banesco; the others are hand-computed (20.2 spec).
    it.each([
      ['J', '070133805'],
      ['J', '07013380-5'],
      ['J', '07.013.380-5'],
      ['G', '200000031'],
      ['J', '000000009'],
    ])('%s %j is valid in strict mode', (type, number) => {
      expect(
        validateBuyerId({ type, number }, { strictRif: true }).canonical,
      ).toBe(`${type}-${number.replace(/\D/g, '')}`);
    });

    it('a wrong check digit is BUYER_ID_INVALID in strict mode and accepted when not strict', () => {
      const f = failure(() =>
        validateBuyerId(
          { type: 'J', number: '070133806' },
          { strictRif: true },
        ),
      );
      expect(f.details).toEqual({
        field: 'buyerId.number',
        reason: 'INVALID_CHECK_DIGIT',
      });
      expect(
        validateBuyerId(
          { type: 'J', number: '070133806' },
          { strictRif: false },
        ).canonical,
      ).toBe('J-070133806');
    });

    it.each([
      ['J', '07013380', 'INVALID_LENGTH'], // 8 digits: the check digit is missing
      ['G', '2000000310', 'INVALID_LENGTH'],
      ['J', '1234567', 'INVALID_LENGTH'],
    ])('%s %j fails on length even when not strict (%s)', (type, number, r) => {
      expect(
        failure(() => validateBuyerId({ type, number }, { strictRif: false }))
          .details,
      ).toEqual({ field: 'buyerId.number', reason: r });
    });

    it('the type letter takes part in the check digit', () => {
      expect(
        code(() =>
          validateBuyerId(
            { type: 'G', number: '070133805' },
            { strictRif: true },
          ),
        ),
      ).toBe('BUYER_ID_INVALID');
    });
  });

  describe('P: 6-12 alphanumerics with a digit', () => {
    it.each([
      ['P', '123456', 'P-123456'],
      ['P', 'AB123456', 'P-AB123456'],
      ['P', 'A1B2C3D4E5F6', 'P-A1B2C3D4E5F6'],
      ['P', 'ab 123456', 'P-AB123456'],
    ])('%s %j is valid', (type, number, canonical) => {
      expect(validateBuyerId({ type, number }).canonical).toBe(canonical);
    });
    it.each([
      ['P', '12345', 'INVALID_LENGTH'],
      ['P', 'ABCDEFGH', 'INVALID_FORMAT'], // no digit at all
      ['P', '1234567890123', 'INVALID_LENGTH'],
      ['P', 'AB-12_456', 'INVALID_FORMAT'],
    ])('%s %j is BUYER_ID_INVALID (%s)', (type, number, reason) => {
      expect(failure(() => validateBuyerId({ type, number })).details).toEqual({
        field: 'buyerId.number',
        reason,
      });
    });
  });

  it('type problems', () => {
    expect(
      where(() => validateBuyerId({ type: 'X', number: '12345678' })),
    ).toBe('buyerId.type:INVALID_TYPE');
    expect(
      where(() => validateBuyerId({ type: 'v', number: '12345678' })),
    ).toBe('buyerId.type:INVALID_TYPE');
    expect(where(() => validateBuyerId({ number: '12345678' }))).toBe(
      'buyerId.type:REQUIRED',
    );
    expect(code(() => validateBuyerId({ number: '12345678' }))).toBe(
      'BUYER_ID_REQUIRED',
    );
  });

  it('number problems: missing, blank, not a string, too long', () => {
    expect(where(() => validateBuyerId({ type: 'V' }))).toBe(
      'buyerId.number:REQUIRED',
    );
    expect(where(() => validateBuyerId({ type: 'V', number: '   ' }))).toBe(
      'buyerId.number:REQUIRED',
    );
    expect(where(() => validateBuyerId({ type: 'V', number: 12345678 }))).toBe(
      'buyerId.number:INVALID_FORMAT',
    );
    expect(
      where(() => validateBuyerId({ type: 'V', number: '1'.repeat(31) })),
    ).toBe('buyerId.number:INVALID_FORMAT');
  });

  it('never echoes the value in the error', () => {
    const f = failure(() =>
      validateBuyerId({ type: 'V', number: '87654321ZZ' }),
    );
    expect(JSON.stringify(f)).not.toContain('87654321');
  });
});

describe('resolveBuyerId (AC1-AC2)', () => {
  const opts = { required: true, strictRif: true };

  it('explicit buyerId: canonical, no legal name for V/E/P', () => {
    expect(
      resolveBuyerId(
        { buyerId: { type: 'V', number: '12345678' }, buyerLegalName: 'x' },
        FLAT,
        opts,
      ),
    ).toEqual({
      kind: 'explicit',
      type: 'V',
      digits: '12345678',
      canonical: 'V-12345678',
      legalName: null,
    });
    expect(
      resolveBuyerId(
        { buyerId: { type: 'P', number: 'AB123456' } },
        FLAT,
        opts,
      ),
    ).toMatchObject({ kind: 'explicit', type: 'P', legalName: null });
  });

  it('works in every shipping format (guests and accounts alike: no session input)', () => {
    for (const ctx of [FLAT, AGENCY, SAVED]) {
      expect(
        resolveBuyerId(
          { buyerId: { type: 'E', number: '81234567' } },
          ctx,
          opts,
        ).kind,
      ).toBe('explicit');
    }
  });

  describe('J / G need buyerLegalName', () => {
    it('missing or blank => BUYER_ID_REQUIRED', () => {
      for (const buyerLegalName of [undefined, '', '   ', '\n\t']) {
        const f = failure(() =>
          resolveBuyerId(
            { buyerId: { type: 'J', number: '070133805' }, buyerLegalName },
            AGENCY,
            opts,
          ),
        );
        expect(f.errorCode).toBe('BUYER_ID_REQUIRED');
        expect(f.details).toEqual({
          field: 'buyerLegalName',
          reason: 'REQUIRED',
        });
      }
    });
    it('is trimmed, collapsed and cleaned of control characters', () => {
      const r = resolveBuyerId(
        {
          buyerId: { type: 'G', number: '200000031' },
          buyerLegalName: '  Banco   de\tVenezuela \u0000 S.A. ',
        },
        AGENCY,
        opts,
      );
      expect(r).toMatchObject({
        kind: 'explicit',
        legalName: 'Banco de Venezuela S.A.',
      });
    });
    it('200 characters pass, 201 do not', () => {
      const ok = resolveBuyerId(
        {
          buyerId: { type: 'J', number: '070133805' },
          buyerLegalName: 'x'.repeat(200),
        },
        AGENCY,
        opts,
      );
      expect(ok).toMatchObject({ kind: 'explicit' });
      expect(
        where(() =>
          resolveBuyerId(
            {
              buyerId: { type: 'J', number: '070133805' },
              buyerLegalName: 'x'.repeat(201),
            },
            AGENCY,
            opts,
          ),
        ),
      ).toBe('buyerLegalName:TOO_LONG');
    });
    it.each([
      'Emp V-87654321 C.A.',
      'Emp (V-87654321) C.A.',
      'Emp C.I. 87654321 C.A.',
      'Inversiones Uno J-070133805 C.A.', // the company's OWN RIF inside its legal name
      'Inversiones Uno RIF J-07013380-5 C.A.',
      'Inversiones Uno J070133805',
      'Inversiones Uno E-81234567',
      'Ｖ-８７６５４３２１ Emp', // fullwidth
    ])(
      'a cedula or RIF inside the legal name is REJECTED, not cut: %s',
      (name) => {
        const f = failure(() =>
          resolveBuyerId(
            {
              buyerId: { type: 'J', number: '070133805' },
              buyerLegalName: name,
            },
            AGENCY,
            opts,
          ),
        );
        expect(f.status).toBe(400);
        expect(f.errorCode).toBe('BUYER_ID_INVALID');
        expect(f.details).toEqual({
          field: 'buyerLegalName',
          reason: 'CONTAINS_ID_DOC',
        });
        // the value is never echoed
        expect(JSON.stringify(f)).not.toMatch(/8765|0701|8123/);
      },
    );

    it.each([
      'Inversiones G-20000 C.A.', // too few digits for a cedula: a lot or a brand
      'Edificio P-12345 S.R.L.',
      'Banco de Venezuela S.A.',
      'Tienda 3era Avenida, C.A.',
      'Comercial 2024 1000 C.A.',
      "Mary's Cards & Co. (2021)",
    ])('a legitimate legal name passes untouched: %s', (name) => {
      expect(
        resolveBuyerId(
          { buyerId: { type: 'J', number: '070133805' }, buyerLegalName: name },
          AGENCY,
          opts,
        ),
      ).toMatchObject({ kind: 'explicit', legalName: name });
    });

    it('a non-string legal name is invalid', () => {
      expect(
        code(() =>
          resolveBuyerId(
            {
              buyerId: { type: 'J', number: '070133805' },
              buyerLegalName: 5,
            },
            AGENCY,
            opts,
          ),
        ),
      ).toBe('BUYER_ID_INVALID');
    });
  });

  describe('buyerSameAsRecipient', () => {
    it('agency format with a V/E recipient cedula: valid, the type comes from the body', () => {
      expect(
        resolveBuyerId({ buyerSameAsRecipient: true }, AGENCY, opts),
      ).toEqual({
        kind: 'same-as-recipient',
        fromBody: { type: 'V', canonical: 'V-12345678' },
      });
      expect(
        resolveBuyerId(
          { buyerSameAsRecipient: true },
          { format: 'agency', recipientIdDoc: 'e 81.234.567' },
          opts,
        ),
      ).toEqual({
        kind: 'same-as-recipient',
        fromBody: { type: 'E', canonical: 'E-81234567' },
      });
    });

    it('saved address: valid here, the recipient cedula is checked inside the transaction', () => {
      expect(
        resolveBuyerId({ buyerSameAsRecipient: true }, SAVED, opts),
      ).toEqual({ kind: 'same-as-recipient', fromBody: null });
    });

    it('legacy flat format => BUYER_ID_REQUIRED (there is no recipient cedula to copy)', () => {
      const f = failure(() =>
        resolveBuyerId({ buyerSameAsRecipient: true }, FLAT, opts),
      );
      expect(f.status).toBe(400);
      expect(f.errorCode).toBe('BUYER_ID_REQUIRED');
      expect(f.details).toEqual({
        field: 'buyerSameAsRecipient',
        reason: 'SAME_AS_RECIPIENT_NEEDS_AGENCY_FORMAT',
      });
      // ... even when the flat body carries a cedula of its own
      expect(
        code(() =>
          resolveBuyerId(
            { buyerSameAsRecipient: true },
            { format: 'flat', recipientIdDoc: 'V-12345678' },
            opts,
          ),
        ),
      ).toBe('BUYER_ID_REQUIRED');
    });

    it('agency format without a valid V/E recipient cedula: left to the shipping validation (SHIPPING_INVALID, recipientIdDoc), which is the actionable error', () => {
      for (const recipientIdDoc of [
        null,
        '',
        '   ',
        'J-070133805',
        'P-AB123456',
        'V-123',
        'V-****5678',
      ]) {
        expect(
          resolveBuyerId(
            { buyerSameAsRecipient: true },
            { format: 'agency', recipientIdDoc },
            opts,
          ),
        ).toEqual({ kind: 'same-as-recipient', fromBody: null });
      }
    });

    it('with an explicit buyerId it is a contradiction, never a silent pick', () => {
      expect(
        where(() =>
          resolveBuyerId(
            {
              buyerId: { type: 'V', number: '12345678' },
              buyerSameAsRecipient: true,
            },
            AGENCY,
            opts,
          ),
        ),
      ).toBe('buyerSameAsRecipient:CONFLICTS_WITH_BUYER_ID');
    });

    it('buyerSameAsRecipient:false next to a buyerId is fine', () => {
      expect(
        resolveBuyerId(
          {
            buyerId: { type: 'V', number: '12345678' },
            buyerSameAsRecipient: false,
          },
          AGENCY,
          opts,
        ).kind,
      ).toBe('explicit');
    });
  });

  describe('nothing sent', () => {
    it('required => 400 BUYER_ID_REQUIRED', () => {
      for (const dto of [
        {},
        { buyerSameAsRecipient: false },
        { buyerId: null },
      ]) {
        const f = failure(() => resolveBuyerId(dto, AGENCY, opts));
        expect(f.status).toBe(400);
        expect(f.errorCode).toBe('BUYER_ID_REQUIRED');
        expect(f.details).toEqual({ field: 'buyerId', reason: 'REQUIRED' });
      }
    });
    it('not required => none (the order keeps no buyer ID)', () => {
      expect(
        resolveBuyerId({}, FLAT, { required: false, strictRif: true }),
      ).toEqual({ kind: 'none' });
    });
    it('a buyerId that IS sent is validated even when not required', () => {
      expect(
        code(() =>
          resolveBuyerId({ buyerId: { type: 'V', number: '12' } }, FLAT, {
            required: false,
          }),
        ),
      ).toBe('BUYER_ID_INVALID');
    });
  });

  it('is pure: same input, same output, no mutation of the input', () => {
    const dto = Object.freeze({
      buyerId: Object.freeze({ type: 'V', number: '12345678' }),
    });
    expect(resolveBuyerId(dto, AGENCY, opts)).toEqual(
      resolveBuyerId(dto, AGENCY, opts),
    );
  });
});

describe('isBuyerIdRequired (the deployment switch)', () => {
  const warn = () =>
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  beforeEach(() => resetBuyerIdSwitchWarnings());

  it('only the exact string "true" turns it on; the default is OFF', () => {
    const spy = warn();
    try {
      expect(isBuyerIdRequired({})).toBe(false);
      for (const v of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
        expect(isBuyerIdRequired({ CHECKOUT_REQUIRE_BUYER_ID: v })).toBe(false);
      }
      expect(isBuyerIdRequired({ CHECKOUT_REQUIRE_BUYER_ID: 'true' })).toBe(
        true,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('unset, "true" and "false" are silent; EVERY other value warns (any environment), once per value', () => {
    const spy = warn();
    const prev = process.env.NODE_ENV;
    try {
      for (const env of ['test', 'development', 'production']) {
        process.env.NODE_ENV = env;
        resetBuyerIdSwitchWarnings();
        spy.mockClear();
        for (const ok of [undefined, 'true', 'false']) {
          isBuyerIdRequired({ CHECKOUT_REQUIRE_BUYER_ID: ok });
        }
        expect(spy).not.toHaveBeenCalled();
        for (const bad of ['TRUE', 'True', '1', 'yes', ' true', '', 'on']) {
          isBuyerIdRequired({ CHECKOUT_REQUIRE_BUYER_ID: bad });
          isBuyerIdRequired({ CHECKOUT_REQUIRE_BUYER_ID: bad }); // read per request: no flood
        }
        expect(spy).toHaveBeenCalledTimes(7);
        expect(String(spy.mock.calls[0][0])).toContain(
          'CHECKOUT_REQUIRE_BUYER_ID="TRUE" is not recognized',
        );
      }
    } finally {
      process.env.NODE_ENV = prev;
      spy.mockRestore();
    }
  });
});
