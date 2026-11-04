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

export function scramVerifier(
  password,
  { salt = randomBytes(16), iterations = 4096 } = {},
) {
  const pw = Buffer.from(String(password).normalize('NFKC'), 'utf8');
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
