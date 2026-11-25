import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AdminAuthGuard } from '../../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../../common/admin-auth.guard.js';
import {
  CardDto,
  CardListDto,
  CardsQueryDto,
  CreateManualCardDto,
  UpdateManualCardDto,
} from './manual-cards.dto.js';
import { ManualCardsService } from './manual-cards.service.js';

const E400 = {
  status: HttpStatus.BAD_REQUEST,
  description: 'Standard validation error (ids must be uuids).',
} as const;
const E401 = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;
const E404 = {
  status: HttpStatus.NOT_FOUND,
  description: 'SIMULATOR_SET_NOT_FOUND | SIMULATOR_CARD_NOT_FOUND',
} as const;
const E409 = {
  status: HttpStatus.CONFLICT,
  description:
    'SIMULATOR_CARD_NUMBER_TAKEN | SIMULATOR_SET_BUSY (set lock wait expired)',
} as const;
const E422Ready = {
  status: HttpStatus.UNPROCESSABLE_ENTITY,
  description:
    'SIMULATOR_SET_NOT_READY (details.missing): the change would leave an ACTIVE set without enough cards.',
} as const;

/** Story 22.5 (AD-107/108, FR-149/153/156): CRUD of the cards of a manual set. */
@ApiTags('admin-simulator-manual-cards')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/simulator/manual-sets/:id/cards')
export class ManualCardsController {
  constructor(private readonly cards: ManualCardsService) {}

  @Get()
  @ApiOperation({ summary: 'List the cards of a set (name, id order)' })
  @ApiOkResponse({ type: CardListDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse(E404)
  list(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CardsQueryDto,
  ): Promise<CardListDto> {
    return this.cards.list(id, q);
  }

  @Post()
  @ApiOperation({
    summary: 'Add a card to a set',
    description:
      'Row-locked, audited. Adding never reduces readiness. Max SIMULATOR_MAX_CARDS_PER_SET (default 2000).',
  })
  @ApiCreatedResponse({ type: CardDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse(E404)
  @ApiResponse(E409)
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'SIMULATOR_SET_CARD_LIMIT (details {max, current, incoming: 1})',
  })
  create(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateManualCardDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<CardDto> {
    return this.cards.create(id, dto, req.user);
  }

  @Patch(':cardId')
  @ApiOperation({
    summary: 'Edit a card',
    description:
      '`number`, `imageUrl`, `marketPriceUsd` accept null to clear. Changing `rarityTier` of a card of an active set is rejected (422) if the set would stop being ready. No effective change => 200, no event.',
  })
  @ApiOkResponse({ type: CardDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse(E404)
  @ApiResponse(E409)
  @ApiResponse(E422Ready)
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Body() dto: UpdateManualCardDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<CardDto> {
    return this.cards.update(id, cardId, dto, req.user);
  }

  @Delete(':cardId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete a card',
    description:
      'On an ACTIVE set, rejected (422) if the set would stop being ready.',
  })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse(E404)
  @ApiResponse({ ...E409, description: 'SIMULATOR_SET_BUSY' })
  @ApiResponse(E422Ready)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('cardId', ParseUUIDPipe) cardId: string,
    @Req() req: RequestWithAdminUser,
  ): Promise<void> {
    return this.cards.remove(id, cardId, req.user);
  }
}
