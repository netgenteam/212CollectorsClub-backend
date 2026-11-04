import { LegalAuditService } from './legal-audit.service.js';

const actor = { id: '00000000-0000-4000-8000-000000000001', email: 'a@x.test' };

function fakeTx(recent: boolean) {
  const created: unknown[] = [];
  return {
    created,
    tx: {
      $queryRaw: () => Promise.resolve([{ recent }]),
      legalAuditLog: {
        create: (args: unknown) => {
          created.push(args);
          return Promise.resolve({});
        },
      },
    } as never,
  };
}

describe('LegalAuditService', () => {
  const svc = new LegalAuditService();

  it('record writes through the transaction it is given, with the admin snapshot', async () => {
    const { tx, created } = fakeTx(false);
    await svc.record(
      tx,
      {
        documentId: 'doc',
        action: 'PUBLISHED',
        actor,
        versionNumber: 3,
        meta: { a: 1 },
      },
      { add: () => undefined },
    );
    expect(created).toEqual([
      {
        data: {
          documentId: 'doc',
          action: 'PUBLISHED',
          adminUserId: actor.id,
          adminEmail: actor.email,
          versionNumber: 3,
          meta: { a: 1 },
        },
      },
    ]);
  });

  it('DRAFT_EDITED is omitted inside the 10-minute window and written outside it', async () => {
    const inside = fakeTx(true);
    expect(
      await svc.recordDraftEdited(inside.tx, { documentId: 'd', actor }),
    ).toBe(false);
    expect(inside.created).toHaveLength(0);
    const outside = fakeTx(false);
    expect(
      await svc.recordDraftEdited(outside.tx, { documentId: 'd', actor }),
    ).toBe(true);
    expect(outside.created).toHaveLength(1);
  });

  it('boundMeta keeps meta under the 2 KB DB limit', () => {
    const big = LegalAuditService.boundMeta({
      a: 'x'.repeat(4000),
      b: 'y'.repeat(4000),
    });
    expect(Buffer.byteLength(JSON.stringify(big))).toBeLessThanOrEqual(2048);
    const small = { changedFields: ['rif'] };
    expect(LegalAuditService.boundMeta(small)).toEqual(small);
    const many = LegalAuditService.boundMeta(
      Object.fromEntries(
        Array.from({ length: 200 }, (_, i) => [`k${i}`, 'v'.repeat(30)]),
      ),
    );
    expect(Buffer.byteLength(JSON.stringify(many))).toBeLessThanOrEqual(2048);
  });
});
