import { HttpStatus, Injectable } from '@nestjs/common';
import { isISO8601 } from 'class-validator';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LandingConfigEntryResponseDto } from './dto/landing-config-entry-response.dto.js';
import { UpdateLandingBannerDto } from './dto/update-landing-banner.dto.js';
import { UpdateLandingDrop212Dto } from './dto/update-landing-drop212.dto.js';
import { UpdateLandingTextDto } from './dto/update-landing-text.dto.js';
import {
  LANDING_DROP212_TARGET_DATE_KEY,
  LANDING_SECTION_BANNERS,
  LANDING_SECTION_DROP212,
  LANDING_SECTION_TEXTS,
  isLandingBannerKey,
  isLandingDrop212Key,
  isLandingTextKey,
} from './landing-content.constants.js';

const ENTRY_SELECT = {
  section: true,
  key: true,
  valueType: true,
  value: true,
  updatedAt: true,
  updatedById: true,
} as const;

/**
 * Story 10.1 (FR-29, NFR-2, NFR-4; AD-9, AD-10). Shared service behind both
 * `AdminLandingContentController` (the two guarded `PUT`s) and
 * `LandingContentController` (the public, unauthenticated `GET`).
 *
 * **Fixed-key enforcement (the story's central AC)**: `upsertText`/
 * `upsertBanner` below check the requested `key` against
 * `LANDING_TEXT_KEYS`/`LANDING_BANNER_KEYS`
 * (`landing-content.constants.ts`) BEFORE ever touching Prisma — an
 * unrecognized key throws `400 LANDING_KEY_NOT_EDITABLE` and no
 * `LandingConfigEntry` row is created, by construction (there is no
 * `upsert` call on that path at all, not a caught constraint violation).
 * `400`, not `404`, because the failure is "this key is not a legal value
 * for this endpoint" (an enum-shaped validation failure on the path
 * param), the same class of rejection an invalid `franchise` filter gets
 * elsewhere in this codebase — not "a real editable field that happens to
 * have no row yet" (every legal key IS guaranteed a row once the seed has
 * run; see `prisma/seed.ts`).
 *
 * **No caching, "immediately visible" by construction (AD-10)**: every
 * write here is a direct Prisma `upsert` against the exact same
 * `Landing_Config_Entries` table `getPublicContent` reads from on every
 * call — there is nothing to invalidate, so the very next public read
 * simply sees the new value.
 */
@Injectable()
export class LandingContentService {
  constructor(private readonly prisma: PrismaService) {}

  async upsertText(
    key: string,
    dto: UpdateLandingTextDto,
    adminUserId: string,
  ): Promise<LandingConfigEntryResponseDto> {
    if (!isLandingTextKey(key)) {
      throw notEditableException(LANDING_SECTION_TEXTS, key);
    }

    return this.prisma.landingConfigEntry.upsert({
      where: {
        section_key: { section: LANDING_SECTION_TEXTS, key },
      },
      create: {
        section: LANDING_SECTION_TEXTS,
        key,
        valueType: 'text',
        value: dto.value,
        updatedById: adminUserId,
      },
      update: {
        valueType: 'text',
        value: dto.value,
        updatedById: adminUserId,
      },
      select: ENTRY_SELECT,
    });
  }

  async upsertBanner(
    key: string,
    dto: UpdateLandingBannerDto,
    adminUserId: string,
  ): Promise<LandingConfigEntryResponseDto> {
    if (!isLandingBannerKey(key)) {
      throw notEditableException(LANDING_SECTION_BANNERS, key);
    }

    const value: Prisma.JsonObject = {
      imageUrl: dto.imageUrl,
      title: dto.title,
      linkUrl: dto.linkUrl,
    };

    return this.prisma.landingConfigEntry.upsert({
      where: {
        section_key: { section: LANDING_SECTION_BANNERS, key },
      },
      create: {
        section: LANDING_SECTION_BANNERS,
        key,
        valueType: 'json',
        value,
        updatedById: adminUserId,
      },
      update: {
        valueType: 'json',
        value,
        updatedById: adminUserId,
      },
      select: ENTRY_SELECT,
    });
  }

  /**
   * Story 10.2 (FR-30, NFR-2; AD-9, AD-10). Same fixed-key-enforcement
   * pattern as `upsertText`/`upsertBanner` above — reuses the SAME
   * `notEditableException()` helper (no duplicated "key not allowed"
   * logic, just a new key set: `LANDING_DROP212_KEYS`).
   *
   * The one thing genuinely new here: `targetDate` gets a REAL,
   * section-specific ISO-8601 validation beyond Story 10.1's generic
   * `@IsString()` — checked with class-validator's own `isISO8601()`
   * validator function (`{ strict: true, strictSeparator: true }`: rejects
   * both non-date-shaped strings like "mañana" AND malformed/impossible
   * calendar dates like "2026-02-30", and requires the literal "T"
   * date/time separator). This can't be a static `@IsISO8601()` DTO
   * decorator because it must apply ONLY when `key === "targetDate"` —
   * `displayText` shares the exact same `UpdateLandingDrop212Dto`/route but
   * must stay a free string (same criterion as "texts" from Story 10.1) —
   * so the check runs imperatively here, after the fixed-key check, before
   * ever touching Prisma (same "invalid input -> zero DB writes"
   * guarantee `notEditableException` already gives the key check).
   *
   * `valueType`: "date" for `targetDate` (a more precise Admin-UI
   * rendering hint than "text", now that this value is guaranteed
   * ISO-8601), "text" for `displayText` — purely a rendering hint, per the
   * schema's own doc comment, never branched on by backend logic.
   */
  async upsertDrop212(
    key: string,
    dto: UpdateLandingDrop212Dto,
    adminUserId: string,
  ): Promise<LandingConfigEntryResponseDto> {
    if (!isLandingDrop212Key(key)) {
      throw notEditableException(LANDING_SECTION_DROP212, key);
    }

    if (
      key === LANDING_DROP212_TARGET_DATE_KEY &&
      !isISO8601(dto.value, { strict: true, strictSeparator: true })
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LANDING_INVALID_ISO8601_DATE',
        `"${dto.value}" is not a valid ISO-8601 date/time. "targetDate" must be a real calendar date/time, e.g. "2026-12-25T00:00:00.000Z".`,
      );
    }

    const valueType = key === LANDING_DROP212_TARGET_DATE_KEY ? 'date' : 'text';

    return this.prisma.landingConfigEntry.upsert({
      where: {
        section_key: { section: LANDING_SECTION_DROP212, key },
      },
      create: {
        section: LANDING_SECTION_DROP212,
        key,
        valueType,
        value: dto.value,
        updatedById: adminUserId,
      },
      update: {
        valueType,
        value: dto.value,
        updatedById: adminUserId,
      },
      select: ENTRY_SELECT,
    });
  }

  /**
   * Story 10.1: `GET /api/v1/landing-content` — public, unauthenticated,
   * always 200 (an empty table is a legal, non-error state — the same
   * "never error on empty" convention `CatalogController.listCategories`
   * already established). Groups every row by `section` into
   * `{ [section]: { [key]: { valueType, value, updatedAt } } }`.
   */
  async getPublicContent(): Promise<
    Record<
      string,
      Record<string, { valueType: string; value: unknown; updatedAt: Date }>
    >
  > {
    const rows = await this.prisma.landingConfigEntry.findMany({
      select: {
        section: true,
        key: true,
        valueType: true,
        value: true,
        updatedAt: true,
      },
      orderBy: [{ section: 'asc' }, { key: 'asc' }],
    });

    const grouped: Record<
      string,
      Record<string, { valueType: string; value: unknown; updatedAt: Date }>
    > = {};
    for (const row of rows) {
      grouped[row.section] ??= {};
      grouped[row.section][row.key] = {
        valueType: row.valueType,
        value: row.value,
        updatedAt: row.updatedAt,
      };
    }
    return grouped;
  }
}

function notEditableException(section: string, key: string): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'LANDING_KEY_NOT_EDITABLE',
    `"${key}" is not an editable field of the "${section}" landing-content section. This capability only edits a fixed, pre-defined set of keys — see landing-content.constants.ts.`,
  );
}
