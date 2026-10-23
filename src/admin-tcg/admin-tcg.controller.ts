import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiAcceptedResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { AdminTcgService } from './admin-tcg.service.js';
import { MasterCardSearchResponseDto } from './dto/master-card-search-response.dto.js';
import { SearchMasterCardsQueryDto } from './dto/search-master-cards-query.dto.js';
import { StartIngestDto } from './dto/start-ingest.dto.js';
import {
  StartIngestResponseDto,
  TcgMasterCardStatsDto,
  TcgSyncRunDto,
} from './dto/tcg-ingest-run.dto.js';

/**
 * Story 15.5 (FR-68, AD-56) + 15.9 (remote ingest). Admin-only; guarded like every `/admin/*`.
 */
@ApiTags('admin-tcg')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/tcg-master-cards')
export class AdminTcgController {
  constructor(private readonly service: AdminTcgService) {}

  @Get('search')
  @ApiOperation({
    summary: 'Search the local master card catalog with inventory status',
    description:
      'Reads only the local DB (no tcgapi call). One entry per printing. Order: marketPriceUsd DESC NULLS LAST, name, id.',
  })
  @ApiOkResponse({ type: MasterCardSearchResponseDto })
  @ApiResponse({
    status: 400,
    description: 'Invalid query (franchise, limit>50, page<1).',
  })
  @ApiResponse({ status: 401, description: 'Missing or invalid admin token.' })
  search(
    @Query() query: SearchMasterCardsQueryDto,
  ): Promise<MasterCardSearchResponseDto> {
    return this.service.searchMasterCards(query);
  }

  @Post('ingest')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Start a master card ingestion in the background',
    description:
      'Runs on the server with its own TCGAPI_KEY (never sent over HTTP), reusing the CLI ingestion (same lock, cursors, budget and reserve). Answers as soon as the run row exists; poll GET runs/:id. Missing fields use the TCG_* env defaults. No dry run.',
  })
  @ApiAcceptedResponse({ type: StartIngestResponseDto })
  @ApiResponse({ status: 400, description: 'Invalid body.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid admin token.' })
  @ApiResponse({
    status: 409,
    description:
      'errorCode TCG_SYNC_ALREADY_RUNNING — another ingest/nightly run is active (details.runId when known).',
  })
  @ApiResponse({
    status: 503,
    description:
      'errorCode TCG_API_NOT_CONFIGURED — the server has no TCGAPI_KEY (fake client); nothing is created.',
  })
  startIngest(@Body() body: StartIngestDto): Promise<StartIngestResponseDto> {
    return this.service.startIngest(body);
  }

  @Get('runs/:id')
  @ApiOperation({ summary: 'Status of an ingest/nightly sync run' })
  @ApiOkResponse({ type: TcgSyncRunDto })
  @ApiResponse({ status: 400, description: 'id is not a uuid.' })
  @ApiResponse({ status: 401, description: 'Missing or invalid admin token.' })
  @ApiResponse({ status: 404, description: 'Run not found.' })
  getRun(@Param('id', ParseUUIDPipe) id: string): Promise<TcgSyncRunDto> {
    return this.service.getRun(id);
  }

  @Get('stats')
  @ApiOperation({
    summary: 'Master card counts by franchise and the latest sync run',
  })
  @ApiOkResponse({ type: TcgMasterCardStatsDto })
  @ApiResponse({ status: 401, description: 'Missing or invalid admin token.' })
  getStats(): Promise<TcgMasterCardStatsDto> {
    return this.service.getStats();
  }
}
