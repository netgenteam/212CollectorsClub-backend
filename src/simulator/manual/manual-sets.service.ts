import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/api-exception.js';
import {
  isLockWaitExpired,
  lockedTxOptions,
  LockBudget,
} from '../../common/lock-timeout.js';
import { buildPageMeta } from '../../common/pagination.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../../audit/audit.service.js';
import type { AuditCollector } from '../../audit/audit.service.js';
import { adminActor, payload } from '../../audit/audit-events.js';
import { PACK_TIERS, type PackTier } from '../pack-tiers.js';
import { SimulatorPoolCache } from '../pool-cache.js';
import { defaultPokemonTemplate } from '../simulator-defaults.js';
import { checkOddsSum, parseTemplate } from '../simulator-config.validation.js';
import { assertReadyIfActive, countCardsByTier } from './assert-ready.js';
import { evaluateReadiness, type TierCounts } from './readiness.js';
import { assertAuditSafeText, normalizeSetName } from './set-name.js';
import type {
  CreateManualSetDto,
  ManualSetsQueryDto,
  SetDto,
  UpdateManualSetDto,
} from './manual-sets.dto.js';

export { assertReadyIfActive } from './assert-ready.js';

/** Bounded wait for the set row lock / the global set-count lock (AC6). */
export const SET_LOCK_BUDGET_MS = 5_000;
export const DEFAULT_MAX_SETS = 50;

/** `SIMULATOR_MAX_SETS` (default 50), read per call so it can be tuned without a restart in tests. */
export function maxSets(): number {
  const n = Number(process.env.SIMULATOR_MAX_SETS);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_SETS;
}

type Admin = { id: string } | undefined;
type Tx = Prisma.TransactionClient;

interface SetRow {
  id: string;
  name: string;
  imageUrl: string | null;
  isActive: boolean;
  template: Prisma.JsonValue;
  createdAt: Date;
  updatedAt: Date;
}

const sum = (c: TierCounts): number =>
  PACK_TIERS.reduce((a, t) => a + (c[t] ?? 0), 0);

/** Key-order independent JSON, to tell whether a template really changed. */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(v) ?? 'null';
}

/** Validates a template exactly like the legacy config does (400 CONFIG_INVALID / ODDS_INVALID_SUM). */
function parseValidTemplate(raw: unknown) {
  const t = parseTemplate(raw, 'template');
  checkOddsSum(t, 'template');
  return t;
}

export function toSetDto(row: SetRow, counts: TierCounts): SetDto {
  const byTier = Object.fromEntries(
    PACK_TIERS.map((t) => [t, counts[t] ?? 0]),
  ) as Record<PackTier, number>;
  const r = evaluateReadiness(row.template, counts);
  return {
    id: row.id,
    name: row.name,
    imageUrl: row.imageUrl,
    isActive: row.isActive,
    template: row.template,
    cardCount: sum(counts),
    cardCountByTier: byTier,
    readiness: {
      ready: r.ready,
      missing: r.missing,
      ...(r.reason ? { reason: r.reason } : {}),
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const isNameKeyConflict = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

interface Outcome {
  row: SetRow;
  counts: TierCounts;
  wrote: boolean;
}

/** Story 22.4 (AD-107, AD-108): admin CRUD of manual simulator sets. */
@Injectable()
export class ManualSetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly poolCache: SimulatorPoolCache,
  ) {}

  async list(
    q: ManualSetsQueryDto,
  ): Promise<{ data: SetDto[]; meta: ReturnType<typeof buildPageMeta> }> {
    const where: Prisma.SimulatorSetWhereInput = {
      ...(q.active !== undefined ? { isActive: q.active } : {}),
      ...(q.q?.trim()
        ? { name: { contains: q.q.trim(), mode: 'insensitive' } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.simulatorSet.count({ where }),
      this.prisma.simulatorSet.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    // ONE aggregated query for the whole page (AC2)
    const counts = await countCardsByTier(
      this.prisma,
      rows.map((r) => r.id),
    );
    return {
      data: rows.map((r) => toSetDto(r, counts.get(r.id) ?? {})),
      meta: buildPageMeta(q.page, q.limit, total),
    };
  }

  async get(id: string): Promise<SetDto> {
    const row = await this.prisma.simulatorSet.findUnique({ where: { id } });
    if (!row) this.notFound();
    const counts = await countCardsByTier(this.prisma, [id]);
    return toSetDto(row, counts.get(id) ?? {});
  }

  async create(dto: CreateManualSetDto, admin: Admin): Promise<SetDto> {
    const { name, nameKey } = normalizeSetName(dto.name);
    if (dto.imageUrl) assertAuditSafeText('imageUrl', dto.imageUrl);
    const template =
      dto.template === undefined
        ? defaultPokemonTemplate() // materialized copy: a future default change never alters this set
        : parseValidTemplate(dto.template);
    const limit = maxSets();
    const out = await this.run<Outcome>(async (tx, budget, audit) => {
      await budget.arm();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('sim:sets'))`;
      await budget.release();
      if ((await tx.simulatorSet.count()) >= limit)
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'SIMULATOR_SET_LIMIT',
          `At most ${limit} simulator sets are allowed.`,
          { max: limit },
        );
      if (await tx.simulatorSet.findUnique({ where: { nameKey } }))
        this.nameTaken();
      const row = await tx.simulatorSet.create({
        data: {
          name,
          nameKey,
          imageUrl: dto.imageUrl ?? null,
          template: template as unknown as Prisma.InputJsonValue,
        },
      });
      audit.add({
        ...adminActor(admin),
        action: 'SIMULATOR_SET_CREATED',
        entityType: 'SimulatorSet',
        entityId: row.id,
        after: payload({ name: row.name, isActive: false, cardCount: 0 }),
      });
      return { row, counts: {}, wrote: true };
    });
    this.poolCache.clear();
    return toSetDto(out.row, out.counts);
  }

  async update(
    id: string,
    dto: UpdateManualSetDto,
    admin: Admin,
  ): Promise<SetDto> {
    const nameN =
      dto.name !== undefined ? normalizeSetName(dto.name) : undefined;
    if (dto.imageUrl) assertAuditSafeText('imageUrl', dto.imageUrl);
    const template =
      dto.template !== undefined ? parseValidTemplate(dto.template) : undefined;
    const out = await this.run<Outcome>(async (tx, budget, audit) => {
      const cur = await this.lockSet(tx, budget, id);
      const data: Prisma.SimulatorSetUpdateInput = {};
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};

      if (nameN && nameN.name !== cur.name) {
        const clash = await tx.simulatorSet.findFirst({
          where: { nameKey: nameN.nameKey, NOT: { id } },
          select: { id: true },
        });
        if (clash) this.nameTaken();
        data.name = nameN.name;
        data.nameKey = nameN.nameKey;
        before.name = cur.name;
        after.name = nameN.name;
      }
      if (
        dto.imageUrl !== undefined &&
        (dto.imageUrl ?? null) !== cur.imageUrl
      ) {
        data.imageUrl = dto.imageUrl ?? null;
        before.imageUrl = cur.imageUrl;
        after.imageUrl = dto.imageUrl ?? null;
      }
      if (template && stableJson(template) !== stableJson(cur.template)) {
        data.template = template as unknown as Prisma.InputJsonValue;
        before.template = JSON.stringify(cur.template);
        after.template = JSON.stringify(template);
      }
      const activeChange =
        dto.isActive !== undefined && dto.isActive !== cur.isActive;
      if (activeChange) data.isActive = dto.isActive;

      if (Object.keys(data).length === 0) {
        // idempotent / empty PATCH: no write, no event, no version bump
        const counts = (await countCardsByTier(tx, [id])).get(id) ?? {};
        return { row: cur, counts, wrote: false };
      }
      const row = await tx.simulatorSet.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      });
      // A105: an active set that stops being ready is rejected, never silently deactivated
      await assertReadyIfActive(tx, id);
      const counts = (await countCardsByTier(tx, [id])).get(id) ?? {};
      const state = {
        name: row.name,
        isActive: row.isActive,
        cardCount: sum(counts),
      };
      const actor = adminActor(admin);
      if (Object.keys(before).length > 0)
        audit.add({
          ...actor,
          action: 'SIMULATOR_SET_UPDATED',
          entityType: 'SimulatorSet',
          entityId: id,
          before: payload(before),
          after: payload(after),
        });
      if (activeChange)
        audit.add({
          ...actor,
          action: row.isActive
            ? 'SIMULATOR_SET_ACTIVATED'
            : 'SIMULATOR_SET_DEACTIVATED',
          entityType: 'SimulatorSet',
          entityId: id,
          before: payload({ isActive: cur.isActive }),
          after: payload(state),
        });
      return { row, counts, wrote: true };
    });
    if (out.wrote) this.poolCache.clear();
    return toSetDto(out.row, out.counts);
  }

  async remove(id: string, admin: Admin): Promise<void> {
    await this.run<void>(async (tx, budget, audit) => {
      const cur = await this.lockSet(tx, budget, id);
      if (cur.isActive)
        throw new ApiException(
          HttpStatus.CONFLICT,
          'SIMULATOR_SET_ACTIVE',
          'An active set cannot be deleted; deactivate it first.',
        );
      const counts = (await countCardsByTier(tx, [id])).get(id) ?? {};
      await tx.simulatorSet.delete({ where: { id } }); // cards cascade (FK)
      audit.add({
        ...adminActor(admin),
        action: 'SIMULATOR_SET_DELETED',
        entityType: 'SimulatorSet',
        entityId: id,
        before: payload({
          name: cur.name,
          isActive: false,
          cardCount: sum(counts),
        }),
      });
    });
    this.poolCache.clear();
  }

  /** `SELECT … FOR UPDATE` of the set row under the lock budget (first lock of the tx, AC6). */
  private async lockSet(
    tx: Tx,
    budget: LockBudget,
    id: string,
  ): Promise<SetRow> {
    await budget.arm();
    const rows = await tx.$queryRaw<SetRow[]>`
      SELECT "id", "name", "imageUrl", "isActive", "template", "createdAt", "updatedAt"
      FROM "Simulator_Sets" WHERE "id" = ${id}::uuid FOR UPDATE`;
    await budget.release();
    if (!rows[0]) this.notFound();
    return rows[0];
  }

  /** Audited transaction with a bounded lock budget; maps the expiry and a name race to 409. */
  private async run<T>(
    fn: (tx: Tx, budget: LockBudget, audit: AuditCollector) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.audit.transaction(
        (tx, audit) => fn(tx, new LockBudget(tx, SET_LOCK_BUDGET_MS), audit),
        { ...lockedTxOptions(SET_LOCK_BUDGET_MS), onTimeout: 'rethrow' },
      );
    } catch (err) {
      if (isLockWaitExpired(err))
        throw new ApiException(
          HttpStatus.CONFLICT,
          'SIMULATOR_SET_BUSY',
          'The set is being modified by another request; retry shortly.',
        );
      if (isNameKeyConflict(err)) this.nameTaken();
      throw err;
    }
  }

  private notFound(): never {
    throw new ApiException(
      HttpStatus.NOT_FOUND,
      'SIMULATOR_SET_NOT_FOUND',
      'Simulator set not found.',
    );
  }

  private nameTaken(): never {
    throw new ApiException(
      HttpStatus.CONFLICT,
      'SIMULATOR_SET_NAME_TAKEN',
      'A simulator set with that name already exists.',
    );
  }
}
