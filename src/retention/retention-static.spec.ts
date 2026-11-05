import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Story 20.8 AC3, the static half: the SQL of the retention job can only ever name the tables the PRD
 * (FR-131) lets it purge. The e2e (`test/retention.e2e-spec.ts`) proves the same from the other side:
 * hashes of the protected tables before and after a run, and the foreign-key / trigger closure read from
 * the real catalog. A new task that deletes from `Orders`, `Proof_Of_Payments`, `Consent_Records`,
 * `Audit_Events` (or anything else not listed) fails here at the line that names it.
 */
const SRC = join(__dirname, '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) return files(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

/** Source without comments (a comment may — and does — talk about the protected tables). */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

const RETENTION_FILES = files(join(SRC, 'retention'));

/** Tables a purge may DELETE from (FR-131). */
const DELETE_ALLOWED = new Set([
  'Customer_Sessions',
  'Admin_Sessions',
  'Revoked_Tokens',
  'Customer_Verifications',
  'Contact_Inquiries',
  'Carts',
  'Wishlists',
  'Retention_Runs',
  'Usage_Logs',
  'Product_Daily_Stats',
]);
/** Tables a purge may UPDATE: the PII of sessions, and the job's own rows. */
const UPDATE_ALLOWED = new Set([
  'Customer_Sessions',
  'Admin_Sessions',
  'Retention_Runs',
]);
/** Tables a purge may read to decide (sub-selects) or INSERT into. */
const READ_ALLOWED = new Set([...DELETE_ALLOWED, 'Customers']);

const PROTECTED = [
  'Orders',
  'Order_Lines',
  'Order_Status_History',
  'Order_Tracking_Events',
  'Stock_Holds',
  'Proof_Of_Payments',
  'Consent_Records',
  'Audit_Events',
  'Audit_Verifications',
  'Stripe_Webhook_Events',
  'Customers',
  'Customer_Addresses',
  'Customer_Accounts',
  'Admin_Users',
  'Admin_Accounts',
  'Products',
  'Legal_Documents',
  'Legal_Document_Versions',
  'Legal_Drafts',
  'Legal_Audit_Logs',
  'Seller_Identity_Settings',
];

const refs = (src: string, re: RegExp): string[] =>
  [...src.matchAll(re)].map((m) => m[1]);

/** The part of a file between two markers, comments removed. */
function between(file: string, from: string, to: string): string {
  const s = code(file);
  const i = s.indexOf(from);
  const j = s.indexOf(to, i);
  expect(i).toBeGreaterThanOrEqual(0);
  return s.slice(i, j < 0 ? undefined : j);
}

const SOURCES: [string, string][] = [
  ...RETENTION_FILES.map((f): [string, string] => [
    f.slice(SRC.length + 1),
    code(f),
  ]),
  [
    'usage/usage-purge.service.ts',
    code(join(SRC, 'usage/usage-purge.service.ts')),
  ],
  [
    'vitrina/product-signals.service.ts#purgeOldStatsBounded',
    between(
      join(SRC, 'vitrina/product-signals.service.ts'),
      'async purgeOldStatsBounded',
      "@Cron('30 3",
    ),
  ],
];

describe('the retention job only names the tables it may purge (Story 20.8 AC3, static)', () => {
  it('finds the task files (the scan is not vacuous)', () => {
    expect(RETENTION_FILES.length).toBeGreaterThanOrEqual(12);
    expect(SOURCES.length).toBeGreaterThanOrEqual(15);
  });

  it.each(SOURCES)(
    '%s: DELETE / UPDATE / INSERT / FROM targets are on the allow-lists',
    (name, src) => {
      for (const t of refs(src, /DELETE\s+FROM\s+"([A-Za-z_]+)"/g)) {
        expect(DELETE_ALLOWED.has(t), `${name}: DELETE FROM "${t}"`).toBe(true);
      }
      for (const t of refs(src, /\bUPDATE\s+"([A-Za-z_]+)"/g)) {
        expect(UPDATE_ALLOWED.has(t), `${name}: UPDATE "${t}"`).toBe(true);
      }
      expect(
        refs(src, /INSERT\s+INTO\s+"([A-Za-z_]+)"/g),
        `${name}: INSERT`,
      ).toEqual([]);
      for (const t of refs(src, /\b(?:FROM|JOIN|USING)\s+"([A-Za-z_]+)"/g)) {
        expect(READ_ALLOWED.has(t), `${name}: reads "${t}"`).toBe(true);
      }
    },
  );

  it.each(SOURCES)(
    '%s: no protected table is named anywhere, in SQL or as a Prisma model',
    (name, src) => {
      for (const t of PROTECTED) {
        // `Customers` is only ever READ allowed; the others not at all. Quoted names and bare model names.
        expect(src, `${name} mentions "${t}"`).not.toMatch(
          new RegExp(`"${t}"`),
        );
      }
      for (const accessor of [
        'order',
        'orderLine',
        'orderStatusHistory',
        'orderTrackingEvent',
        'stockHold',
        'proofOfPayment',
        'consentRecord',
        'auditEvent',
        'auditVerification',
        'stripeWebhookEvent',
        'customer',
        'customerAddress',
        'customerAccount',
        'adminUser',
        'product',
        'legalDocument',
        'legalDocumentVersion',
        'legalDraft',
        'legalAuditLog',
      ]) {
        expect(src, `${name} uses prisma.${accessor}`).not.toMatch(
          new RegExp(`(?:prisma|tx|this\\.prisma)\\.${accessor}\\b`),
        );
      }
    },
  );

  it.each(SOURCES)(
    '%s: nothing that widens a statement beyond its WHERE',
    (name, src) => {
      expect(src, name).not.toMatch(/\bTRUNCATE\b/i);
      expect(src, name).not.toMatch(/\bDROP\s+(TABLE|INDEX|TRIGGER|SCHEMA)/i);
      expect(src, name).not.toMatch(/\bALTER\s+(TABLE|ROLE|SYSTEM)/i);
      expect(src, name).not.toMatch(
        /DISABLE\s+TRIGGER|session_replication_role|ENABLE\s+(ALWAYS|REPLICA)/i,
      );
      expect(src, name).not.toMatch(/\bCASCADE\b/);
      expect(src, name).not.toMatch(/\$(?:queryRawUnsafe|executeRawUnsafe)/);
      // every DELETE and UPDATE statement has its WHERE
      const statements = (
        src.match(/(?:DELETE\s+FROM|\bUPDATE)\s+"[A-Za-z_]+"/g) ?? []
      ).length;
      const wheres = (src.match(/\bWHERE\b/g) ?? []).length;
      expect(
        wheres,
        `${name}: ${statements} statements, ${wheres} WHERE`,
      ).toBeGreaterThanOrEqual(statements);
      // no row-by-row ORM writes with a model: only raw, bounded statements (the one `create` is the run row)
      expect(src, name).not.toMatch(
        /(?:prisma|tx)\.\w+\.(deleteMany|updateMany|delete|update|upsert|createMany)\(/,
      );
    },
  );

  it('the service writes only its own table, through the ORM: one create of a Retention_Runs row', () => {
    const svc = code(join(SRC, 'retention/retention.service.ts'));
    expect(refs(svc, /this\.prisma\.(\w+)\./g)).toEqual(['retentionRun']);
    expect(svc.match(/retentionRun\.create\(/g)).toHaveLength(1);
  });
});
