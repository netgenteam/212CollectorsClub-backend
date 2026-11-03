import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { ConsentContext, ConsentType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  computePendingConsents,
  type CurrentConsentDocument,
  type PendingConsent,
} from './consent-pending.js';

/**
 * Story 19.4 (AD-92, FR-112..116). Validates what a person says they accepted
 * against the versions in force and records the evidence.
 *
 * - "In force" = highest `versionNumber` with `effectiveFrom <= now()` (the
 *   DATABASE clock), always read from the DB (no cache, A76).
 * - A document with NO version in force can never be "accepted": nothing is
 *   recorded for it, and a version sent for it is a 409. With
 *   `LEGAL_REQUIRE_PUBLISHED=true` the operation is refused with 503
 *   `LEGAL_NOT_PUBLISHED`; with `false` (default, dev/test) the document is
 *   simply not required, a WARN is logged (no PII) and the order/consent
 *   columns stay NULL, so the gap is visible instead of silent (A75).
 * - The age declaration is always required where asked (register, re-accept).
 */
export type ConsentKey = 'terms' | 'privacy' | 'shipping' | 'returns';

export const CONSENT_KEYS: readonly ConsentKey[] = [
  'terms',
  'privacy',
  'shipping',
  'returns',
];

/** Logical slugs of the four documents that carry an acceptance (A73). */
export const CONSENT_SLUG: Record<ConsentKey, string> = {
  terms: 'terminos',
  privacy: 'privacidad',
  shipping: 'envios',
  returns: 'devoluciones',
};

/** Name of the request field that carries each version (for `details.missing`). */
export const CONSENT_FIELD: Record<ConsentKey, string> = {
  terms: 'acceptedTermsVersion',
  privacy: 'acceptedPrivacyVersion',
  shipping: 'acceptedShippingVersion',
  returns: 'acceptedReturnsVersion',
};

const TYPE_OF: Record<ConsentKey, ConsentType> = {
  terms: ConsentType.TERMS,
  privacy: ConsentType.PRIVACY,
  shipping: ConsentType.SHIPPING,
  returns: ConsentType.RETURNS,
};

/**
 * Physical slugs. `LEGAL_CONSENT_SLUG_PREFIX=e2e-` points every lookup at the
 * SANDBOX documents (`e2e-terminos`, ...) so tests never need to publish (an
 * immutable action) on a real document. Positive list (QA 19.4a): it is
 * honoured ONLY with `NODE_ENV=test`; in any other environment (production,
 * staging, development, or NODE_ENV unset) it is ignored, because honouring it
 * there would shadow the real documents and let a registration through with no
 * terms. Any prefix other than exactly `e2e-` is ignored too.
 */
export function consentSlugs(
  env: NodeJS.ProcessEnv = process.env,
): Record<ConsentKey, string> {
  const prefix =
    env.NODE_ENV === 'test' && env.LEGAL_CONSENT_SLUG_PREFIX === 'e2e-'
      ? 'e2e-'
      : '';
  return {
    terms: prefix + CONSENT_SLUG.terms,
    privacy: prefix + CONSENT_SLUG.privacy,
    shipping: prefix + CONSENT_SLUG.shipping,
    returns: prefix + CONSENT_SLUG.returns,
  };
}

/** True when LEGAL_CONSENT_SLUG_PREFIX is set but `consentSlugs` will not apply it. */
export function consentSlugPrefixIgnored(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    !!env.LEGAL_CONSENT_SLUG_PREFIX &&
    consentSlugs(env).terms === CONSENT_SLUG.terms
  );
}

export interface AcceptedVersion {
  versionId: string;
  versionNumber: number;
}

export interface AcceptedConsents {
  /** Transaction clock of the DB: what `acceptedAt` defaults to in the same tx. */
  now: Date;
  /** Only documents that have a version in force. */
  versions: Partial<Record<ConsentKey, AcceptedVersion>>;
}

/** Any Prisma client or interactive-transaction client. */
export type ConsentDb = Prisma.TransactionClient;

type SentVersions = Partial<Record<ConsentKey, unknown>>;

const WARN_EVERY_MS = 60_000;

@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);
  private readonly slugs = consentSlugs();
  private readonly lastWarn = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    if (consentSlugPrefixIgnored()) {
      this.logger.warn(
        'LEGAL_CONSENT_SLUG_PREFIX is set but ignored: it only applies with NODE_ENV=test. Remove it from this environment.',
      );
    }
  }

  private get requirePublished(): boolean {
    return this.config.get<string>('LEGAL_REQUIRE_PUBLISHED') === 'true';
  }

  /**
   * `required`: a key present (even with `undefined`) means that document must
   * be accepted; its value is the version the client sent. `age`: given means
   * the declaration is required; `declared` must be exactly `true`.
   * Order of answers: 503 (flag on, nothing published) > 400 missing > 409 stale.
   */
  async assertAccepted(
    db: ConsentDb,
    required: SentVersions,
    age?: { declared: unknown },
  ): Promise<AcceptedConsents> {
    const keys = CONSENT_KEYS.filter((k) => k in required);
    const physical = keys.map((k) => this.slugs[k]);
    const rows = await db.$queryRaw<
      {
        now: Date;
        slug: string | null;
        id: string | null;
        versionNumber: number | null;
      }[]
    >`
      SELECT t."now", d."slug", cur."id", cur."versionNumber"
      FROM (SELECT now() AS "now") t
      LEFT JOIN "Legal_Documents" d ON d."slug" = ANY(${physical}::text[])
      LEFT JOIN LATERAL (
        SELECT v."id", v."versionNumber"
        FROM "Legal_Document_Versions" v
        WHERE v."documentId" = d."id" AND v."effectiveFrom" <= now()
        ORDER BY v."versionNumber" DESC LIMIT 1
      ) cur ON true`;
    const now = rows[0].now;
    const bySlug = new Map<string, AcceptedVersion>();
    for (const r of rows) {
      if (r.slug && r.id && r.versionNumber !== null) {
        bySlug.set(r.slug, { versionId: r.id, versionNumber: r.versionNumber });
      }
    }

    const versions: AcceptedConsents['versions'] = {};
    const unpublished: string[] = [];
    for (const k of keys) {
      const cur = bySlug.get(this.slugs[k]);
      if (cur) versions[k] = cur;
      else unpublished.push(CONSENT_SLUG[k]);
    }
    if (unpublished.length > 0) {
      if (this.requirePublished) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'LEGAL_NOT_PUBLISHED',
          'A required legal document has no published version yet, so this action is not available.',
          { documents: unpublished },
        );
      }
      this.warnUnpublished(unpublished);
    }

    const missing: string[] = [];
    const stale: string[] = [];
    for (const k of keys) {
      const sent = required[k];
      const cur = versions[k];
      if (sent === undefined || sent === null) {
        // An unpublished document is not required, so a missing field is fine.
        if (cur) missing.push(CONSENT_FIELD[k]);
      } else if (!cur || sent !== cur.versionNumber) {
        stale.push(CONSENT_FIELD[k]);
      }
    }
    if (age && age.declared !== true) missing.push('ageDeclared');
    if (missing.length > 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONSENT_REQUIRED',
        'You must accept the current legal documents (and declare your age where asked) to continue.',
        { missing },
      );
    }
    if (stale.length > 0) {
      const current: Record<string, number> = {};
      for (const k of keys) {
        const cur = versions[k];
        if (cur) current[CONSENT_SLUG[k]] = cur.versionNumber;
      }
      throw new ApiException(
        HttpStatus.CONFLICT,
        'CONSENT_VERSION_STALE',
        'The legal documents changed (or the version sent is not in force). Reload them and accept again.',
        { current, stale },
      );
    }
    return { now, versions };
  }

  /** WARN (no PII), at most once a minute per document: the gap must be visible. */
  private warnUnpublished(slugs: string[]): void {
    const t = Date.now();
    const fresh = slugs.filter(
      (s) => t - (this.lastWarn.get(s) ?? 0) >= WARN_EVERY_MS,
    );
    if (fresh.length === 0) return;
    for (const s of fresh) this.lastWarn.set(s, t);
    this.logger.warn(
      `No published version of legal document(s) ${fresh.join(', ')}: acceptance is NOT required or recorded for them (LEGAL_REQUIRE_PUBLISHED=false). Set it to true in production.`,
    );
  }

  /**
   * Inserts the acceptance rows IN THE CALLER'S TRANSACTION, in ONE statement
   * (multi-row `INSERT`). The statement is raw SQL that OMITS `acceptedAt` on
   * purpose: the column's database default (`CURRENT_TIMESTAMP`, the
   * transaction start) applies, so the time is the DB clock and, in checkout,
   * equals `Order.termsAcceptedAt`. (Prisma's own `@default(now())` is filled
   * by the application, which is not what FR-113 asks for.) Only documents
   * with a version in force get a row. With `age` an AGE_DECLARATION row is
   * added, tied to the TERMS version in force, or (documentVersionId NULL,
   * version 0) when TERMS has none: a declaration is not the acceptance of any
   * text. Returns the number of rows written.
   */
  async recordConsents(
    tx: ConsentDb,
    p: RecordConsentsParams,
  ): Promise<number> {
    const rows = consentRows(p);
    if (rows.length === 0) return 0;
    const values = rows.map(
      (r) =>
        Prisma.sql`(gen_random_uuid(), ${r.customerId}::uuid, ${r.orderId}::uuid, ${r.type}::"ConsentType", ${r.documentVersionId}::uuid, ${r.version}, ${r.context}::"ConsentContext")`,
    );
    return tx.$executeRaw`INSERT INTO "Consent_Records"
      ("id", "customerId", "orderId", "type", "documentVersionId", "version", "context")
      VALUES ${Prisma.join(values)}`;
  }

  /** `GET /me/consent-status` (TERMS and PRIVACY only, plus the age declaration). */
  async status(customerId: string): Promise<ConsentStatus> {
    return this.statusIn(this.prisma, customerId);
  }

  private async statusIn(
    db: ConsentDb,
    customerId: string,
  ): Promise<ConsentStatus> {
    const scope: ConsentKey[] = ['terms', 'privacy'];
    const physical = scope.map((k) => this.slugs[k]);
    const logical = new Map(scope.map((k) => [this.slugs[k], CONSENT_SLUG[k]]));
    const docs = await db.$queryRaw<
      {
        slug: string;
        versionNumber: number;
        changeSummary: string;
        lastSubstantialVersion: number | null;
      }[]
    >`
      SELECT d."slug", cur."versionNumber", cur."changeSummary",
             (SELECT max(s."versionNumber") FROM "Legal_Document_Versions" s
               WHERE s."documentId" = d."id" AND s."isSubstantial"
                 AND s."effectiveFrom" <= now()) AS "lastSubstantialVersion"
      FROM "Legal_Documents" d
      JOIN LATERAL (
        SELECT v."versionNumber", v."changeSummary"
        FROM "Legal_Document_Versions" v
        WHERE v."documentId" = d."id" AND v."effectiveFrom" <= now()
        ORDER BY v."versionNumber" DESC LIMIT 1
      ) cur ON true
      WHERE d."slug" = ANY(${physical}::text[])`;
    const last = await db.$queryRaw<{ type: string; v: number }[]>`
      SELECT "type"::text AS "type", max("version") AS "v"
      FROM "Consent_Records"
      WHERE "customerId" = ${customerId}::uuid AND "type" IN ('TERMS', 'PRIVACY')
      GROUP BY "type"`;
    const lastAccepted: Record<string, number | undefined> = {};
    for (const r of last) {
      lastAccepted[
        r.type === 'TERMS' ? CONSENT_SLUG.terms : CONSENT_SLUG.privacy
      ] = r.v;
    }
    const current: CurrentConsentDocument[] = docs.map((d) => ({
      slug: logical.get(d.slug) ?? d.slug,
      versionNumber: d.versionNumber,
      lastSubstantialVersion: d.lastSubstantialVersion,
      changeSummary: d.changeSummary,
    }));
    const pending: PendingConsent[] = computePendingConsents({
      current,
      lastAccepted,
      scope: [CONSENT_SLUG.terms, CONSENT_SLUG.privacy],
    });
    return {
      pending,
      ageDeclarationPending: !(await this.hasAge(db, customerId)),
    };
  }

  private async hasAge(db: ConsentDb, customerId: string): Promise<boolean> {
    const n = await db.consentRecord.count({
      where: { customerId, type: ConsentType.AGE_DECLARATION },
      take: 1,
    });
    return n > 0;
  }

  /**
   * `POST /me/consent`. One transaction, serialized per customer by an
   * advisory lock (a double click cannot write twice) with a bounded wait.
   * Requires (`assertAccepted`) only the documents PENDING for the account;
   * records RE_ACCEPT only for those, so a repeat is a harmless no-op.
   */
  async reaccept(
    customerId: string,
    sent: { terms?: unknown; privacy?: unknown; ageDeclared?: unknown },
  ): Promise<ConsentStatus> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'consent:' + customerId}, 0))`;
        const hasAge = await this.hasAge(tx, customerId);
        const before = await this.statusIn(tx, customerId);
        const pending = new Set(before.pending.map((p) => p.slug));
        // QA 19.7 (story 19.4a #7): only what is PENDING for this account is
        // required; a version for a non-pending document is optional. If it is
        // sent it is still validated (409 when it is not the one in force) but
        // never recorded: this call never writes more than pending AND sent.
        // `null` is the same as omitted (19.4a): the contract says optional.
        const sentVersions: Record<'terms' | 'privacy', unknown> = {
          terms: sent.terms ?? undefined,
          privacy: sent.privacy ?? undefined,
        };
        const required: Partial<Record<ConsentKey, unknown>> = {};
        for (const k of ['terms', 'privacy'] as const) {
          if (pending.has(CONSENT_SLUG[k]) || sentVersions[k] !== undefined) {
            required[k] = sentVersions[k];
          }
        }
        const checked = await this.assertAccepted(
          tx,
          required,
          hasAge ? undefined : { declared: sent.ageDeclared },
        );
        // Story 19.4a D2 (PRD §20): the age declaration is tied to the Terms
        // version in force, read from THIS transaction, even when Terms were not
        // pending / not sent (`checked` only knows the documents that were
        // required). `keys` below still limits the TERMS row to a pending Terms.
        const accepted: AcceptedConsents =
          hasAge || checked.versions.terms
            ? checked
            : await this.withTermsInForce(tx, checked);
        const keys: ConsentKey[] = (['terms', 'privacy'] as const).filter(
          (k) => accepted.versions[k] && pending.has(CONSENT_SLUG[k]),
        );
        await this.recordConsents(tx, {
          context: ConsentContext.RE_ACCEPT,
          customerId,
          accepted,
          keys,
          age: !hasAge,
        });
        return this.statusIn(tx, customerId);
      });
    } catch (e) {
      if (isLockTimeout(e)) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'CONSENT_BUSY',
          'Another consent request for this account is in progress. Try again.',
        );
      }
      throw e;
    }
  }

  /** Adds the Terms version in force (DB clock, caller's transaction) when there is one. */
  private async withTermsInForce(
    db: ConsentDb,
    accepted: AcceptedConsents,
  ): Promise<AcceptedConsents> {
    const rows = await db.$queryRaw<{ id: string; versionNumber: number }[]>`
      SELECT v."id", v."versionNumber"
      FROM "Legal_Documents" d
      JOIN "Legal_Document_Versions" v ON v."documentId" = d."id"
      WHERE d."slug" = ${this.slugs.terms} AND v."effectiveFrom" <= now()
      ORDER BY v."versionNumber" DESC LIMIT 1`;
    if (rows.length === 0) return accepted;
    return {
      ...accepted,
      versions: {
        ...accepted.versions,
        terms: { versionId: rows[0].id, versionNumber: rows[0].versionNumber },
      },
    };
  }

  /** `GET /admin/legal/consents`: newest first, capped; ids and versions only. */
  async listForAdmin(filter: {
    customerId?: string;
    orderId?: string;
  }): Promise<AdminConsentRow[]> {
    const rows = await this.prisma.consentRecord.findMany({
      where: {
        ...(filter.customerId ? { customerId: filter.customerId } : {}),
        ...(filter.orderId ? { orderId: filter.orderId } : {}),
      },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'asc' }],
      take: ADMIN_CONSENTS_LIMIT,
    });
    return rows.map((r) => ({
      id: r.id,
      type: r.type,
      version: r.version,
      documentVersionId: r.documentVersionId,
      context: r.context,
      acceptedAt: r.acceptedAt.toISOString(),
      customerId: r.customerId,
      orderId: r.orderId,
    }));
  }
}

export interface RecordConsentsParams {
  context: ConsentContext;
  customerId?: string | null;
  orderId?: string | null;
  accepted: AcceptedConsents;
  keys: readonly ConsentKey[];
  age?: boolean;
}

export interface ConsentRow {
  customerId: string | null;
  orderId: string | null;
  type: ConsentType;
  documentVersionId: string | null;
  version: number;
  context: ConsentContext;
}

/** The rows `recordConsents` writes: ids, type, version, context. Nothing else. */
export function consentRows(p: RecordConsentsParams): ConsentRow[] {
  const base = {
    context: p.context,
    customerId: p.customerId ?? null,
    orderId: p.orderId ?? null,
  };
  const rows: ConsentRow[] = [];
  for (const k of p.keys) {
    const v = p.accepted.versions[k];
    if (!v) continue;
    rows.push({
      ...base,
      type: TYPE_OF[k],
      documentVersionId: v.versionId,
      version: v.versionNumber,
    });
  }
  if (p.age) {
    const terms = p.accepted.versions.terms;
    rows.push({
      ...base,
      type: ConsentType.AGE_DECLARATION,
      documentVersionId: terms?.versionId ?? null,
      version: terms?.versionNumber ?? 0,
    });
  }
  return rows;
}

export const ADMIN_CONSENTS_LIMIT = 200;

export interface ConsentStatus {
  pending: PendingConsent[];
  ageDeclarationPending: boolean;
}

export interface AdminConsentRow {
  id: string;
  type: ConsentType;
  version: number;
  documentVersionId: string | null;
  context: ConsentContext;
  acceptedAt: string;
  customerId: string | null;
  orderId: string | null;
}

/** Postgres 55P03 (lock_not_available), as Prisma surfaces it from raw SQL. */
function isLockTimeout(e: unknown): boolean {
  const text = e instanceof Error ? `${e.message}` : '';
  const meta = (e as { meta?: { code?: string } } | null)?.meta;
  return meta?.code === '55P03' || /55P03|lock timeout/i.test(text);
}
