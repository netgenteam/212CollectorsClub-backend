import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  ProductSignalsService,
  viewRateLimit,
} from './product-signals.service.js';
import { VIEW_THROTTLED, ViewRateLimitGuard } from './view-rate-limit.guard.js';

@ApiTags('catalog')
@Controller('products')
export class ProductViewController {
  constructor(private readonly signals: ProductSignalsService) {}

  @Post(':id/view')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(ViewRateLimitGuard)
  @Throttle({ default: { limit: viewRateLimit, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Register an anonymous product view (aggregate counter)',
    description:
      'Always answers 204 with no body, so it reveals nothing: unknown or inactive product, bot user agent, repeated view (in-memory dedupe per IP+product within VIEW_DEDUP_WINDOW_SEC, keyed by a daily-salted HMAC; the IP is never stored or logged), rate-limited (VIEW_RATE_LIMIT_PER_MIN per IP, no 429), or `Sec-GPC: 1` / `DNT: 1` privacy signal (not counted). Only a per-product, per-UTC-day counter is stored. A malformed id is rejected with 400 by the UUID pipe.',
  })
  @ApiParam({ name: 'id', description: 'Product uuid', format: 'uuid' })
  @ApiResponse({
    status: HttpStatus.NO_CONTENT,
    description: 'Always, whether or not the view was counted.',
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'Malformed uuid.',
  })
  async view(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
    @Headers('user-agent') ua: string | undefined,
    @Headers('sec-gpc') gpc: string | undefined,
    @Headers('dnt') dnt: string | undefined,
  ): Promise<void> {
    if ((req as unknown as Record<symbol, boolean>)[VIEW_THROTTLED]) return;
    if (gpc?.trim() === '1' || dnt?.trim() === '1') return;
    await this.signals.recordView(id, req.ip ?? '', ua);
  }
}
