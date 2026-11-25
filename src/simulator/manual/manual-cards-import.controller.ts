import {
  BadRequestException,
  CallHandler,
  Controller,
  ExecutionContext,
  HttpStatus,
  Injectable,
  NestInterceptor,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import type { Observable } from 'rxjs';
import { AdminAuthGuard } from '../../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../../common/admin-auth.guard.js';
import { ApiException } from '../../common/api-exception.js';
import { csvMaxBytes } from './csv/parse-csv.js';
import {
  ManualCardsImportService,
  type CardsImportResult,
} from './manual-cards-import.service.js';

export class CardsImportResultDto implements CardsImportResult {
  @ApiProperty() dryRun!: boolean;
  @ApiProperty({ description: 'Data rows read from the file.' }) rows!: number;
  @ApiProperty({ description: 'Cards inserted (0 on dryRun).' })
  imported!: number;
}

export class CardsImportQueryDto {
  @ApiPropertyOptional({
    enum: ['true', 'false'],
    description: 'true = validate only: nothing is written or audited.',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  dryRun?: string;
}

const MULTER_LIMITS = { files: 1, fileSize: csvMaxBytes() };
const FileUploadInterceptor = FileInterceptor('file', {
  storage: memoryStorage(),
  limits: MULTER_LIMITS,
});

/**
 * multer rejections re-shaped into `SIMULATOR_*` codes (only the upload step is wrapped, so pipe
 * 400s such as a bad uuid or `dryRun` keep the standard validation body).
 */
@Injectable()
export class CsvFileInterceptor implements NestInterceptor {
  private readonly inner = new FileUploadInterceptor();

  async intercept(
    ctx: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    try {
      return await this.inner.intercept(ctx, next);
    } catch (e) {
      if (e instanceof PayloadTooLargeException)
        throw new ApiException(
          HttpStatus.PAYLOAD_TOO_LARGE,
          'SIMULATOR_CSV_TOO_LARGE',
          `The CSV exceeds the maximum of ${MULTER_LIMITS.fileSize} bytes.`,
          { maxBytes: MULTER_LIMITS.fileSize },
        );
      if (e instanceof BadRequestException) {
        const raw = e.getResponse();
        const m =
          typeof raw === 'string'
            ? raw
            : ((raw as { message?: string | string[] }).message ?? e.message);
        const message = Array.isArray(m) ? m.join('; ') : m;
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          /unexpected (file )?field/i.test(message)
            ? 'SIMULATOR_CSV_REQUIRED'
            : 'SIMULATOR_CSV_MULTIPART_INVALID',
          message,
          { hint: 'Send exactly one file in the "file" field.' },
        );
      }
      throw e;
    }
  }
}

/** Story 22.7 (FR-150, AD-107, A101, A113): all-or-nothing CSV import of the cards of a manual set. */
@ApiTags('admin-simulator-manual-cards')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/simulator/manual-sets/:id/cards/import')
export class ManualCardsImportController {
  constructor(private readonly importer: ManualCardsImportService) {}

  @Post()
  @UseInterceptors(CsvFileInterceptor)
  @ApiOperation({
    summary: 'Import cards from a CSV (all or nothing)',
    description:
      'Multipart, field `file`, UTF-8 (BOM ok), separator `,` or `;`, max SIMULATOR_CSV_MAX_BYTES (1 MB) and SIMULATOR_CSV_MAX_ROWS (2000) data rows. Header: `name,rarity` required; `number,imageUrl,marketPriceUsd` optional. `rarity`: tier code (DOUBLE_RARE, double rare, double-rare) or text (Illustration Rare, Rare Holo). Cells starting with = + - @ are rejected in name/number (formula injection). Only adds cards (no update); imageUrl is never fetched. Any error => 422 SIMULATOR_CSV_INVALID with every row error (first 100) and nothing is written. `dryRun=true` validates without writing, auditing or touching the version/cache. Success: one audit event SIMULATOR_CARDS_IMPORTED {setId, imported}.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiQuery({ name: 'dryRun', required: false, enum: ['true', 'false'] })
  @ApiResponse({ status: HttpStatus.CREATED, type: CardsImportResultDto })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'dryRun=true: {dryRun:true, rows, imported:0}',
    type: CardsImportResultDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Standard validation (uuid, dryRun) | SIMULATOR_CSV_REQUIRED | SIMULATOR_CSV_MULTIPART_INVALID | UNSUPPORTED_FILE_TYPE (binary).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'INVALID_ADMIN_TOKEN',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'SIMULATOR_SET_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'SIMULATOR_SET_BUSY (set lock wait expired)',
  })
  @ApiResponse({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    description: 'SIMULATOR_CSV_TOO_LARGE (details.maxBytes)',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'SIMULATOR_CSV_INVALID (details {errors[{row,field,code,message}] <=100, totalErrors, truncated}; file-level codes EMPTY, ENCODING, TOO_MANY_ROWS, MALFORMED_CSV) | SIMULATOR_SET_CARD_LIMIT (details {max,current,incoming}).',
  })
  async import(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: CardsImportQueryDto,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Req() req: RequestWithAdminUser,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CardsImportResult> {
    const dryRun = q.dryRun === 'true';
    const out = await this.importer.import(id, file, dryRun, req.user);
    res.status(dryRun ? HttpStatus.OK : HttpStatus.CREATED);
    return out;
  }
}
