import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

/** Story 15.9 (AC8/AC10): the script runs against a mocked `fetch`, no network. */
describe('scripts/ingest-master-cards.mjs (Story 15.9)', () => {
  const run = (args: string[], extra: Record<string, string> = {}) => {
    const res = spawnSync(
      process.execPath,
      [
        '--import',
        join(import.meta.dirname, 'fixtures/mock-fetch-ingest.mjs'),
        join(ROOT, 'scripts/ingest-master-cards.mjs'),
        ...args,
      ],
      {
        env: {
          PATH: process.env.PATH ?? '',
          API_BASE_URL: 'http://api.test/api/v1',
          ADMIN_USER: 'x',
          ADMIN_PASSWORD: 'x',
          INGEST_POLL_SECONDS: '1',
          // A key in the caller's env must never be forwarded.
          TCGAPI_KEY: 'must-not-leak',
          ...extra,
        },
        encoding: 'utf8',
      },
    );
    return { code: res.status, out: res.stdout, err: res.stderr };
  };

  it('flags -> body; polls until done; prints summary and stats; exit 0', () => {
    const r = run([
      '--games',
      'pokemon,magic',
      '--sets=sv3pt5',
      '--max-requests',
      '40',
      '--set-limit',
      '2',
      '--refresh-sets',
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain(
      'POST http://api.test/api/v1/admin/tcg-master-cards/ingest {"games":["pokemon","magic"],"sets":["sv3pt5"],"maxRequests":40,"setLimit":2,"refreshSets":true}',
    );
    expect(r.out).toContain('Status: SUCCEEDED');
    expect(r.out).toContain('Master cards cargadas: 7');
    expect(r.err).not.toContain('must-not-leak');
    expect(r.err).not.toContain('tcgapi.dev');
  });

  it('INGEST_* envs feed the body; no flags -> empty body', () => {
    expect(
      run([], { INGEST_GAMES: 'yugioh', INGEST_MAX_REQUESTS: '9' }).err,
    ).toContain('{"games":["yugioh"],"maxRequests":9}');
    expect(run([]).err).toMatch(/ingest \{\}\n/);
  });

  it('PARTIAL -> exit 0; FAILED -> exit 1', () => {
    const partial = run([], { MOCK_SCENARIO: 'partial' });
    expect(partial.code).toBe(0);
    expect(partial.out).toContain('vuelve a ejecutar');
    const failed = run([], { MOCK_SCENARIO: 'failed' });
    expect(failed.code).toBe(1);
    expect(failed.err).toContain('boom');
  });

  it('503 and 409 -> exit 1 with a clear message', () => {
    const nc = run([], { MOCK_SCENARIO: 'not-configured' });
    expect(nc.code).toBe(1);
    expect(nc.err).toContain('TCG_API_NOT_CONFIGURED');
    const busy = run([], { MOCK_SCENARIO: 'running' });
    expect(busy.code).toBe(1);
    expect(busy.err).toContain('r0');
  });

  it('--status only reads stats (no ingest call)', () => {
    const r = run(['--status']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Master cards cargadas: 7');
    expect(r.err).not.toContain('/ingest');
  });

  it('invalid flag values exit 1', () => {
    expect(run(['--max-requests', '0']).code).toBe(1);
    expect(run(['--nope']).code).toBe(1);
  });
});
