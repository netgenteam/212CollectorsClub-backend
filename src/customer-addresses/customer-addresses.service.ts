import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ShippingValidationService } from '../shipping/shipping-validation.service.js';
import {
  validateShippingInput,
  type ShippingInput,
} from '../shipping/shipping-validators.js';
import type { CustomerAddressResponseDto } from './dto/customer-address-response.dto.js';
import type { UpdateCustomerAddressDto } from './dto/update-customer-address.dto.js';
import type { CreateCustomerAddressDto } from './dto/create-customer-address.dto.js';

export const MAX_ADDRESSES = 10;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const toDbMode = (m: string) =>
  m === 'home_delivery'
    ? ('HOME_DELIVERY' as const)
    : ('AGENCY_OFFICE' as const);

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

    return toAddressResponse(
      await this.runLocked(customerId, async (tx) => {
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
            deliveryMode: toDbMode(value.deliveryMode),
            isDefault: count === 0,
          },
          include: WITH_AGENCY,
        });
      }),
    );
  }

  /**
   * AD-73: runs `fn` in a transaction holding a row lock on the Customer, so
   * address-book mutations of one customer are serialised. A P2002 from the
   * partial unique index (one default) is retried once, then 409.
   */
  private async runLocked<T>(
    customerId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const attempt = () =>
      this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Customers" WHERE id = ${customerId}::uuid FOR UPDATE`;
        return fn(tx);
      });
    const isP2002 = (e: unknown) =>
      e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
    try {
      return await attempt();
    } catch (first) {
      if (!isP2002(first)) throw first;
      try {
        return await attempt();
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

  private async findOwned(
    tx: Prisma.TransactionClient,
    customerId: string,
    id: string,
  ) {
    // Non-uuid ids must be a 404, not a Postgres cast error / 400.
    const row = UUID_RE.test(id)
      ? await tx.customerAddress.findFirst({ where: { id, customerId } })
      : null;
    if (!row) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'ADDRESS_NOT_FOUND',
        'Address not found.',
      );
    }
    return row;
  }

  async update(
    customerId: string,
    id: string,
    dto: UpdateCustomerAddressDto,
  ): Promise<CustomerAddressResponseDto> {
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as UpdateCustomerAddressDto;
    if (Object.keys(patch).length === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'EMPTY_UPDATE',
        'At least one field is required.',
      );
    }
    return toAddressResponse(
      await this.runLocked(customerId, async (tx) => {
        const row = await this.findOwned(tx, customerId, id);
        const merged = {
          recipientName: row.recipientName,
          recipientPhone: row.recipientPhone,
          recipientIdDoc: row.recipientIdDoc,
          deliveryMode: row.deliveryMode.toLowerCase(),
          agencyBranchName: row.agencyBranchName,
          agencyBranchCode: row.agencyBranchCode,
          state: row.state,
          municipality: row.municipality,
          parish: row.parish,
          addressLine1: row.addressLine1,
          addressLine2: row.addressLine2,
          referencePoint: row.referencePoint,
          ...patch,
        } as ShippingInput;
        const checked = validateShippingInput(merged);
        if (checked.errors) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            'SHIPPING_INVALID',
            'The shipping data is invalid.',
            { errors: checked.errors },
          );
        }
        const value = checked.value;
        // A52: activity only matters when the agency is being (re)chosen.
        await this.shipping.assertAgencyUsable(
          patch.agencyId ?? row.agencyId,
          value.deliveryMode,
          { requireActive: patch.agencyId !== undefined },
          tx,
        );
        return tx.customerAddress.update({
          where: { id },
          data: {
            agencyId: patch.agencyId ?? row.agencyId,
            label: 'label' in patch ? patch.label?.trim() || null : row.label,
            ...value,
            deliveryMode: toDbMode(value.deliveryMode),
          },
          include: WITH_AGENCY,
        });
      }),
    );
  }

  async setDefault(
    customerId: string,
    id: string,
  ): Promise<CustomerAddressResponseDto> {
    return toAddressResponse(
      await this.runLocked(customerId, async (tx) => {
        const row = await this.findOwned(tx, customerId, id);
        if (!row.isDefault) {
          await tx.customerAddress.updateMany({
            where: { customerId, isDefault: true },
            data: { isDefault: false },
          });
          await tx.customerAddress.update({
            where: { id },
            data: { isDefault: true },
          });
        }
        return tx.customerAddress.findUniqueOrThrow({
          where: { id },
          include: WITH_AGENCY,
        });
      }),
    );
  }

  async remove(customerId: string, id: string): Promise<void> {
    await this.runLocked(customerId, async (tx) => {
      const row = await this.findOwned(tx, customerId, id);
      await tx.customerAddress.delete({ where: { id } });
      if (row.isDefault) {
        const next = await tx.customerAddress.findFirst({
          where: { customerId },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        if (next) {
          await tx.customerAddress.update({
            where: { id: next.id },
            data: { isDefault: true },
          });
        }
      }
    });
  }
}
