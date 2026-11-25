import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  Controller,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  UploadedFile,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { AdminAuthGuard } from '../../common/admin-auth.guard.js';
import {
  SimulatorImagesService,
  simulatorImageMaxBytes,
  type SimulatorImageResult,
} from './simulator-images.service.js';

export class SimulatorImageResponseDto implements SimulatorImageResult {
  @ApiProperty({ example: '/uploads/public/simulator/<uuid>.png' })
  url!: string;
  @ApiProperty() width!: number;
  @ApiProperty() height!: number;
  @ApiProperty() bytes!: number;
}

/** multer size limit (413) re-shaped into this API's `errorCode` body. */
@Catch(PayloadTooLargeException)
export class SimulatorImageTooLargeFilter implements ExceptionFilter {
  catch(_e: PayloadTooLargeException, host: ArgumentsHost): void {
    const max = simulatorImageMaxBytes();
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.PAYLOAD_TOO_LARGE)
      .json({
        statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
        errorCode: 'SIMULATOR_IMAGE_TOO_LARGE',
        message: `The image exceeds the maximum of ${max} bytes.`,
        details: { maxBytes: max },
      });
  }
}

/** Other multer rejections: unexpected field name => REQUIRED; extra files => MULTIPART_INVALID. */
@Catch(BadRequestException)
export class SimulatorImageMultipartFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const raw = exception.getResponse();
    const m =
      typeof raw === 'string'
        ? raw
        : ((raw as { message?: string | string[] }).message ??
          exception.message);
    const message = Array.isArray(m) ? m.join('; ') : m;
    const unexpected = /unexpected (file )?field/i.test(message);
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(HttpStatus.BAD_REQUEST)
      .json({
        statusCode: HttpStatus.BAD_REQUEST,
        errorCode: unexpected
          ? 'SIMULATOR_IMAGE_REQUIRED'
          : 'SIMULATOR_IMAGE_MULTIPART_INVALID',
        message,
        details: { hint: 'Send exactly one file in the "file" field.' },
      });
  }
}

/** Story 22.6 (FR-151, AD-107): admin upload of set/card images. */
@ApiTags('admin-simulator-manual-sets')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/simulator/images')
export class SimulatorImagesController {
  constructor(private readonly images: SimulatorImagesService) {}

  @Post()
  @UseFilters(SimulatorImageTooLargeFilter, SimulatorImageMultipartFilter)
  @UseInterceptors(
    FileInterceptor('file', {
      storage: memoryStorage(),
      limits: { files: 1, fileSize: simulatorImageMaxBytes() },
    }),
  )
  @ApiOperation({
    summary: 'Upload a simulator set/card image (jpg/png/webp/avif)',
    description:
      'Format decided by magic bytes. Max SIMULATOR_IMAGE_MAX_BYTES (def. 2 MB); longest side <= 4096 px; no proportion required. Stored under /uploads/public/simulator/<uuid>.<ext>; use the returned `url` as imageUrl. Orphan files are not deleted.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiCreatedResponse({ type: SimulatorImageResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode SIMULATOR_IMAGE_REQUIRED | UNSUPPORTED_FILE_TYPE | SIMULATOR_IMAGE_MULTIPART_INVALID.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  @ApiResponse({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    description: 'errorCode SIMULATOR_IMAGE_TOO_LARGE (details.maxBytes).',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'errorCode SIMULATOR_IMAGE_DIMENSIONS (details: width, height).',
  })
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<SimulatorImageResult> {
    return this.images.upload(file);
  }
}
