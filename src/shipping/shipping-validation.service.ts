import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma, ShippingAgency } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { DeliveryModeWire } from './shipping-validators.js';

/** Story 17.2 (AD-71): agency/mode check shared by the address book and checkout. */
@Injectable()
export class ShippingValidationService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAgencyUsable(
    agencyId: string,
    mode: DeliveryModeWire,
    opts: { requireActive: boolean },
    tx?: Prisma.TransactionClient,
  ): Promise<ShippingAgency> {
    const db = tx ?? this.prisma;
    const agency = await db.shippingAgency.findUnique({
      where: { id: agencyId },
    });
    if (!agency || (opts.requireActive && !agency.isActive)) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'SHIPPING_AGENCY_UNAVAILABLE',
        'The shipping agency does not exist or is not available.',
      );
    }
    const allowed =
      mode === 'home_delivery'
        ? agency.allowsHomeDelivery
        : agency.allowsOfficePickup;
    if (!allowed) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'DELIVERY_MODE_NOT_ALLOWED',
        'The agency does not offer this delivery mode.',
        { agencyCode: agency.code, deliveryMode: mode },
      );
    }
    return agency;
  }
}
