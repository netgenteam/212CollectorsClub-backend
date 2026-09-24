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
import { LandingContentService } from './landing-content.service.js';

/**
 * Story 10.1 (FR-29, NFR-2, NFR-4; AD-9, AD-10, AD-11). Admin `PUT`s over
 * the "texts"/"banners" `LandingConfigEntry` rows — the first two
 * consumers of the `AdminLanding` module the Architecture Spine's module
 * map anticipated. Guarded at the class level, same pattern as
 * `AdminCategoriesController` (Story 8.1): every route here requires a
 * valid Admin JWT.
 *
 * Both routes are `PUT`, not `PATCH` — semantically correct here (each
 * call fully replaces the addressed row's value; there is no partial-field
 * update concept for a single "texts" key, and a "banners" key's 3 fields
 * are always submitted together, see `UpdateLandingBannerDto`), and matches
 * the exact verb the story's own Acceptance Criteria specify.
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
}
