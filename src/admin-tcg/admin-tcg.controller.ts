import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { AdminTcgService } from './admin-tcg.service.js';
import { MasterCardSearchResponseDto } from './dto/master-card-search-response.dto.js';
import { SearchMasterCardsQueryDto } from './dto/search-master-cards-query.dto.js';

/**
 * Story 15.5 (FR-68, AD-56). Admin-only; guarded like every `/admin/*`.
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
}
