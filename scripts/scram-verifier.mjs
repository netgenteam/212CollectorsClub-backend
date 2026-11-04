// SCRAM-SHA-256 verifier of a password, in the format Postgres stores and accepts
// in `CREATE ROLE ... PASSWORD 'SCRAM-SHA-256$...'` (Story 20.1, QA round 2).
//
// Why: when `pnpm db:roles` fails, Postgres writes the failing statement into its
// log (`CONTEXT:  SQL statement "CREATE ROLE ... PASSWORD '...'"`). With the
// clear-text password that log line is a credential leak; with a verifier it is
// not a password (it cannot be used to log in, only to attack offline).
//
//   printf '%s' "$APP_DB_PASSWORD" | node scripts/scram-verifier.mjs     # prints the verifier
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

export const SCRAM_PREFIX = 'SCRAM-SHA-256$';

// Postgres (and libpq) run the password through SASLprep (RFC 4013) before SCRAM:
//   1. map to nothing (RFC 3454 B.1: U+00AD, U+034F, U+1806, U+180B-180D, U+200B-200D,
//      U+2060, U+FE00-FE0F, U+FEFF) and non-ASCII spaces (C.1.2) to U+0020,
//   2. NFKC,
//   3. if the result has a prohibited (C.2-C.9, e.g. U+0340) or unassigned (Unicode 3.2)
//      character or breaks the bidi rules, Postgres silently falls back to the RAW password.
// Reproducing steps 1-3 exactly needs the RFC 3454 tables for the Unicode 3.2 repertoire,
// and a client that does not normalize (node-pg, many drivers) would derive the raw bytes
// anyway and fail to log in. So the script accepts only a password SASLprep leaves
// UNCHANGED (every ASCII password, and any text that is already NFKC and has no mapped
// character): for those the verifier is the same whatever Postgres decides in step 3, and
// every client derives the same key. Anything else is refused with a clear message instead
// of producing a verifier that differs from Postgres's. Checked against a real Postgres 17
// for every BMP code point (scripts documented in docs/deployment.md 13.1c).
const MAP_TO_NOTHING = /[\u00AD\u034F\u1806\u180B-\u180D\u200B-\u200D\u2060\uFE00-\uFE0F\uFEFF]/u;
const NON_ASCII_SPACE = /[\u00A0\u1680\u2000-\u200B\u202F\u205F\u3000]/u;

const hex = (ch) => `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

/** Throws an Error (never containing the password) when SASLprep would change it. */
export function assertSaslprepStable(password) {
  const pw = String(password);
  if (/^[\x00-\x7F]*$/.test(pw)) return pw;
  const bad = new Set();
  for (const ch of pw) {
    if (MAP_TO_NOTHING.test(ch) || NON_ASCII_SPACE.test(ch)) bad.add(hex(ch));
    else if (ch === '\uFFFD') bad.add(hex(ch));
    else if (ch.normalize('NFKC') !== ch) bad.add(hex(ch));
  }
  if (bad.size === 0 && pw.normalize('NFKC') !== pw) {
    bad.add('a combining sequence that NFKC composes');
  }
  if (bad.size > 0) {
    throw new Error(
      `The password has characters that PostgreSQL's SASLprep changes or drops (${[...bad].slice(0, 8).join(', ')}). ` +
        'The verifier would not match what PostgreSQL computes and the login would fail. ' +
        'Choose a password of plain ASCII characters, or text already in NFKC form without invisible or compatibility characters.',
    );
  }
  return pw;
}

export function scramVerifier(
  password,
  { salt = randomBytes(16), iterations = 4096 } = {},
) {
  const pw = Buffer.from(assertSaslprepStable(password), 'utf8');
  const salted = pbkdf2Sync(pw, salt, iterations, 32, 'sha256');
  const hmac = (key, msg) => createHmac('sha256', key).update(msg).digest();
  const clientKey = hmac(salted, 'Client Key');
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `${SCRAM_PREFIX}${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  if (!input) {
    console.error(
      'Pass the password on stdin: printf "%s" "$PW" | node scripts/scram-verifier.mjs',
    );
    process.exit(2);
  }
  console.log(scramVerifier(input));
}
