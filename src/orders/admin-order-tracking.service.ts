import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiException } from '../common/api-exception.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';
import { buildTrackingUrl } from '../shipping/tracking-url.js';
import {
  AdminOrderTrackingResponseDto,
  UpdateOrderTrackingDto,
} from './dto/admin-order-tracking.dto.js';

const TRACKING_NUMBER_PATTERN = /^[A-Za-z0-9._/-]{3,64}$/;

/**
 * Story 17.5 (FR-89, A53; AD-76). Manual tracking-number capture. Works in
 * any order status; never touches the status machine nor sends email. Every
 * effective change writes an `OrderTrackingEvent` in the same transaction.
 */
@Injectable()
export class AdminOrderTrackingService {
  constructor(private readonly prisma: PrismaService) {}

  async setTracking(
    orderId: string,
    dto: Readonly<UpdateOrderTrackingDto>,
    admin: AuthenticatedAdminUser,
  ): Promise<AdminOrderTrackingResponseDto> {
    const next = this.normalize(dto.trackingNumber);

    return this.prisma.$transaction(async (tx) => {
      // Serialize concurrent PATCHes on the same order so previousValue and
      // the no-change check always see the latest committed value.
      await tx.$queryRaw`SELECT id FROM "Orders" WHERE id = ${orderId}::uuid FOR UPDATE`;
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          trackingNumber: true,
          shippingAgency: { select: { trackingUrlTemplate: true } },
        },
      });
      if (!order) {
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'ORDER_NOT_FOUND',
          `No Order exists with id "${orderId}".`,
        );
      }

      if (order.trackingNumber !== next) {
        await tx.order.update({
          where: { id: orderId },
          data: { trackingNumber: next },
        });
        await tx.orderTrackingEvent.create({
          data: {
            orderId,
            adminUserId: admin.id,
            previousValue: order.trackingNumber,
            newValue: next,
          },
        });
      }

      return {
        orderId,
        trackingNumber: next,
        trackingUrl: buildTrackingUrl(
          order.shippingAgency?.trackingUrlTemplate,
          next,
        ),
      };
    });
  }

  private normalize(raw: unknown): string | null {
    if (raw === null) return null;
    if (typeof raw === 'string') {
      const value = raw.trim();
      if (value === '') return null;
      if (TRACKING_NUMBER_PATTERN.test(value)) return value;
    }
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'TRACKING_NUMBER_INVALID',
      'trackingNumber must be null or 3-64 characters of letters, digits, ".", "_", "/" or "-".',
    );
  }
}
