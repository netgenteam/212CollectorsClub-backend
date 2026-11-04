import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { adminActor, diffPayload, payload } from '../audit/audit-events.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

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

  /** Story 20.5: `SHIPPING_AGENCY_CHANGED` in the same transaction as the edit (flushed last). */
  async update(
    id: string,
    dto: Readonly<UpdateShippingAgencyDto>,
    admin: Pick<AuthenticatedAdminUser, 'id'>,
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

    return this.audit.transaction(async (tx, audit) => {
      // Row lock: concurrent edits serialize, so each `before` is the previous `after`.
      await tx.$queryRaw`SELECT "id" FROM "Shipping_Agencies" WHERE "id" = ${id}::uuid FOR UPDATE`;
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
      const updated = await tx.shippingAgency.update({
        where: { id },
        data,
        select: ADMIN_SELECT,
      });
      const diff = diffPayload(current, updated, UPDATABLE_FIELDS);
      if (diff.changed.length > 0) {
        audit.add({
          ...adminActor(admin),
          action: 'SHIPPING_AGENCY_CHANGED',
          entityType: 'ShippingAgency',
          entityId: id,
          before: diff.before,
          after: payload({
            operation: 'UPDATE',
            code: updated.code,
            ...(diff.after as object),
          }),
        });
      }
      return updated;
    });
  }

  async create(
    dto: Readonly<CreateShippingAgencyDto>,
    admin: Pick<AuthenticatedAdminUser, 'id'>,
  ): Promise<ShippingAgencyAdminDto> {
    this.assertTemplate(dto.trackingUrlTemplate);
    const isActive = dto.isActive ?? true;
    const allowsOfficePickup = dto.allowsOfficePickup ?? true;
    const allowsHomeDelivery = dto.allowsHomeDelivery ?? true;
    this.assertHasMode(isActive, allowsOfficePickup, allowsHomeDelivery);
    try {
      // Plain INSERT: the unique index on `code` is the atomic arbiter.
      return await this.audit.transaction(async (tx, audit) => {
        const created = await tx.shippingAgency.create({
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
        audit.add({
          ...adminActor(admin),
          action: 'SHIPPING_AGENCY_CHANGED',
          entityType: 'ShippingAgency',
          entityId: created.id,
          after: payload({ operation: 'CREATE', ...created }),
        });
        return created;
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
  async remove(
    id: string,
    admin: Pick<AuthenticatedAdminUser, 'id'>,
  ): Promise<void> {
    const inUse = (): ApiException =>
      new ApiException(
        HttpStatus.CONFLICT,
        'SHIPPING_AGENCY_IN_USE',
        'The agency is referenced by addresses or orders; deactivate it instead.',
      );
    try {
      await this.audit.transaction(async (tx, audit) => {
        const exists = await tx.shippingAgency.findUnique({
          where: { id },
          select: ADMIN_SELECT,
        });
        if (!exists) throw this.notFound();
        const [addresses, orders] = await Promise.all([
          tx.customerAddress.count({ where: { agencyId: id } }),
          tx.order.count({ where: { shippingAgencyId: id } }),
        ]);
        if (addresses > 0 || orders > 0) throw inUse();
        await tx.shippingAgency.delete({ where: { id } });
        audit.add({
          ...adminActor(admin),
          action: 'SHIPPING_AGENCY_CHANGED',
          entityType: 'ShippingAgency',
          entityId: id,
          before: payload({ ...exists }),
          after: { operation: 'DELETE', code: exists.code },
        });
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
