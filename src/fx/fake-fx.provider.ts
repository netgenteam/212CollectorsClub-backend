import { Injectable } from '@nestjs/common';
import type {
  FxProvider,
  FxProviderResult,
  FxProviderSource,
} from './fx-provider.js';

export const FAKE_FX_DEFAULT_RATE = 889.26;
export const FAKE_FX_DEFAULT_DATE = new Date('2026-11-01T12:00:00.000Z');

/**
 * Story 18.1 (AD-79): deterministic provider for tests / `FX_PROVIDER=fake`.
 * Never touches the network. Tests drive it with the scenario helpers; the
 * default is a valid fixed reading.
 */
@Injectable()
export class FakeFxProvider implements FxProvider {
  readonly name = 'fake';
  calls: FxProviderSource[] = [];
  private result: FxProviderResult = this.ok();

  private ok(rate = FAKE_FX_DEFAULT_RATE, at = FAKE_FX_DEFAULT_DATE) {
    return { ok: true, reading: { rate, providerUpdatedAt: at } } as const;
  }

  fetchRate(source: FxProviderSource): Promise<FxProviderResult> {
    this.calls.push(source);
    return Promise.resolve(this.result);
  }

  reset(): this {
    this.calls = [];
    this.result = this.ok();
    return this;
  }

  /** Valid reading. */
  succeed(rate = FAKE_FX_DEFAULT_RATE, at = FAKE_FX_DEFAULT_DATE): this {
    this.result = this.ok(rate, at);
    return this;
  }
  /** Provider down / timeout. */
  fail(error = 'provider unavailable'): this {
    this.result = { ok: false, error };
    return this;
  }
  /** Unexpected response shape (provider error, not an exception). */
  unexpectedShape(): this {
    this.result = { ok: false, error: 'unexpected shape' };
    return this;
  }
  nan(at = FAKE_FX_DEFAULT_DATE): this {
    return this.succeed(Number.NaN, at);
  }
  zero(at = FAKE_FX_DEFAULT_DATE): this {
    return this.succeed(0, at);
  }
  /** `base` raised by `pct` percent. */
  variation(base: number, pct: number, at = FAKE_FX_DEFAULT_DATE): this {
    return this.succeed(Number((base * (1 + pct / 100)).toFixed(4)), at);
  }
}
