import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import type { FxRateSource } from '../generated/prisma/client.js';
import { SINGLETON_FX_RATE_ID } from '../checkout/fx-rate.constants.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { FxCurrentResponseDto } from './dto/fx-current.dto.js';

const HOUR_MS = 3600 * 1000;

interface RateRow {
  vesPerUsd: Prisma.Decimal;
  source: FxRateSource;
  maxAgeHours: number;
  updatedAt: Date;
  rateFetchedAt: Date | null;
  providerUpdatedAt: Date | null;
}

/** Minimal tx surface: a single SELECT of the singleton row. */
export interface FxRateTx {
  fxRateSetting: {
    findUnique(args: { where: { id: string } }): Promise<RateRow | null>;
  };
}

/**
 * Story 18.3 (AD-80). Reads the current rate with source/rate coherence (one
 * SELECT) and the A54 staleness policy. NEVER touches the network.
 */
@Injectable()
export class FxRateService {
  constructor(private readonly prisma: PrismaService) {}

  /** Checkout path: one SELECT inside the caller's transaction. */
  async getForCheckout(
    tx: FxRateTx,
  ): Promise<{ vesPerUsd: Prisma.Decimal; source: FxRateSource }> {
    const row = await tx.fxRateSetting.findUnique({
      where: { id: SINGLETON_FX_RATE_ID },
    });
    this.evaluate(row);
    return { vesPerUsd: row!.vesPerUsd, source: row!.source };
  }

  /** Public `GET /fx/current`. */
  async getCurrent(): Promise<FxCurrentResponseDto> {
    const row = await this.prisma.fxRateSetting.findUnique({
      where: { id: SINGLETON_FX_RATE_ID },
    });
    const { stale } = this.evaluate(row);
    const r = row!;
    return {
      vesPerUsd: r.vesPerUsd.toFixed(4),
      source: r.source,
      updatedAt: (
        r.providerUpdatedAt ??
        r.rateFetchedAt ??
        r.updatedAt
      ).toISOString(),
      stale,
    };
  }

  /** Throws 503 FX_RATE_UNAVAILABLE when unusable; else reports `stale`. */
  private evaluate(row: RateRow | null): { stale: boolean } {
    if (!row || !row.vesPerUsd.gt(0)) this.unavailable();
    if (row.source === 'MANUAL') return { stale: false };
    const fetched = row.rateFetchedAt ?? row.updatedAt;
    const age = Date.now() - fetched.getTime();
    const limit = row.maxAgeHours * HOUR_MS;
    if (age > limit * 3) this.unavailable();
    return { stale: age > limit };
  }

  private unavailable(): never {
    throw new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'FX_RATE_UNAVAILABLE',
      'The VES exchange rate is currently unavailable. Please try again later.',
    );
  }
}
