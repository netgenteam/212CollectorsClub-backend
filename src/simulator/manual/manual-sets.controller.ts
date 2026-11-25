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
  CreateManualSetDto,
  ManualSetsQueryDto,
  SetDto,
  SetListDto,
  UpdateManualSetDto,
} from './manual-sets.dto.js';
import { ManualSetsService } from './manual-sets.service.js';

const E401 = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;
const E400 = {
  status: HttpStatus.BAD_REQUEST,
  description:
    'Standard validation error | SIMULATOR_CONFIG_INVALID | SIMULATOR_ODDS_INVALID_SUM (template).',
} as const;
const E404 = {
  status: HttpStatus.NOT_FOUND,
  description: 'SIMULATOR_SET_NOT_FOUND',
} as const;

/** Story 22.4 (AD-107/108, FR-149/152/153/156): CRUD of manual simulator sets. */
@ApiTags('admin-simulator-manual-sets')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/simulator/manual-sets')
export class ManualSetsController {
  constructor(private readonly sets: ManualSetsService) {}

  @Get()
  @ApiOperation({ summary: 'List manual sets with readiness and tier counts' })
  @ApiOkResponse({ type: SetListDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  list(@Query() q: ManualSetsQueryDto): Promise<SetListDto> {
    return this.sets.list(q);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a manual set (always inactive)',
    description:
      'Without `template` a copy of the `pokemon` default is stored. `isActive` in the body is ignored.',
  })
  @ApiCreatedResponse({ type: SetDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SIMULATOR_SET_NAME_TAKEN | SIMULATOR_SET_BUSY',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'SIMULATOR_SET_LIMIT (SIMULATOR_MAX_SETS, default 50)',
  })
  create(
    @Body() dto: CreateManualSetDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<SetDto> {
    return this.sets.create(dto, req.user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One manual set' })
  @ApiOkResponse({ type: SetDto })
  @ApiResponse({ ...E400, description: 'id is not a uuid.' })
  @ApiResponse(E401)
  @ApiResponse(E404)
  get(@Param('id', ParseUUIDPipe) id: string): Promise<SetDto> {
    return this.sets.get(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edit / activate / deactivate a manual set',
    description:
      'Row-locked (`FOR UPDATE`, 5 s) and audited. Idempotent changes write nothing. Activating or editing the template of an active set that is not ready => 422.',
  })
  @ApiOkResponse({ type: SetDto })
  @ApiResponse(E400)
  @ApiResponse(E401)
  @ApiResponse(E404)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SIMULATOR_SET_NAME_TAKEN | SIMULATOR_SET_BUSY',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'SIMULATOR_SET_NOT_READY (details.missing[{slot,tier,required,available}], details.reason TEMPLATE_INVALID)',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateManualSetDto,
    @Req() req: RequestWithAdminUser,
  ): Promise<SetDto> {
    return this.sets.update(id, dto, req.user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete an inactive set (its cards cascade)' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse({ ...E400, description: 'id is not a uuid.' })
  @ApiResponse(E401)
  @ApiResponse(E404)
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SIMULATOR_SET_ACTIVE | SIMULATOR_SET_BUSY',
  })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: RequestWithAdminUser,
  ): Promise<void> {
    return this.sets.remove(id, req.user);
  }
}
