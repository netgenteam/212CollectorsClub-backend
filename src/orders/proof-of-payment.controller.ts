import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
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
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApiException } from '../common/api-exception.js';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';
import type { RequestWithOrder } from './order-access-token.guard.js';
import { createProofOfPaymentMulterOptions } from './proof-of-payment-multer.config.js';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { ProofOfPaymentStatusResponseDto } from './dto/proof-of-payment-response.dto.js';

function fileRequiredException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'FILE_REQUIRED',
    'A file is required in the "file" multipart field.',
  );
}

/**
 * Story 4.2 (FR-15, NFR-5; AD-12, AD-17). Every route here sits under
 * `orders/:orderId/proof-of-payment` and is gated exclusively by
 * `OrderAccessTokenGuard` — the buyer's one-time `orderAccessToken` from
 * the Story 4.1 checkout response, never the AD-5 cart cookie, never Admin
 * auth (that gate is what Story 9.2's later admin-facing route under the
 * same `orders/` module will use instead).
 *
 * **On the 400/413 response shape for multer-native rejections**: this
 * controller has no `MulterError` exception filter of its own. Reading
 * `@nestjs/platform-express`'s own `FileInterceptor` implementation
 * (`multer/multer/multer.utils.js`, `transformException`) confirms it
 * ALREADY converts every multer `MulterError` (oversized file, too many
 * files/fields, malformed multipart, ...) into a typed Nest exception
 * (`PayloadTooLargeException` for `LIMIT_FILE_SIZE`, `BadRequestException`
 * for the rest) before it ever leaves the interceptor — a `@Catch
 * (MulterError)` filter placed on this controller would simply never fire,
 * since nothing reaching it is still a raw `MulterError` by then. Those
 * cases are therefore returned in Nest's own default exception shape
 * (`{ statusCode, message, error }`), while every rejection this
 * controller's own code raises (`FILE_REQUIRED`, `UNSUPPORTED_FILE_TYPE`,
 * `ORDER_NOT_AWAITING_PROOF`, both `orderAccessToken` errors) uses this
 * API's usual `ApiErrorBody` (`{ statusCode, errorCode, message }`).
 */
@ApiTags('orders')
@Controller('orders/:orderId/proof-of-payment')
export class ProofOfPaymentController {
  constructor(private readonly proofOfPaymentService: ProofOfPaymentService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(OrderAccessTokenGuard)
  @UseInterceptors(FileInterceptor('file', createProofOfPaymentMulterOptions()))
  @ApiBearerAuth()
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description:
            'The Pago Móvil transfer confirmation (image or PDF). Max 10 MiB.',
        },
      },
    },
  })
  @ApiParam({
    name: 'orderId',
    description: 'The Order this proof is for (from the checkout response).',
  })
  @ApiOperation({
    summary: 'Upload Pago Móvil proof of payment for an Order',
    description:
      'Multipart upload gated by the one-time orderAccessToken issued at checkout (send it as "Authorization: Bearer <token>", never the cart cookie). On a valid token for THIS orderId, and while the Order is still pending_verification, the file is stored under uploads/private/ (never static-mounted, AD-12) under a server-generated name (never the client-supplied filename) and a ProofOfPayment row is created.',
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'The created ProofOfPayment (wrapped in the same status shape GET returns).',
    type: ProofOfPaymentStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "errorCode FILE_REQUIRED (no file sent) or UNSUPPORTED_FILE_TYPE (MIME type outside the allowlist) — this codebase's usual { statusCode, errorCode, message } shape. A malformed multipart request itself (e.g. more than one file) is instead rejected by @nestjs/platform-express's own multer integration before reaching this controller's code, in Nest's default { statusCode, message, error } shape (no errorCode) — see this route's own doc comment.",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode MISSING_ORDER_ACCESS_TOKEN (no Authorization header) or INVALID_ORDER_ACCESS_TOKEN (wrong token, or a token valid for a different Order) — the upload never happens.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ORDER_NOT_AWAITING_PROOF — the Order already left pending_verification (confirmed/rejected/expired/cancelled).',
  })
  @ApiResponse({
    status: HttpStatus.PAYLOAD_TOO_LARGE,
    description:
      "Exceeds the configured maximum upload size. Nest's own FileInterceptor already translates multer's LIMIT_FILE_SIZE into a typed PayloadTooLargeException before this controller's code runs, so the body is Nest's default { statusCode, message, error } shape (no errorCode) rather than this API's usual one — see this route's own doc comment.",
  })
  async upload(
    @Req() request: RequestWithOrder,
    @UploadedFile() file: Express.Multer.File | undefined,
  ): Promise<ProofOfPaymentStatusResponseDto> {
    if (!file) {
      throw fileRequiredException();
    }
    return this.proofOfPaymentService.recordUpload(request.order, file);
  }

  @Get()
  @UseGuards(OrderAccessTokenGuard)
  @ApiBearerAuth()
  @ApiParam({
    name: 'orderId',
    description: 'The Order to check (from the checkout response).',
  })
  @ApiOperation({
    summary: 'Check whether an Order has a Proof of Payment attached',
    description:
      'Story 4.2 AC3: an Order with nothing uploaded yet still returns a normal 200 (hasProofOfPayment=false, latestProofOfPayment=null) — never hidden, never an error — so "pending, no proof yet" stays distinguishable from "proof attached" for this same token-holder (and later, Admin, Story 9.2).',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: ProofOfPaymentStatusResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description:
      'errorCode MISSING_ORDER_ACCESS_TOKEN or INVALID_ORDER_ACCESS_TOKEN.',
  })
  async getStatus(
    @Req() request: RequestWithOrder,
  ): Promise<ProofOfPaymentStatusResponseDto> {
    return this.proofOfPaymentService.getStatus(request.order.id);
  }
}
