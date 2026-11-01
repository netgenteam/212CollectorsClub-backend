import type { FxRateSource } from '../generated/prisma/client.js';

/** Injection token for the active {@link FxProvider} (AD-79). */
export const FX_PROVIDER = 'FX_PROVIDER';

/** Sources a provider can be asked for (MANUAL never hits the network). */
export type FxProviderSource = Exclude<FxRateSource, 'MANUAL'>;

export interface FxReading {
  /** Raw value from the provider; NOT yet validated (may be NaN, 0, ...). */
  rate: number;
  providerUpdatedAt: Date;
}

/** Provider outcome: never throws toward the caller (cron resilience). */
export type FxProviderResult =
  { ok: true; reading: FxReading } | { ok: false; error: string };

export interface FxProvider {
  readonly name: string;
  fetchRate(source: FxProviderSource): Promise<FxProviderResult>;
}
