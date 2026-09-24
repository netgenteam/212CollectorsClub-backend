import { HttpStatus, Injectable } from '@nestjs/common';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ApiException } from '../common/api-exception.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import type { Order, ProofOfPayment } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PROOF_OF_PAYMENT_SUBDIR } from './upload-paths.constants.js';
import {
  ProofOfPaymentDto,
  ProofOfPaymentStatusResponseDto,
} from './dto/proof-of-payment-response.dto.js';

function orderNotAwaitingProofException(
  currentStatus: OrderStatus,
): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'ORDER_NOT_AWAITING_PROOF',
    `This Order is in status "${currentStatus.toLowerCase()}" and can no longer accept a Proof-of-Payment upload — only an Order still "pending_verification" can.`,
  );
}

@Injectable()
export class ProofOfPaymentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 4.2's own open question ("¿qué pasa si la Order ya no está en un
   * estado donde tenga sentido subir comprobante?", not a fixed AC):
   * resolved here as **reject**, not silently accept. `PENDING_VERIFICATION`
   * is the only status a Pago Móvil Order sits in before Admin's Story 9.2
   * confirm/reject (AD-7's state machine) — once it has moved on (`PAID`,
   * `PAYMENT_REJECTED`, `EXPIRED`, `CANCELLED`, `FULFILLED`; `PAYMENT_FAILED`/
   * `PAYMENT_PROCESSING` never apply to a Pago Móvil Order at all, Story
   * 4.1), the decision has already been made or the hold has already
   * lapsed — accepting a further upload would let a buyer keep filing
   * "evidence" against an Order admin will never look at again, or pile up
   * files with no reviewer. Rejecting with 409 (this codebase's existing
   * convention for a business-state conflict, e.g. `INSUFFICIENT_STOCK`)
   * is more informative to the buyer than a generic error, and cheap to
   * relax later if product wants otherwise.
   *
   * By the time this runs, multer's `FileInterceptor` has already written
   * `file` to disk (interceptors run before the handler) — so a rejection
   * here also deletes that now-orphaned file (best-effort; a failed
   * cleanup is logged-and-swallowed, never surfaced as a 500 on top of the
   * 409 the caller already gets) and creates no `ProofOfPayment` row.
   */
  async recordUpload(
    order: Order,
    file: Express.Multer.File,
  ): Promise<ProofOfPaymentStatusResponseDto> {
    if (order.status !== OrderStatus.PENDING_VERIFICATION) {
      await unlink(file.path).catch(() => undefined);
      throw orderNotAwaitingProofException(order.status);
    }

    // Relative to `uploads/private/` (AD-12's DB convention — never an
    // absolute path, never a public URL). `file.filename` is the
    // server-generated UUID+extension name `proof-of-payment-multer.config`
    // chose; `file.originalname` (client input) is never read here either.
    const relativePath = join(PROOF_OF_PAYMENT_SUBDIR, file.filename);

    const created = await this.prisma.proofOfPayment.create({
      data: {
        orderId: order.id,
        filePath: relativePath,
        mimeType: file.mimetype,
        sizeBytes: file.size,
      },
    });

    return {
      hasProofOfPayment: true,
      latestProofOfPayment: this.toDto(created),
    };
  }

  /** Story 4.2 AC3: always a normal 200-shaped answer, even when the Order
   * has nothing uploaded yet — see `ProofOfPaymentStatusResponseDto`. */
  async getStatus(orderId: string): Promise<ProofOfPaymentStatusResponseDto> {
    const latest = await this.prisma.proofOfPayment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });

    return {
      hasProofOfPayment: latest !== null,
      latestProofOfPayment: latest ? this.toDto(latest) : null,
    };
  }

  private toDto(row: ProofOfPayment): ProofOfPaymentDto {
    return {
      id: row.id,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
