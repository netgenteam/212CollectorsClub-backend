import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { SimulatorConfigService } from './simulator-config.service.js';
import {
  SimulatorSetsService,
  type SimulatorSetSummary,
} from './simulator-sets.service.js';
import type { SimulatorConfig } from './simulator-defaults.js';

/** Story 16.3 (AD-66, FR-79): validated admin config for the pack simulator. */
@ApiTags('admin-simulator')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/simulator')
export class AdminSimulatorController {
  constructor(
    private readonly config: SimulatorConfigService,
    private readonly sets: SimulatorSetsService,
  ) {}

  @Get('config')
  @ApiOperation({
    summary: 'Effective simulator config',
    description:
      'Returns { templates, sets } stored in LandingConfigEntry(pack_simulator, config), or the defaults (pokemon template) when none is saved.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  getConfig(): Promise<SimulatorConfig> {
    return this.config.getEffective();
  }

  @Put('config')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Replace the simulator config (applied immediately, no draft)',
    description:
      'Templates: slots fixed(tier,count 1..8) | reverse(count 1..4) | rare(odds RARE..HYPER_RARE, sum 100 ±0.001), exactly one rare slot and it must be last, 1..15 cards. Up to 50 sets. imageUrl only /uploads/public/landing/… paths.',
  })
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        templates: { type: 'object', additionalProperties: true },
        sets: { type: 'array', items: { type: 'object' } },
      },
    },
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'SIMULATOR_CONFIG_INVALID | SIMULATOR_ODDS_INVALID_SUM (details {path,sum})',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'SIMULATOR_SET_NOT_INGESTED | SIMULATOR_TEMPLATE_REQUIRED',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  putConfig(
    @Body() body: unknown,
    @Req() req: RequestWithAdminUser,
  ): Promise<SimulatorConfig> {
    return this.config.save(body, req.user.id);
  }

  @Get('sets')
  @ApiOperation({
    summary: 'Ingested (cursor DONE) sets with tier coverage diagnostics',
    description:
      'Per set: cardCount, enabled, tierCoverage, unmappedRarities (raw rarities mapPackTier cannot map) and hasReversePrintings. Cards filtered by the active TCG client provider.',
  })
  @ApiResponse({ status: HttpStatus.OK })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  async listSets(): Promise<{ data: SimulatorSetSummary[] }> {
    return { data: await this.sets.list() };
  }
}
