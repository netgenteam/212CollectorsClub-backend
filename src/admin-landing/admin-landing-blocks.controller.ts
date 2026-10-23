import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import {
  LandingBlockDetailDto,
  LandingBlockListResponseDto,
  LandingPublishAllResponseDto,
} from './dto/landing-block-response.dto.js';
import { LANDING_BLOCKS } from './landing-blocks.constants.js';
import { LandingBlocksService } from './landing-blocks.service.js';

const BLOCK_PARAM = {
  name: 'block',
  enum: [...LANDING_BLOCKS],
  description: 'One of the seven Home blocks.',
} as const;

const UNAUTHORIZED = {
  status: HttpStatus.UNAUTHORIZED,
  description:
    'errorCode INVALID_ADMIN_TOKEN — missing/invalid/expired Admin JWT (a customer session is rejected too).',
} as const;

const UNKNOWN_BLOCK = {
  status: HttpStatus.NOT_FOUND,
  description: 'errorCode LANDING_BLOCK_UNKNOWN — not one of the 7 blocks.',
} as const;

/**
 * Story 16.1 (FR-71, FR-74; AD-60, AD-61). Admin CMS over the seven typed
 * `home/*` blocks with a draft/publish cycle. Shares the
 * `admin/landing-content` prefix with the legacy controller; the routes
 * (`blocks/...`, `publish`) never collide with its `texts|banners|...` ones.
 * `GET draft` and `vitrina` resolution arrive in Story 16.2.
 */
@ApiTags('admin-landing')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/landing-content')
export class AdminLandingBlocksController {
  constructor(private readonly blocksService: LandingBlocksService) {}

  @Get('blocks')
  @ApiOperation({
    summary: 'List the 7 Home blocks with their draft/published status',
    description:
      'Always returns the 7 blocks (ticker, hero, heroScene, manifesto, vitrina, drop212, simulator), even when none was ever saved.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingBlockListResponseDto })
  @ApiResponse(UNAUTHORIZED)
  listBlocks(): Promise<LandingBlockListResponseDto> {
    return this.blocksService.listBlocks();
  }

  @Get('blocks/:block')
  @ApiOperation({
    summary: 'Read one block: published value and pending draft',
  })
  @ApiParam(BLOCK_PARAM)
  @ApiResponse({ status: HttpStatus.OK, type: LandingBlockDetailDto })
  @ApiResponse(UNKNOWN_BLOCK)
  @ApiResponse(UNAUTHORIZED)
  getBlock(@Param('block') block: string): Promise<LandingBlockDetailDto> {
    return this.blocksService.getBlock(block);
  }

  @Put('blocks/:block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save the DRAFT of one block (does not publish)',
    description:
      'The body is the block value itself (shape per block, AD-60). Only the draft is stored; the published value is untouched and the public GET does not see it. Last writer wins. Max payload 20 KB; unknown fields are rejected.',
  })
  @ApiParam(BLOCK_PARAM)
  @ApiBody({
    type: Object,
    description:
      'Block value: ticker {items}, hero {panels}, heroScene {packImageUrl, cardImageUrls}, manifesto {items}, vitrina {eyebrow, titleLines, ctaLabel, productIds}, drop212 {eyebrow, caption, targetDate, tiers}, simulator {eyebrow, titleLines, description, ctaLabel}.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingBlockDetailDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_BLOCK_INVALID (details.errors: [{path, messages[]}]) or LANDING_PRODUCT_NOT_FOUND (vitrina; details.ids).',
  })
  @ApiResponse(UNKNOWN_BLOCK)
  @ApiResponse(UNAUTHORIZED)
  saveDraft(
    @Param('block') block: string,
    @Body() body: unknown,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingBlockDetailDto> {
    return this.blocksService.saveDraft(block, body, req.user.id);
  }

  @Post('blocks/:block/publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish the draft of one block',
    description:
      'In one transaction: value = draft, publishedAt = now, draft cleared.',
  })
  @ApiParam(BLOCK_PARAM)
  @ApiResponse({ status: HttpStatus.OK, type: LandingBlockDetailDto })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'errorCode LANDING_NO_DRAFT — the block has no draft.',
  })
  @ApiResponse(UNKNOWN_BLOCK)
  @ApiResponse(UNAUTHORIZED)
  publishBlock(
    @Param('block') block: string,
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingBlockDetailDto> {
    return this.blocksService.publishBlock(block, req.user.id);
  }

  @Delete('blocks/:block/draft')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Discard the draft of one block',
    description: 'Idempotent: 204 also when there was no draft.',
  })
  @ApiParam(BLOCK_PARAM)
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse(UNKNOWN_BLOCK)
  @ApiResponse(UNAUTHORIZED)
  discardDraft(@Param('block') block: string): Promise<void> {
    return this.blocksService.discardDraft(block);
  }

  @Post('publish')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Publish every block that has a draft (atomic)',
    description:
      'All drafts are promoted in a single transaction: if any fails none is published. With no drafts responds 200 { published: [] }.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LandingPublishAllResponseDto })
  @ApiResponse(UNAUTHORIZED)
  publishAll(
    @Req() req: RequestWithAdminUser,
  ): Promise<LandingPublishAllResponseDto> {
    return this.blocksService.publishAll(req.user.id);
  }
}
