import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { FxCurrentResponseDto } from './dto/fx-current.dto.js';
import { FxRateService } from './fx-rate.service.js';

/** Story 18.3 (AD-80, FR-94): public current VES rate. */
@ApiTags('fx')
@Controller('fx')
export class FxPublicController {
  constructor(private readonly rates: FxRateService) {}

  @Get('current')
  @ApiOperation({
    summary: 'Current VES rate used by Pago Móvil checkout',
    description:
      'Public, cached 30 s (Cache-Control: public, max-age=30). Exposes no lastError, thresholds or rejected readings.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: FxCurrentResponseDto })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'FX_RATE_UNAVAILABLE: row missing, rate <= 0, or older than maxAgeHours x 3 (non-MANUAL).',
  })
  async current(
    @Res({ passthrough: true }) res: Response,
  ): Promise<FxCurrentResponseDto> {
    const body = await this.rates.getCurrent();
    res.setHeader('Cache-Control', 'public, max-age=30');
    return body;
  }
}
