import { isVersionInsertRejected } from './legal-admin.common.js';

describe('isVersionInsertRejected', () => {
  it('recognises the guard trigger error as the pg adapter reports it (SQLSTATE 23000)', () => {
    const err = Object.assign(new Error('Raw query failed. Code: `23000`.'), {
      code: 'P2010',
      meta: {
        driverAdapterError: {
          cause: {
            code: '23000',
            message: 'Legal_Document_Versions: versionNumber must be 2',
          },
        },
      },
    });
    expect(isVersionInsertRejected(err)).toBe(true);
  });

  it('recognises P2002 and nested causes', () => {
    expect(
      isVersionInsertRejected(Object.assign(new Error('x'), { code: 'P2002' })),
    ).toBe(true);
    expect(
      isVersionInsertRejected(
        new Error('outer', {
          cause: Object.assign(new Error('in'), { code: '23505' }),
        }),
      ),
    ).toBe(true);
  });

  it('does not swallow unrelated errors', () => {
    expect(isVersionInsertRejected(new Error('connection reset'))).toBe(false);
    expect(
      isVersionInsertRejected(Object.assign(new Error('x'), { code: 'P2025' })),
    ).toBe(false);
    expect(isVersionInsertRejected('nope')).toBe(false);
  });
});
