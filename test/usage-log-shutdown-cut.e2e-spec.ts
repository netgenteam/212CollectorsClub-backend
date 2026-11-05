import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { adminDatabaseUrl } from './helpers/audit-sandbox.js';

/**
 * Story 20.7, fourth round (QA): a client cut DURING the shutdown left no row in `Usage_Logs`. The REAL
 * server (`node dist/main.js`, not an in-process app: the order of Nest's close hooks and of `server.close()`
 * is what is under test) with `Contact_Inquiries` locked, a raw-socket `POST /contact`, `SIGTERM` at 300 ms and
 * the client cut afterwards. `server.close()` calls back when the last socket is destroyed, BEFORE that socket
 * emits `close`: the 499 was pushed to the buffer 3 ms after its final flush had found 0 rows and was lost.
 * The handler also keeps running after the cut and its NEXT query (the `emailStatus` update after the e-mail
 * attempt) must still find the pool open. Throw-away clone, every row created is deleted.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });
}

describe('Usage log: a client cut during the shutdown (real process, Story 20.7 round 4)', () => {
  let owner: pg.Client;
  const uas: string[] = [];

  beforeAll(async () => {
    // always rebuilt (incremental): a stale `dist` would test the previous code
    execFileSync('pnpm', ['exec', 'nest', 'build'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    const u = new URL(adminDatabaseUrl());
    u.searchParams.delete('schema');
    owner = new pg.Client({ connectionString: u.toString() });
    await owner.connect();
  }, 240_000);

  afterAll(async () => {
    for (const ua of uas) {
      await owner.query(`DELETE FROM "Usage_Logs" WHERE "userAgent" = $1`, [
        ua,
      ]);
      await owner.query(`DELETE FROM "Contact_Inquiries" WHERE "email" = $1`, [
        `${ua}@example.com`,
      ]);
    }
    await owner.end();
  });

  interface Outcome {
    exitCode: number | null;
    exitSignal: NodeJS.Signals | null;
    exitMs: number;
    usage: { route: string; status: number }[];
    emailStatus: string | null;
    log: string;
  }

  /** `holdMs`: how long the table stays locked; `cutAt`: when the client destroys its socket (null: never). */
  async function run(opts: {
    holdMs: number;
    cutAt: number | null;
  }): Promise<Outcome> {
    const ua = `qa207d-${randomUUID().slice(0, 8)}`;
    uas.push(ua);
    const email = `${ua}@example.com`;
    const port = await freePort();
    const child: ChildProcess = spawn('node', ['dist/main.js'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        USAGE_LOG_FLUSH_MS: '60000',
        FX_REFRESH_ENABLED: 'false',
        // the e-mail attempt fails at once: the update after it is the handler's second query
        SMTP_HOST: '127.0.0.1',
        SMTP_PORT: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    child.stdout?.on('data', (d: Buffer) => (log += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (log += d.toString()));
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((r) => child.on('exit', (code, signal) => r({ code, signal })));
    try {
      for (let i = 0; ; i++) {
        try {
          await new Promise<void>((res, rej) => {
            const s = net.connect(port, '127.0.0.1', () => {
              s.destroy();
              res();
            });
            s.on('error', rej);
          });
          break;
        } catch {
          if (i > 150) throw new Error(`server did not start:\n${log}`);
          await sleep(200);
        }
      }
      await sleep(300);
      await owner.query('BEGIN');
      await owner.query(
        'LOCK TABLE "Contact_Inquiries" IN ACCESS EXCLUSIVE MODE',
      );
      const body = JSON.stringify({
        name: 'Cut',
        email,
        message: 'cut client',
      });
      const sock = net.connect(port, '127.0.0.1', () =>
        sock.write(
          `POST /api/v1/contact HTTP/1.1\r\nHost: x\r\nUser-Agent: ${ua}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        ),
      );
      sock.on('error', () => undefined);
      const t0 = Date.now();
      setTimeout(() => child.kill('SIGTERM'), 300);
      if (opts.cutAt !== null) setTimeout(() => sock.destroy(), opts.cutAt);
      setTimeout(
        () => void owner.query('COMMIT').catch(() => undefined),
        opts.holdMs,
      );
      const ex = await Promise.race([
        exited,
        sleep(40_000).then(() => {
          child.kill('SIGKILL');
          throw new Error(`the process did not exit:\n${log}`);
        }),
      ]);
      const exitMs = Date.now() - t0;
      sock.destroy();
      const usage = (
        await owner.query<{ route: string; status: number }>(
          `SELECT "route", "status" FROM "Usage_Logs" WHERE "userAgent" = $1`,
          [ua],
        )
      ).rows;
      const inq = await owner.query<{ emailStatus: string }>(
        `SELECT "emailStatus" FROM "Contact_Inquiries" WHERE "email" = $1`,
        [email],
      );
      return {
        exitCode: ex.code,
        exitSignal: ex.signal,
        exitMs,
        usage,
        emailStatus: inq.rows[0]?.emailStatus ?? null,
        log,
      };
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }

  it('the client is the last socket and is cut at 1 s: the 499 row is written and the handler finishes its update', async () => {
    const r = await run({ holdMs: 2_500, cutAt: 1_000 });
    expect(r.usage).toEqual([{ route: '/api/v1/contact', status: 499 }]);
    expect(r.emailStatus).toBe('FAILED'); // the second query of the handler found the pool open
    expect(r.log).not.toMatch(/pool|shutdown flush incomplete/i);
    expect(r.exitMs).toBeLessThan(8_000);
  }, 60_000);

  it('the 5 s grace cuts the connection (closeAllConnections) while the handler runs on: row and update both land', async () => {
    const r = await run({ holdMs: 6_000, cutAt: null });
    expect(r.log).toMatch(/still closing 5000 ms after SIGTERM/);
    expect(r.usage).toEqual([{ route: '/api/v1/contact', status: 499 }]);
    expect(r.emailStatus).toBe('FAILED');
    expect(r.log).not.toMatch(/pool|shutdown flush incomplete/i);
  }, 60_000);
});
