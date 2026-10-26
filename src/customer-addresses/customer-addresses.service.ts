import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShippingValidationService } from '../shipping/shipping-validation.service.js';
import { validateShippingInput } from '../shipping/shipping-validators.js';
import type { CustomerAddressResponseDto } from './dto/customer-address-response.dto.js';
import type { CreateCustomerAddressDto } from './dto/create-customer-address.dto.js';

export const MAX_ADDRESSES = 10;

const WITH_AGENCY = {
  agency: {
    select: {
      id: true,
      name: true,
      code: true,
      isActive: true,
      allowsOfficePickup: true,
      allowsHomeDelivery: true,
    },
  },
} satisfies Prisma.CustomerAddressInclude;

type AddressRow = Prisma.CustomerAddressGetPayload<{
  include: typeof WITH_AGENCY;
}>;

export function toAddressResponse(row: AddressRow): CustomerAddressResponseDto {
  return {
    id: row.id,
    label: row.label,
    recipientName: row.recipientName,
    recipientPhone: row.recipientPhone,
    recipientIdDoc: row.recipientIdDoc,
    deliveryMode: row.deliveryMode.toLowerCase(),
    agency: row.agency,
    agencyBranchName: row.agencyBranchName,
    agencyBranchCode: row.agencyBranchCode,
    state: row.state,
    municipality: row.municipality,
    parish: row.parish,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    referencePoint: row.referencePoint,
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Story 17.2 (AD-72/73): address book list + create. */
@Injectable()
export class CustomerAddressesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly shipping: ShippingValidationService,
  ) {}

  async list(customerId: string): Promise<CustomerAddressResponseDto[]> {
    const rows = await this.prisma.customerAddress.findMany({
      where: { customerId },
      include: WITH_AGENCY,
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    });
    return rows.map(toAddressResponse);
  }

  async create(
    customerId: string,
    dto: CreateCustomerAddressDto,
  ): Promise<CustomerAddressResponseDto> {
    const checked = validateShippingInput(dto);
    if (checked.errors) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'SHIPPING_INVALID',
        'The shipping data is invalid.',
        { errors: checked.errors },
      );
    }
    const value = checked.value;
    const label = dto.label?.trim() || null;

    const attempt = () =>
      this.prisma.$transaction(async (tx) => {
        // AD-73: serialise per customer (count cap + first-is-default).
        await tx.$queryRaw`SELECT id FROM "Customers" WHERE id = ${customerId}::uuid FOR UPDATE`;
        const count = await tx.customerAddress.count({ where: { customerId } });
        if (count >= MAX_ADDRESSES) {
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'ADDRESS_LIMIT_REACHED',
            `An address book holds at most ${MAX_ADDRESSES} addresses.`,
          );
        }
        await this.shipping.assertAgencyUsable(
          dto.agencyId,
          value.deliveryMode,
          { requireActive: true },
          tx,
        );
        return tx.customerAddress.create({
          data: {
            customerId,
            agencyId: dto.agencyId,
            label,
            ...value,
            deliveryMode:
              value.deliveryMode === 'home_delivery'
                ? 'HOME_DELIVERY'
                : 'AGENCY_OFFICE',
            isDefault: count === 0,
          },
          include: WITH_AGENCY,
        });
      });

    const isP2002 = (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
    try {
      return toAddressResponse(await attempt());
    } catch (first) {
      if (!isP2002(first)) throw first;
      try {
        return toAddressResponse(await attempt());
      } catch (second) {
        if (!isP2002(second)) throw second;
        throw new ApiException(
          HttpStatus.CONFLICT,
          'ADDRESS_DEFAULT_CONFLICT',
          'Could not save the address, please retry.',
        );
      }
    }
  }
}
