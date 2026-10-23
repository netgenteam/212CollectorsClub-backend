import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { OpenPackDto } from './dto/open-pack.dto.js';
import {
  PackGeneratorService,
  type PackResponseDto,
} from './pack-generator.service.js';
import {
  SimulatorSetsService,
  type PublicSimulatorSet,
} from './simulator-sets.service.js';

/** Story 16.4 (AD-67, AD-69): per-IP limit (IP via `trust proxy 1`). */
// Resolved per request: .env is loaded by ConfigModule AFTER this file is imported.
export const simulatorRateLimit = (): number => {
  const n = Number(process.env.SIMULATOR_RATE_LIMIT_PER_MIN ?? 30);
  return Number.isInteger(n) && n > 0 ? n : 30;
};

@ApiTags('simulator')
@Controller('simulator')
export class SimulatorController {
  constructor(
    private readonly sets: SimulatorSetsService,
    private readonly packs: PackGeneratorService,
  ) {}

  @Get('sets')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Public sets available in the pack simulator' })
  async listSets(): Promise<{ data: PublicSimulatorSet[] }> {
    return { data: await this.sets.listPublic() };
  }

  @Post('packs')
  @HttpCode(HttpStatus.OK)
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: simulatorRateLimit,
      ttl: 60_000,
    },
  })
  @ApiOperation({
    summary: 'Open a simulated pack (nothing is persisted)',
    description:
      'Rate-limited per IP (SIMULATOR_RATE_LIMIT_PER_MIN, default 30/min).',
  })
  @ApiResponse({ status: 404, description: 'SIMULATOR_SET_NOT_FOUND' })
  @ApiResponse({ status: 422, description: 'SIMULATOR_SET_INSUFFICIENT_CARDS' })
  @ApiResponse({
    status: 429,
    description: 'Rate limit exceeded (Retry-After).',
  })
  open(@Body() dto: OpenPackDto): Promise<PackResponseDto> {
    return this.packs.open(dto.setId);
  }
}
