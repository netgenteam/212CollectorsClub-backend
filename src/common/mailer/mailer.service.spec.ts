import { describe, expect, it } from 'vitest';
import { maskEmails, sanitizeMailError } from './mailer.service.js';

describe('mailer error masking (Story 20.7 round 3)', () => {
  it('masks every address, keeps the domain', () => {
    expect(
      maskEmails('550 5.1.1 <c4@qa.test> and ana.p+x@mail.example.com'),
    ).toBe('550 5.1.1 <c***@qa.test> and a***@mail.example.com');
  });

  it('the error that leaves the mailer carries no address in message, response, command or rejected', () => {
    const err = Object.assign(new Error('Recipient c4@qa.test rejected'), {
      response: '550 5.1.1 <c4@qa.test> unknown',
      command: 'RCPT TO:<c4@qa.test>',
      rejected: ['c4@qa.test'],
      rejectedErrors: [{ recipient: 'c4@qa.test' }],
    });
    const out = sanitizeMailError(err) as Error & Record<string, unknown>;
    expect(
      JSON.stringify([out.message, out.stack, out.response, out.command]),
    ).not.toContain('c4@');
    expect(out.rejected).toBeUndefined();
    expect(out.rejectedErrors).toBeUndefined();
    expect(out.response).toBe('550 5.1.1 <c***@qa.test> unknown');
  });
});
