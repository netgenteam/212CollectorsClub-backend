import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { IdDocCryptoService } from './../src/crypto/id-doc-crypto.service.js';
import { redactDeep, redactString } from './../src/common/redact.js';

/**
 * Story 20.2, perf (pnpm test:perf, quiet machine): (1) the log redactor runs
 * on every log line, so it must cost microseconds; (2) a batch of 20.000
 * cedulas (a Story 20.3 backfill chunk) must not freeze the event loop.
 * Monotonic clock only. Figures are printed (console.info) for the report.
 */
const nowMs = (): number => Number(process.hrtime.bigint()) / 1e6;

function service(): IdDocCryptoService {
  const b = (): string => randomBytes(32).toString('base64');
  const env: Record<string, string> = {
    IDDOC_ENC_KEYS: `1:${b()}`,
    IDDOC_ENC_ACTIVE_KEY: '1',
    IDDOC_BLIND_KEY: b(),
  };
  const s = new IdDocCryptoService({ get: (k: string) => env[k] } as never);
  s.onModuleInit();
  return s;
}

describe('redaction cost on every log line', () => {
  const plain =
    '[Nest] 1986103  - 11/03/2026, 8:09:33 PM     LOG [OrdersService] order e1234567-89ab-4cde-8f01-23456789abcd moved to PAID total 1.234,50 USD at 2026-11-03T20:09:33.123Z';
  const withId = `${plain} cliente V-98.765.432`;
  const obj = {
    orderId: 'e1234567-89ab-4cde-8f01-23456789abcd',
    status: 'PAID',
    total: '1234.50',
    lines: Array.from({ length: 5 }, (_, i) => ({
      sku: `SKU-${i}`,
      qty: i + 1,
    })),
    recipientIdDoc: 'V-98765432',
  };

  it('stays under budget per line (string, string with a cedula, object)', () => {
    const N = 100_000;
    for (let i = 0; i < 5_000; i++) redactString(plain); // warm-up
    const time = (fn: () => unknown): number => {
      const t0 = nowMs();
      for (let i = 0; i < N; i++) fn();
      return ((nowMs() - t0) / N) * 1000; // microseconds per call
    };
    const a = time(() => redactString(plain));
    const b = time(() => redactString(withId));
    const c = time(() => redactDeep(obj));
    console.info(
      `redact per call: plain line (7-digit pid, worst case for the gate) ${a.toFixed(2)} us, line with cedula ${b.toFixed(2)} us, object(9 fields) ${c.toFixed(2)} us`,
    );
    expect(a).toBeLessThan(25);
    expect(b).toBeLessThan(50);
    expect(c).toBeLessThan(100);
  });
});

describe('batch of cedulas does not block the event loop', () => {
  it('protectMany(20.000) yields: max event-loop delay stays small', async () => {
    const svc = service();
    const raws = Array.from(
      { length: 20_000 },
      (_, i) => `V-${10_000_000 + i}`,
    );
    const h = monitorEventLoopDelay({ resolution: 1 });
    h.enable();
    const t0 = nowMs();
    const out = await svc.protectMany(raws, { yieldEvery: 200 });
    const total = nowMs() - t0;
    h.disable();
    const maxMs = h.max / 1e6;
    console.info(
      `protectMany 20000: ${total.toFixed(0)} ms total (${((total / 20_000) * 1000).toFixed(1)} us per value), max event-loop delay ${maxMs.toFixed(1)} ms`,
    );
    expect(out).toHaveLength(20_000);
    expect(maxMs).toBeLessThan(100);
    expect(total).toBeLessThan(10_000);
  });
});
