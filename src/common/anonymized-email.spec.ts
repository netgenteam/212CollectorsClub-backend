import { describe, expect, it } from 'vitest';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import {
  ANONYMIZED_EMAIL_DOMAIN,
  anonymizedEmailFor,
  emailsMatch,
  isAnonymizedEmail,
} from './anonymized-email.js';
import { RegisterCustomerDto } from '../customer-auth/dto/register-customer.dto.js';

describe('anonymized email domain (Story 20.6, A84)', () => {
  it('the placeholder of a customer is in the reserved domain', () => {
    const id = '0b9a8a4e-6a5f-4d0d-9e3a-1c2d3e4f5a6b';
    expect(anonymizedEmailFor(id)).toBe(`deleted+${id}@anonymized.invalid`);
    expect(isAnonymizedEmail(anonymizedEmailFor(id))).toBe(true);
  });

  it.each([
    'deleted+x@anonymized.invalid',
    'DELETED+X@ANONYMIZED.INVALID',
    '  a@Anonymized.Invalid  ',
    'a@anonymized.invalid.',
    'a@sub.anonymized.invalid',
    'a@ａnonymized.invalid', // full-width letter, NFKC
    '"x@y"@anonymized.invalid',
  ])('%j is blocked', (e) => {
    expect(isAnonymizedEmail(e)).toBe(true);
  });

  it.each([
    'a@example.com',
    'a@anonymized.invalid.example.com',
    'a@notanonymized.invalid',
    'anonymized.invalid@example.com', // only the domain counts
    'a@invalid',
    '',
    'no-at-sign',
  ])('%j is allowed', (e) => {
    expect(isAnonymizedEmail(e)).toBe(false);
  });

  it('non-strings are not blocked (the DTO type check rejects them elsewhere)', () => {
    expect(isAnonymizedEmail(undefined)).toBe(false);
    expect(isAnonymizedEmail(42)).toBe(false);
  });

  it('the constant is the RFC 2606 reserved TLD', () => {
    expect(ANONYMIZED_EMAIL_DOMAIN.endsWith('.invalid')).toBe(true);
  });

  describe('emailsMatch (the admin typed the email to confirm)', () => {
    it('is case-insensitive, trims and normalizes', () => {
      expect(emailsMatch('  Ana@Example.COM ', 'ana@example.com')).toBe(true);
      expect(emailsMatch('ａna@example.com', 'ana@example.com')).toBe(true);
    });
    it.each([
      'ana@example.co',
      'ana@example.comm',
      '',
      'ana',
      'bob@example.com',
    ])('%j does not match', (t) => {
      expect(emailsMatch(t, 'ana@example.com')).toBe(false);
    });
  });

  describe('RegisterCustomerDto', () => {
    const check = (email: string) =>
      validate(
        plainToInstance(RegisterCustomerDto, {
          email,
          password: 'a-strong-password',
          name: 'Ada',
        }),
      );
    it('rejects the reserved domain, accepts a normal one', async () => {
      const bad = await check('Deleted+abc@Anonymized.Invalid');
      expect(bad.some((e) => e.property === 'email')).toBe(true);
      expect(await check('ada@example.com')).toHaveLength(0);
    });
  });
});
