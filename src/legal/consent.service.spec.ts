import { ApiException } from '../common/api-exception.js';
import { Logger } from '@nestjs/common';
import {
  ConsentService,
  consentSlugPrefixIgnored,
  consentSlugs,
} from './consent.service.js';

const NOW = new Date('2026-11-03T12:00:00.000Z');
type Row = {
  now: Date;
  slug: string | null;
  id: string | null;
  versionNumber: number | null;
};
const row = (slug: string, versionNumber: number): Row => ({
  now: NOW,
  slug,
  id: `id-${slug}-${versionNumber}`,
  versionNumber,
});

function make(rows: Row[], requirePublished = false) {
  const queryRaw = vi
    .fn()
    .mockResolvedValue(
      rows.length
        ? rows
        : [{ now: NOW, slug: null, id: null, versionNumber: null }],
    );
  const executeRaw = vi.fn().mockResolvedValue(0);
  const db = { $queryRaw: queryRaw, $executeRaw: executeRaw };
  const svc = new ConsentService(
    {} as never,
    {
      get: (k: string) =>
        k === 'LEGAL_REQUIRE_PUBLISHED' && requirePublished
          ? 'true'
          : undefined,
    } as never,
  );
  return { svc, db: db as never, executeRaw };
}

/** Rows of the multi-row INSERT: 6 parameters per row (customer, order, type, version id, version, context). */
const rowsOf = (executeRaw: ReturnType<typeof vi.fn>) => {
  const sql = executeRaw.mock.calls[0][1] as { values: unknown[] };
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < sql.values.length; i += 6) {
    const [customerId, orderId, type, documentVersionId, version, context] =
      sql.values.slice(i, i + 6);
    out.push({
      customerId,
      orderId,
      type,
      documentVersionId,
      version,
      context,
    });
  }
  return out;
};

const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    return (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
      details?: Record<string, unknown>;
    };
  }
  throw new Error('expected a rejection');
};

const IN_FORCE = [row('terminos', 3), row('envios', 2), row('devoluciones', 4)];

describe('ConsentService.assertAccepted (Story 19.4, AD-92)', () => {
  it('accepts the versions in force and returns them with the DB clock', async () => {
    const { svc, db } = make(IN_FORCE);
    const r = await svc.assertAccepted(db, {
      terms: 3,
      shipping: 2,
      returns: 4,
    });
    expect(r.now).toBe(NOW);
    expect(r.versions.terms?.versionNumber).toBe(3);
    expect(r.versions.shipping?.versionNumber).toBe(2);
    expect(r.versions.returns?.versionId).toBe('id-devoluciones-4');
  });

  it('a missing field is 400 CONSENT_REQUIRED listing every missing one', async () => {
    const { svc, db } = make(IN_FORCE);
    const b = await fail(
      svc.assertAccepted(db, {
        terms: 3,
        shipping: undefined,
        returns: undefined,
      }),
    );
    expect(b.statusCode).toBe(400);
    expect(b.errorCode).toBe('CONSENT_REQUIRED');
    expect(b.details?.missing).toEqual([
      'acceptedShippingVersion',
      'acceptedReturnsVersion',
    ]);
  });

  it('age: anything but exactly true is missing, and it is required even with no document in force', async () => {
    for (const declared of [undefined, false, 'true', 1]) {
      const { svc, db } = make([]);
      const b = await fail(
        svc.assertAccepted(db, { terms: undefined }, { declared }),
      );
      expect(b.errorCode).toBe('CONSENT_REQUIRED');
      expect(b.details?.missing).toEqual(['ageDeclared']);
    }
    const { svc, db } = make([]);
    await expect(
      svc.assertAccepted(db, { terms: undefined }, { declared: true }),
    ).resolves.toMatchObject({ versions: {} });
  });

  it('an old (or invented) version is 409 CONSENT_VERSION_STALE with the versions in force', async () => {
    for (const sent of [2, 4, 3.5, '3']) {
      const { svc, db } = make(IN_FORCE);
      const b = await fail(
        svc.assertAccepted(db, { terms: sent, shipping: 2, returns: 4 }),
      );
      expect(b.statusCode).toBe(409);
      expect(b.errorCode).toBe('CONSENT_VERSION_STALE');
      expect(b.details?.current).toEqual({
        terminos: 3,
        envios: 2,
        devoluciones: 4,
      });
      expect(b.details?.stale).toEqual(['acceptedTermsVersion']);
    }
  });

  it('missing wins over stale (400 before 409)', async () => {
    const { svc, db } = make(IN_FORCE);
    const b = await fail(
      svc.assertAccepted(db, { terms: 1, shipping: undefined, returns: 4 }),
    );
    expect(b.statusCode).toBe(400);
  });

  describe('a required document with NO version in force', () => {
    it('LEGAL_REQUIRE_PUBLISHED=false: not required, nothing accepted, nothing to record', async () => {
      const { svc, db, executeRaw } = make([row('terminos', 3)]);
      const r = await svc.assertAccepted(db, {
        terms: 3,
        shipping: undefined,
        returns: undefined,
      });
      expect(Object.keys(r.versions)).toEqual(['terms']);
      await svc.recordConsents(db, {
        context: 'CHECKOUT',
        orderId: 'o1',
        accepted: r,
        keys: ['terms', 'shipping', 'returns'],
      });
      expect(rowsOf(executeRaw)).toHaveLength(1); // only TERMS
      expect(rowsOf(executeRaw)[0]).toMatchObject({
        type: 'TERMS',
        version: 3,
        orderId: 'o1',
      });
    });

    it('a version SENT for a document that has none is stale: a version that does not exist cannot be accepted', async () => {
      const { svc, db } = make([]);
      const b = await fail(svc.assertAccepted(db, { terms: 1 }));
      expect(b.statusCode).toBe(409);
      expect(b.errorCode).toBe('CONSENT_VERSION_STALE');
      expect(b.details?.current).toEqual({});
    });

    it('nothing in force at all and nothing sent: passes, with NO versions', async () => {
      const { svc, db, executeRaw } = make([]);
      const r = await svc.assertAccepted(db, {
        terms: undefined,
        shipping: undefined,
        returns: undefined,
      });
      expect(r.versions).toEqual({});
      await svc.recordConsents(db, {
        context: 'CHECKOUT',
        orderId: 'o1',
        accepted: r,
        keys: ['terms', 'shipping', 'returns'],
      });
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('LEGAL_REQUIRE_PUBLISHED=true: 503 LEGAL_NOT_PUBLISHED naming the documents, before any other check', async () => {
      const { svc, db } = make([row('terminos', 3)], true);
      const b = await fail(
        svc.assertAccepted(db, { terms: undefined, shipping: 1 }),
      );
      expect(b.statusCode).toBe(503);
      expect(b.errorCode).toBe('LEGAL_NOT_PUBLISHED');
      expect(b.details?.documents).toEqual(['envios']);
    });

    it('is visible: a WARN without PII, at most once a minute per document', async () => {
      const { svc, db } = make([]);
      const warn = vi
        .spyOn(
          (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      await svc.assertAccepted(db, { terms: undefined });
      await svc.assertAccepted(db, { terms: undefined });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(/terminos/);
      expect(warn.mock.calls[0][0]).toMatch(/LEGAL_REQUIRE_PUBLISHED/);
    });
  });
});

describe('ConsentService.recordConsents', () => {
  it('writes ONE multi-row INSERT with TERMS/PRIVACY and the age declaration tied to the TERMS version', async () => {
    const { svc, db, executeRaw } = make([
      row('terminos', 3),
      row('privacidad', 2),
    ]);
    const accepted = await svc.assertAccepted(
      db,
      { terms: 3, privacy: 2 },
      { declared: true },
    );
    await svc.recordConsents(db, {
      context: 'REGISTER',
      customerId: 'c1',
      accepted,
      keys: ['terms', 'privacy'],
      age: true,
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const data = rowsOf(executeRaw);
    expect(data.map((d) => [d.type, d.version, d.context])).toEqual([
      ['TERMS', 3, 'REGISTER'],
      ['PRIVACY', 2, 'REGISTER'],
      ['AGE_DECLARATION', 3, 'REGISTER'],
    ]);
    expect(data.every((d) => d.customerId === 'c1' && d.orderId === null)).toBe(
      true,
    );
    // only ids, versions and context: nothing else is ever written
    for (const d of data) {
      expect(Object.keys(d).sort()).toEqual([
        'context',
        'customerId',
        'documentVersionId',
        'orderId',
        'type',
        'version',
      ]);
    }
  });

  it('age with TERMS not in force: a declaration with no document (documentVersionId null, version 0)', async () => {
    const { svc, db, executeRaw } = make([]);
    const accepted = await svc.assertAccepted(
      db,
      { terms: undefined },
      { declared: true },
    );
    await svc.recordConsents(db, {
      context: 'REGISTER',
      customerId: 'c1',
      accepted,
      keys: ['terms', 'privacy'],
      age: true,
    });
    expect(rowsOf(executeRaw)).toEqual([
      {
        context: 'REGISTER',
        customerId: 'c1',
        orderId: null,
        type: 'AGE_DECLARATION',
        documentVersionId: null,
        version: 0,
      },
    ]);
  });
});

describe('consentSlugs', () => {
  const real = {
    terms: 'terminos',
    privacy: 'privacidad',
    shipping: 'envios',
    returns: 'devoluciones',
  };
  const sandbox = {
    terms: 'e2e-terminos',
    privacy: 'e2e-privacidad',
    shipping: 'e2e-envios',
    returns: 'e2e-devoluciones',
  };

  it('real slugs without the variable', () => {
    expect(consentSlugs({})).toEqual(real);
    expect(consentSlugs({ NODE_ENV: 'test' })).toEqual(real);
  });

  it('the e2e- prefix applies ONLY with NODE_ENV=test (positive list)', () => {
    expect(
      consentSlugs({ NODE_ENV: 'test', LEGAL_CONSENT_SLUG_PREFIX: 'e2e-' }),
    ).toEqual(sandbox);
  });

  it.each(['production', 'staging', 'development', '', 'Test', 'e2e'])(
    'is ignored with NODE_ENV=%j',
    (nodeEnv) => {
      expect(
        consentSlugs({
          NODE_ENV: nodeEnv,
          LEGAL_CONSENT_SLUG_PREFIX: 'e2e-',
        }),
      ).toEqual(real);
    },
  );

  it('is ignored with NODE_ENV unset', () => {
    expect(consentSlugs({ LEGAL_CONSENT_SLUG_PREFIX: 'e2e-' })).toEqual(real);
  });

  it('any prefix other than exactly "e2e-" is ignored, even in test', () => {
    for (const p of ['x-', 'e2e', 'E2E-', ' e2e-', ''])
      expect(
        consentSlugs({ NODE_ENV: 'test', LEGAL_CONSENT_SLUG_PREFIX: p }),
      ).toEqual(real);
  });
});

describe('consentSlugPrefixIgnored (startup WARN trigger)', () => {
  it('true only when the variable is present and not applied', () => {
    expect(consentSlugPrefixIgnored({})).toBe(false);
    expect(consentSlugPrefixIgnored({ NODE_ENV: 'staging' })).toBe(false);
    expect(
      consentSlugPrefixIgnored({
        NODE_ENV: 'test',
        LEGAL_CONSENT_SLUG_PREFIX: 'e2e-',
      }),
    ).toBe(false);
    for (const nodeEnv of ['production', 'staging', 'development', undefined])
      expect(
        consentSlugPrefixIgnored({
          NODE_ENV: nodeEnv,
          LEGAL_CONSENT_SLUG_PREFIX: 'e2e-',
        }),
      ).toBe(true);
  });

  it('the service warns at construction and does not apply the prefix', () => {
    const prev = { ...process.env };
    process.env.NODE_ENV = 'staging';
    process.env.LEGAL_CONSENT_SLUG_PREFIX = 'e2e-';
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const svc = new ConsentService({} as never, {} as never);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('LEGAL_CONSENT_SLUG_PREFIX'),
      );
      expect((svc as unknown as { slugs: { terms: string } }).slugs.terms).toBe(
        'terminos',
      );
    } finally {
      warn.mockRestore();
      process.env.NODE_ENV = prev.NODE_ENV;
      if (prev.LEGAL_CONSENT_SLUG_PREFIX === undefined)
        delete process.env.LEGAL_CONSENT_SLUG_PREFIX;
      else
        process.env.LEGAL_CONSENT_SLUG_PREFIX = prev.LEGAL_CONSENT_SLUG_PREFIX;
    }
  });
});

describe('ConsentService.status / reaccept: the age declaration', () => {
  /** `$transaction` runs the callback on the same mock; queries answer in call order. */
  function make(opts: {
    ageCount: number;
    docs?: unknown[];
    last?: unknown[];
  }) {
    const queryRaw = vi
      .fn()
      // reaccept: assertAccepted, then statusIn(docs, last); status alone: docs, last
      .mockImplementation((strings: TemplateStringsArray) => {
        const text = strings.join('?');
        if (text.includes('lastSubstantialVersion'))
          return Promise.resolve(opts.docs ?? []);
        if (text.includes('max("version")'))
          return Promise.resolve(opts.last ?? []);
        return Promise.resolve([
          { now: NOW, slug: 'terminos', id: 'idT', versionNumber: 3 },
          { now: NOW, slug: 'privacidad', id: 'idP', versionNumber: 2 },
        ]);
      });
    const executeRaw = vi.fn().mockResolvedValue(1);
    const prisma: Record<string, unknown> = {
      $queryRaw: queryRaw,
      $executeRaw: executeRaw,
      consentRecord: { count: vi.fn().mockResolvedValue(opts.ageCount) },
    };
    prisma.$transaction = (cb: (tx: unknown) => unknown) => cb(prisma);
    const svc = new ConsentService(
      prisma as never,
      {
        get: () => undefined,
      } as never,
    );
    return { svc, executeRaw };
  }

  it('status: ageDeclarationPending is true while the customer has no AGE_DECLARATION', async () => {
    expect(
      (await make({ ageCount: 0 }).svc.status('c1')).ageDeclarationPending,
    ).toBe(true);
    expect(
      (await make({ ageCount: 1 }).svc.status('c1')).ageDeclarationPending,
    ).toBe(false);
  });

  it('reaccept without the age while it is pending: 400 CONSENT_REQUIRED (ageDeclared), nothing written', async () => {
    const { svc, executeRaw } = make({ ageCount: 0 });
    const b = await fail(svc.reaccept('c1', { terms: 3, privacy: 2 }));
    expect(b.errorCode).toBe('CONSENT_REQUIRED');
    expect(b.details?.missing).toEqual(['ageDeclared']);
    expect(
      executeRaw.mock.calls.some((c) => String(c[0]).includes('INSERT')),
    ).toBe(false);
  });

  it('reaccept with ageDeclared:true records the age too; once declared it is not asked nor written again', async () => {
    const first = make({
      ageCount: 0,
      docs: [
        {
          slug: 'terminos',
          versionNumber: 3,
          changeSummary: 'x',
          lastSubstantialVersion: 3,
        },
        {
          slug: 'privacidad',
          versionNumber: 2,
          changeSummary: 'y',
          lastSubstantialVersion: 2,
        },
      ],
    });
    await first.svc.reaccept('c1', { terms: 3, privacy: 2, ageDeclared: true });
    const insert = first.executeRaw.mock.calls.find((c) =>
      String(c[0]).includes('INSERT'),
    )!;
    const vals = (insert[1] as { values: unknown[] }).values;
    expect(vals.filter((_v, i) => i % 6 === 2)).toEqual([
      'TERMS',
      'PRIVACY',
      'AGE_DECLARATION',
    ]);
    const again = make({ ageCount: 1 });
    await again.svc.reaccept('c1', { terms: 3, privacy: 2 }); // no ageDeclared needed
    expect(
      again.executeRaw.mock.calls.some((c) => String(c[0]).includes('INSERT')),
    ).toBe(false);
  });
});
