import {
  ArgumentsHost,
  BadRequestException,
  Catch,
  Controller,
  ExceptionFilter,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Query,
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
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { ApiException } from '../common/api-exception.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import { LandingImagesService } from './landing-images.service.js';
import { LandingImageResponseDto } from './dto/landing-image-response.dto.js';

/** Re-shapes multer's size-limit 413 into this API's `errorCode` body. */
@Catch(PayloadTooLargeException)
export class LandingImageTooLargeFilter implements ExceptionFilter {
  catch(_exception: PayloadTooLargeException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const max = Number(process.env.LANDING_IMAGE_MAX_BYTES) || 2 * 1024 * 1024;
    res.status(HttpStatus.PAYLOAD_TOO_LARGE).json({
      statusCode: HttpStatus.PAYLOAD_TOO_LARGE,
      errorCode: 'LANDING_IMAGE_TOO_LARGE',
      message: `The image exceeds the maximum of ${max} bytes.`,
      details: { maxBytes: max },
    });
  }
}

/**
 * Multer rejections other than size (more than one file, unexpected field)
 * reach Nest as a plain `BadRequestException`; give them an `errorCode`.
 * `ApiException`s are not `BadRequestException`s, so they pass untouched.
 */
@Catch(BadRequestException)
export class LandingImageMultipartFilter implements ExceptionFilter {
  catch(exception: BadRequestException, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const raw = exception.getResponse();
    const message =
      typeof raw === 'string'
        ? raw
        : ((raw as { message?: string | string[] }).message ??
          exception.message);
    res.status(HttpStatus.BAD_REQUEST).json({
      statusCode: HttpStatus.BAD_REQUEST,
      errorCode: 'LANDING_IMAGE_MULTIPART_INVALID',
      message: Array.isArray(message) ? message.join('; ') : message,
      details: { hint: 'Send exactly one file in the "file" field.' },
    });
  }
}

/**
 * Story 16.2 (FR-72; AD-64). Admin upload of landing images. The multer
 * size limit comes from `MulterModule.registerAsync` in the module
 * (`LANDING_IMAGE_MAX_BYTES`, memory storage, 1 file).
 */
@ApiTags('admin-landing')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/landing-content')
export class AdminLandingImagesController {
  constructor(private readonly images: LandingImagesService) {}

  @Post('images')
  @UseFilters(LandingImageTooLargeFilter, LandingImageMultipartFilter)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a landing image (jpg/png/webp/avif)',
    description:
      'The format is decided by magic bytes (Content-Type is ignored). Width 200-4096 px, height <= 4096 px. With kind=card the proportion must be 63:88 (±3 %). Stored under /uploads/public/landing/<uuid>.<ext>; nothing is written when validation fails.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
      required: ['file'],
    },
  })
  @ApiQuery({ name: 'kind', enum: ['generic', 'card'], required: false })
  @ApiResponse({ status: HttpStatus.CREATED, type: LandingImageResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode LANDING_IMAGE_REQUIRED | UNSUPPORTED_FILE_TYPE | LANDING_IMAGE_KIND_INVALID | LANDING_IMAGE_MULTIPART_INVALID (more than one file / wrong field).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  @ApiResponse({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    description: 'errorCode LANDING_IMAGE_TOO_LARGE.',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'errorCode LANDING_IMAGE_DIMENSIONS | LANDING_IMAGE_BAD_RATIO (details: width, height, expected, tolerance).',
  })
  upload(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('kind') kind?: string,
  ): Promise<LandingImageResponseDto> {
    if (kind !== undefined && kind !== 'generic' && kind !== 'card') {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LANDING_IMAGE_KIND_INVALID',
        'kind must be "generic" or "card".',
      );
    }
    return this.images.upload(file, kind ?? 'generic');
  }
}
