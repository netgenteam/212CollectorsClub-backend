import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { RetentionController } from './retention.controller.js';
import { RetentionGuardError } from './retention.service.js';

const req = { user: { id: '33333333-3333-4333-8333-333333333333' } } as never;

describe('POST /admin/retention/run answers (Story 20.8 round 2)', () => {
  it('NODE_ENV=test against a database that is not a throw-away clone: 409 RETENTION_REFUSED_TEST_ENV with a plain reason, not a bare 500', async () => {
    const service = {
      start: () =>
        Promise.reject(
          new RetentionGuardError(
            'refuses to run under NODE_ENV=test on database "collectorsclub_dev"',
          ),
        ),
    };
    const c = new RetentionController(service as never, {} as never);
    const err = await c.run(req, {} as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiException);
    const ex = err as ApiException;
    expect(ex.getStatus()).toBe(HttpStatus.CONFLICT);
    const body = ex.getResponse() as { errorCode: string; message: string };
    expect(body.errorCode).toBe('RETENTION_REFUSED_TEST_ENV');
    expect(body.message).toMatch(/NODE_ENV=test/);
    expect(body.message).toMatch(/throw-away/);
    // the name of the database is for the log, not for the response
    expect(body.message).not.toMatch(/collectorsclub_dev/);
  });

  it('any other failure is not disguised', async () => {
    const boom = new Error('db down');
    const c = new RetentionController(
      { start: () => Promise.reject(boom) } as never,
      {} as never,
    );
    await expect(c.run(req, {} as never)).rejects.toBe(boom);
  });

  it('busy and disabled keep their codes', async () => {
    for (const [kind, code] of [
      ['busy', 'RETENTION_ALREADY_RUNNING'],
      ['disabled', 'RETENTION_DISABLED'],
    ] as const) {
      const c = new RetentionController(
        { start: () => Promise.resolve({ kind }) } as never,
        {} as never,
      );
      const err = (await c
        .run(req, {} as never)
        .catch((e: unknown) => e)) as ApiException;
      expect((err.getResponse() as { errorCode: string }).errorCode).toBe(code);
    }
  });
});
