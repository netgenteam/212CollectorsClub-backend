import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CreateShippingAgencyDto,
  ShippingAgencyAdminDto,
  ShippingAgencyPublicDto,
  UpdateShippingAgencyDto,
} from './dto/shipping-agency.dto.js';
import { isValidTrackingTemplate } from './tracking-url.js';

const ADMIN_SELECT = {
  id: true,
  name: true,
  code: true,
  isActive: true,
  allowsOfficePickup: true,
  allowsHomeDelivery: true,
  trackingUrlTemplate: true,
  sortOrder: true,
} satisfies Prisma.ShippingAgencySelect;

const UPDATABLE_FIELDS = [
  'name',
  'isActive',
  'allowsOfficePickup',
  'allowsHomeDelivery',
  'trackingUrlTemplate',
  'sortOrder',
] as const;

/** Story 17.1 (AD-71, FR-82/83): agency catalog read + admin edit. */
@Injectable()
export class ShippingAgenciesService {
  constructor(private readonly prisma: PrismaService) {}

  listPublic(): Promise<ShippingAgencyPublicDto[]> {
    return this.prisma.shippingAgency.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        code: true,
        allowsOfficePickup: true,
        allowsHomeDelivery: true,
      },
    });
  }

  listAdmin(): Promise<ShippingAgencyAdminDto[]> {
    return this.prisma.shippingAgency.findMany({
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: ADMIN_SELECT,
    });
  }

  async update(
    id: string,
    dto: Readonly<UpdateShippingAgencyDto>,
  ): Promise<ShippingAgencyAdminDto> {
    const data: Prisma.ShippingAgencyUpdateInput = {};
    for (const field of UPDATABLE_FIELDS) {
      if (dto[field] !== undefined) {
        (data as Record<string, unknown>)[field] = dto[field];
      }
    }
    if (Object.keys(data).length === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'SHIPPING_AGENCY_EMPTY_UPDATE',
        'At least one field must be provided.',
      );
    }
    this.assertTemplate(dto.trackingUrlTemplate);

    return this.prisma.$transaction(async (tx) => {
      const current = await tx.shippingAgency.findUnique({
        where: { id },
        select: ADMIN_SELECT,
      });
      if (!current) throw this.notFound();
      const merged = { ...current, ...data } as ShippingAgencyAdminDto;
      this.assertHasMode(
        merged.isActive ?? true,
        merged.allowsOfficePickup,
        merged.allowsHomeDelivery,
      );
      return tx.shippingAgency.update({
        where: { id },
        data,
        select: ADMIN_SELECT,
      });
    });
  }

  async create(
    dto: Readonly<CreateShippingAgencyDto>,
  ): Promise<ShippingAgencyAdminDto> {
    this.assertTemplate(dto.trackingUrlTemplate);
    const isActive = dto.isActive ?? true;
    const allowsOfficePickup = dto.allowsOfficePickup ?? true;
    const allowsHomeDelivery = dto.allowsHomeDelivery ?? true;
    this.assertHasMode(isActive, allowsOfficePickup, allowsHomeDelivery);
    try {
      // Plain INSERT: the unique index on `code` is the atomic arbiter.
      return await this.prisma.shippingAgency.create({
        data: {
          name: dto.name,
          code: dto.code,
          isActive,
          allowsOfficePickup,
          allowsHomeDelivery,
          trackingUrlTemplate: dto.trackingUrlTemplate ?? null,
          sortOrder: dto.sortOrder ?? 0,
        },
        select: ADMIN_SELECT,
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'SHIPPING_AGENCY_CODE_TAKEN',
          'An agency with this code already exists.',
        );
      }
      throw error;
    }
  }

  /** 409 SHIPPING_AGENCY_IN_USE when any address or order references it. */
  async remove(id: string): Promise<void> {
    const inUse = (): ApiException =>
      new ApiException(
        HttpStatus.CONFLICT,
        'SHIPPING_AGENCY_IN_USE',
        'The agency is referenced by addresses or orders; deactivate it instead.',
      );
    try {
      await this.prisma.$transaction(async (tx) => {
        const exists = await tx.shippingAgency.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!exists) throw this.notFound();
        const [addresses, orders] = await Promise.all([
          tx.customerAddress.count({ where: { agencyId: id } }),
          tx.order.count({ where: { shippingAgencyId: id } }),
        ]);
        if (addresses > 0 || orders > 0) throw inUse();
        await tx.shippingAgency.delete({ where: { id } });
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        (error.code === 'P2003' || error.code === 'P2025')
      ) {
        // FK backstop (a row appeared concurrently) / vanished concurrently.
        throw error.code === 'P2003' ? inUse() : this.notFound();
      }
      throw error;
    }
  }

  private assertTemplate(template: string | null | undefined): void {
    if (typeof template === 'string' && !isValidTrackingTemplate(template)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'TRACKING_TEMPLATE_INVALID',
        'trackingUrlTemplate must start with https:// and contain exactly one {trackingNumber} marker.',
      );
    }
  }

  private assertHasMode(
    isActive: boolean,
    office: boolean,
    home: boolean,
  ): void {
    if (isActive && !office && !home) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'AGENCY_WITHOUT_DELIVERY_MODE',
        'An active agency must allow office pickup or home delivery.',
      );
    }
  }

  private notFound(): ApiException {
    return new ApiException(
      HttpStatus.NOT_FOUND,
      'SHIPPING_AGENCY_NOT_FOUND',
      'Shipping agency not found.',
    );
  }
}
