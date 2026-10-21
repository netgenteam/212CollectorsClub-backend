import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TcgCardDto } from './tcg-api-client.interface.js';
import {
  editionLanguageForGame,
  franchiseForGame,
  normalizeSearchText,
} from './tcg-mappings.js';

export interface UpsertPageContext {
  /** `TcgApiClient.provider` (`TCGAPI_DEV` or `FAKE`). */
  provider: string;
  gameSlug: string;
  setName: string;
}

export interface UpsertPageResult {
  created: number;
  updated: number;
  /** Sealed products (and any non-`Cards` item). */
  skipped: number;
}

/**
 * Story 15.4 (AD-55, R6): persists one page of cards with a SINGLE
 * `INSERT ... SELECT FROM jsonb_to_recordset ... ON CONFLICT DO UPDATE`.
 * A null price never overwrites a previous one (COALESCE). Reused by the
 * nightly sync (15.7).
 */
@Injectable()
export class MasterCardUpsertService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertPage(
    cards: TcgCardDto[],
    ctx: UpsertPageContext,
  ): Promise<UpsertPageResult> {
    const byId = new Map<string, TcgCardDto>();
    let skipped = 0;
    for (const card of cards) {
      if (card.skip) {
        skipped += 1;
      } else {
        byId.set(card.externalId, card); // dedupe: ON CONFLICT cannot hit a row twice
      }
    }
    if (byId.size === 0) return { created: 0, updated: 0, skipped };

    const franchise = franchiseForGame(ctx.gameSlug);
    const editionLanguage = editionLanguageForGame(ctx.gameSlug);
    const rows = [...byId.values()].map((c) => {
      const setName = c.setName ?? ctx.setName;
      return {
        externalId: c.externalId,
        name: c.name,
        cleanName: c.cleanName,
        searchText: normalizeSearchText(
          [c.cleanName, setName, c.number ?? ''].join(' '),
        ),
        setId: c.setId,
        setName,
        cardNumber: c.number,
        rarity: c.rarity,
        printing: c.printing,
        tcgplayerId: c.tcgplayerId,
        imageSmall: c.imageUrl,
        imageLarge: c.imageUrl,
        marketPriceUsd: c.marketPriceUsd,
        lowPriceUsd: c.lowPriceUsd,
        medianPriceUsd: c.medianPriceUsd,
        priceAsOf: c.priceAsOf,
        rawApiData: c.rawApiData,
      };
    });

    const result = await this.prisma.$queryRaw<{ inserted: boolean }[]>`
      INSERT INTO "Master_Cards" (
        "id", "externalProvider", "externalId", "name", "cleanName",
        "searchText", "franchise", "gameSlug", "setId", "setName",
        "cardNumber", "rarity", "editionLanguage", "printing", "tcgplayerId",
        "imageSmall", "imageLarge", "marketPriceUsd", "lowPriceUsd",
        "medianPriceUsd", "priceAsOf", "rawApiData", "lastSyncedAt",
        "createdAt", "updatedAt"
      )
      SELECT
        gen_random_uuid(), ${ctx.provider}, r."externalId", r."name",
        r."cleanName", r."searchText", ${franchise}::"Franchise",
        ${ctx.gameSlug}, r."setId", r."setName", r."cardNumber", r."rarity",
        ${editionLanguage}::"ProductLanguage", r."printing", r."tcgplayerId",
        r."imageSmall", r."imageLarge", r."marketPriceUsd", r."lowPriceUsd",
        r."medianPriceUsd", r."priceAsOf", r."rawApiData", now(), now(), now()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS r(
        "externalId" text, "name" text, "cleanName" text, "searchText" text,
        "setId" text, "setName" text, "cardNumber" text, "rarity" text,
        "printing" text, "tcgplayerId" int, "imageSmall" text,
        "imageLarge" text, "marketPriceUsd" numeric(10,2),
        "lowPriceUsd" numeric(10,2), "medianPriceUsd" numeric(10,2),
        "priceAsOf" date, "rawApiData" jsonb
      )
      ON CONFLICT ("externalProvider", "externalId") DO UPDATE SET
        "name" = EXCLUDED."name",
        "cleanName" = EXCLUDED."cleanName",
        "searchText" = EXCLUDED."searchText",
        "franchise" = EXCLUDED."franchise",
        "gameSlug" = EXCLUDED."gameSlug",
        "setId" = EXCLUDED."setId",
        "setName" = EXCLUDED."setName",
        "cardNumber" = EXCLUDED."cardNumber",
        "rarity" = EXCLUDED."rarity",
        "editionLanguage" = EXCLUDED."editionLanguage",
        "printing" = EXCLUDED."printing",
        "tcgplayerId" = COALESCE(EXCLUDED."tcgplayerId", "Master_Cards"."tcgplayerId"),
        "imageSmall" = COALESCE(EXCLUDED."imageSmall", "Master_Cards"."imageSmall"),
        "imageLarge" = COALESCE(EXCLUDED."imageLarge", "Master_Cards"."imageLarge"),
        "marketPriceUsd" = COALESCE(EXCLUDED."marketPriceUsd", "Master_Cards"."marketPriceUsd"),
        "lowPriceUsd" = COALESCE(EXCLUDED."lowPriceUsd", "Master_Cards"."lowPriceUsd"),
        "medianPriceUsd" = COALESCE(EXCLUDED."medianPriceUsd", "Master_Cards"."medianPriceUsd"),
        "priceAsOf" = COALESCE(EXCLUDED."priceAsOf", "Master_Cards"."priceAsOf"),
        "rawApiData" = EXCLUDED."rawApiData",
        "lastSyncedAt" = now(),
        "updatedAt" = now()
      RETURNING (xmax = 0) AS inserted
    `;
    const created = result.filter((r) => r.inserted).length;
    return { created, updated: result.length - created, skipped };
  }
}
