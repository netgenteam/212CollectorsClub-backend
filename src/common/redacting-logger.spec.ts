import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RedactingLogger } from './redacting-logger.js';

const SENTINEL = 'V-98765432';
const SENTINELS = [SENTINEL, '98765432', '98.765.432'];

describe('RedactingLogger: log traversal with a sentinel cedula (AC7, NFR-20.5)', () => {
  let out: string[];
  let outSpy: { mockRestore(): void };
  let errSpy: { mockRestore(): void };
  beforeEach(() => {
    out = [];
    const sink = (chunk: unknown): boolean => {
      out.push(String(chunk));
      return true;
    };
    outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink);
  });
  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('never writes the sentinel through any level, shape or the static Logger', () => {
    const log = new RedactingLogger('Test', { colors: false });
    Logger.overrideLogger(log);
    const prismaLike = Object.assign(
      new Error(`Argument id: ${SENTINEL} is not a uuid`),
      {
        code: 'P2023',
        meta: { recipientIdDoc: SENTINEL },
      },
    );
    log.log(`order for ${SENTINEL}`);
    log.log({
      recipientIdDoc: SENTINEL,
      buyerIdNumber: '98765432',
      nested: [{ idDoc: SENTINEL }],
    });
    log.log('with param', { cedula: SENTINEL, note: `ref ${SENTINEL}` });
    log.warn(`cedula v-98.765.432 invalida`);
    log.error(prismaLike);
    log.error(`failed ${SENTINEL}`, prismaLike.stack);
    log.error(new Error(`wrapped: ${SENTINEL}`));
    log.debug?.(`debug ${SENTINEL}`);
    log.verbose?.({ list: [SENTINEL, { x: SENTINEL }] });
    log.fatal?.(`fatal ${SENTINEL}`);
    new Logger('Other').log(`static ${SENTINEL}`);
    Logger.error(`static error ${SENTINEL}`, prismaLike.stack, 'Ctx');
    expect(out.length).toBeGreaterThan(8);
    const all = out.join('');
    for (const s of SENTINELS) expect(all, s).not.toContain(s);
    expect(all).toContain('[REDACTED');
    expect(all).toContain('P2023'); // the useful part of the error survives
  });

  it('keeps UUIDs, dates and amounts readable', () => {
    const log = new RedactingLogger('Test', { colors: false });
    log.log(
      'order e1234567-89ab-4cde-8f01-23456789abcd at 2026-11-03 total 1.234.567,89',
    );
    expect(out.join('')).toContain(
      'e1234567-89ab-4cde-8f01-23456789abcd at 2026-11-03 total 1.234.567,89',
    );
  });
});
