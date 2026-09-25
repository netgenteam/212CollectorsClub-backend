import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { LandingConfigEntryResponseDto } from './dto/landing-config-entry-response.dto.js';
import { UpdateLandingBannerDto } from './dto/update-landing-banner.dto.js';
import { UpdateLandingDrop212Dto } from './dto/update-landing-drop212.dto.js';
import { UpdateLandingTextDto } from './dto/update-landing-text.dto.js';
import { UpdatePackSimulatorDto } from './dto/update-landing-pack-simulator.dto.js';
import { LandingContentService } from './landing-content.service.js';

/**
 * Story 10.1 (FR-29, NFR-2, NFR-4; AD-9, AD-10, AD-11). Admin `PUT`s over
 * the "texts"/"banners" `LandingConfigEntry` rows — the first two
 * consumers of the `AdminLanding` module the Architecture Spine's module
 * map anticipated. Guarded at the class level, same pattern as
 * `AdminCategoriesController` (Story 8.1): every route here requires a
 * valid Admin JWT.
 *
 * Every route is `PUT`, not `PATCH` — semantically correct here (each call
 * fully replaces the addressed row's value; there is no partial-field
 * update concept for a single "texts" key, a "banners" key's 3 fields are
 * always submitted together (see `UpdateLandingBannerDto`), and a
 * "pack_simulator" key's value is a single opaque JSON blob replaced
 * wholesale, never merged), and matches the exact verb the stories' own
 * Acceptance Criteria specify.
 *
 * Story 10.2 added `drop212/:key` and Story 10.3 added `pack_simulator/:key`
 * as further routes on this SAME controller/module — no new controller
 * class or module was ever needed across all three Epic 10 stories. The
 * `pack_simulator` route is the one genuine shape difference: it does NOT
 * restrict `:key` to a fixed set (see `updatePackSimulator`'s own doc
 * comment and `LANDING_SECTION_PACK_SIMULATOR` in
 * `landing-content.constants.ts` for why).
 */
@ApiTags('admin-landing')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/landing-content')
export class AdminLandingContentController {
  constructor(private readonly landingContentService: LandingContentService) {}

  @Put('texts/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit one "texts" landing-content field',
    description:
      'Upserts LandingConfigEntry(section="texts", key). Restricted to the fixed key set in landing-content.constants.ts — a key outside that set is rejected with 400 LANDING_KEY_NOT_EDITABLE, and no row is ever created for it. Immediately visible via the public GET /api/v1/landing-content (AD-10, no cache).',
  })
  @ApiParam({
    name: 'key',
    description:
      'e.g. heroTitle, heroSubtitle, heroCtaText, heroCtaUrl, announcementBarText.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingConfigEntryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_KEY_NOT_EDITABLE — the given key is not in the fixed, pre-defined "texts" key set.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT.',
  })
  updateText(
    @Param('key') key: string,
    @Body() dto: UpdateLandingTextDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingConfigEntryResponseDto> {
    return this.landingContentService.upsertText(key, dto, req.user.id);
  }

  @Put('banners/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit one "banners" landing-content slot',
    description:
      'Upserts LandingConfigEntry(section="banners", key) with a { imageUrl, title, linkUrl } value. Restricted to the fixed key set (banner1/banner2/banner3) — a key outside that set is rejected with 400 LANDING_KEY_NOT_EDITABLE, and no row is ever created for it. Immediately visible via the public GET /api/v1/landing-content (AD-10, no cache).',
  })
  @ApiParam({ name: 'key', description: 'banner1, banner2, or banner3.' })
  @ApiResponse({ status: HttpStatus.OK, type: LandingConfigEntryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_KEY_NOT_EDITABLE — the given key is not in the fixed, pre-defined "banners" key set.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT.',
  })
  updateBanner(
    @Param('key') key: string,
    @Body() dto: UpdateLandingBannerDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingConfigEntryResponseDto> {
    return this.landingContentService.upsertBanner(key, dto, req.user.id);
  }

  @Put('drop212/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit one "drop212" countdown field',
    description:
      'Upserts LandingConfigEntry(section="drop212", key). Restricted to the fixed key set in landing-content.constants.ts (targetDate, displayText) — a key outside that set is rejected with 400 LANDING_KEY_NOT_EDITABLE, and no row is ever created for it. "targetDate" is additionally validated as a real ISO-8601 date/time (400 LANDING_INVALID_ISO8601_DATE otherwise, e.g. "mañana" or a malformed/impossible calendar date) — section-specific validation beyond Story 10.1\'s generic mechanism. Immediately visible via the public GET /api/v1/landing-content (AD-10, no cache).',
  })
  @ApiParam({
    name: 'key',
    description: 'targetDate or displayText.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingConfigEntryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_KEY_NOT_EDITABLE (key outside the fixed "drop212" key set) or LANDING_INVALID_ISO8601_DATE ("targetDate" not a valid, real ISO-8601 date/time).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT.',
  })
  updateDrop212(
    @Param('key') key: string,
    @Body() dto: UpdateLandingDrop212Dto,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingConfigEntryResponseDto> {
    return this.landingContentService.upsertDrop212(key, dto, req.user.id);
  }

  @Put('pack_simulator/:key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Edit one "pack_simulator" configurable variable',
    description:
      'Upserts LandingConfigEntry(section="pack_simulator", key) with an arbitrary JSON value (flat or nested, e.g. a per-rarity odds table). Unlike "texts"/"banners"/"drop212", this section deliberately does NOT restrict :key to a fixed set — any syntactically valid key (1-100 chars, letters/digits/"_"/"-"/"." , starting with a letter or underscore) is accepted, since the real Pack-Opening Simulator schema is owned by the not-yet-built frontend (PRD OQ7, AD-9). The value is bounded only by a generic max nesting depth (6) and max serialized size (10 KB) — shape/abuse hygiene, never business validation: this endpoint never inspects odds/weights/probabilities (no sum-to-100% check or similar) — that is the frontend\'s responsibility. Immediately visible via the public GET /api/v1/landing-content (AD-10, no cache).',
  })
  @ApiParam({
    name: 'key',
    description:
      'Any simulator variable name the frontend needs, e.g. rarityOdds, featuredSetId, pityTimerThreshold. Not restricted to a fixed set.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingConfigEntryResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_KEY_INVALID_FORMAT (key fails the generic format check), LANDING_VALUE_TOO_DEEP (value nested past the max depth), or LANDING_VALUE_TOO_LARGE (serialized value exceeds the max size) — or a plain validation 400 when "value" is missing/null.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT.',
  })
  updatePackSimulator(
    @Param('key') key: string,
    @Body() dto: UpdatePackSimulatorDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingConfigEntryResponseDto> {
    return this.landingContentService.upsertPackSimulator(
      key,
      dto,
      req.user.id,
    );
  }
}
