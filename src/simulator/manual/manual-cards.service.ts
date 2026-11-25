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
import { SimulatorPoolCache } from '../pool-cache.js';
import { assertReadyIfActive } from './assert-ready.js';
import { assertAuditSafeText } from './set-name.js';
import { SET_LOCK_BUDGET_MS } from './manual-sets.service.js';
import type {
  CardDto,
  CardsQueryDto,
  CreateManualCardDto,
  UpdateManualCardDto,
} from './manual-cards.dto.js';

export const DEFAULT_MAX_CARDS_PER_SET = 2000;

/** `SIMULATOR_MAX_CARDS_PER_SET` (default 2000), read per call so tests can tune it. */
export function maxCardsPerSet(): number {
  const n = Number(process.env.SIMULATOR_MAX_CARDS_PER_SET);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_CARDS_PER_SET;
}

type Admin = { id: string } | undefined;
type Tx = Prisma.TransactionClient;
type CardRow = Prisma.SimulatorCardGetPayload<object>;

export function toCardDto(row: CardRow): CardDto {
  return {
    id: row.id,
    setId: row.setId,
    name: row.name,
    rarityTier: row.rarityTier,
    number: row.number,
    imageUrl: row.imageUrl,
    marketPriceUsd: row.marketPriceUsd ? row.marketPriceUsd.toNumber() : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Audit payload of a card: ids, tier and number only. NEVER the name (AC8). */
const auditState = (r: Pick<CardRow, 'setId' | 'rarityTier' | 'number'>) =>
  payload({ setId: r.setId, rarityTier: r.rarityTier, number: r.number });

/** Free text that reaches the audit chain (number) or is stored next to it (imageUrl): 400 before the tx. */
function assertSafeFields(dto: {
  number?: string | null;
  imageUrl?: string | null;
}): void {
  if (dto.number) assertAuditSafeText('number', dto.number);
  if (dto.imageUrl) assertAuditSafeText('imageUrl', dto.imageUrl);
}

/** Prisma `contains` does not escape LIKE wildcards: `%`, `_` and `\\` must match literally. */
const escapeLike = (s: string): string => s.replace(/[\\%_]/g, '\\$&');

const priceToDb = (v: number | null | undefined) =>
  v === null || v === undefined ? null : new Prisma.Decimal(v.toFixed(2));

interface LockedSet {
  id: string;
  isActive: boolean;
}

/** Story 22.5 (AD-107, AD-108): admin CRUD of the cards of a manual set. */
@Injectable()
export class ManualCardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly poolCache: SimulatorPoolCache,
  ) {}

  async list(
    setId: string,
    q: CardsQueryDto,
  ): Promise<{
    data: CardDto[];
    meta: ReturnType<typeof buildPageMeta>;
  }> {
    if (!(await this.prisma.simulatorSet.findUnique({ where: { id: setId } })))
      this.setNotFound();
    const term = q.q?.trim();
    const where: Prisma.SimulatorCardWhereInput = {
      setId,
      ...(q.tier ? { rarityTier: q.tier } : {}),
      ...(term
        ? { name: { contains: escapeLike(term), mode: 'insensitive' } }
        : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.simulatorCard.count({ where }),
      this.prisma.simulatorCard.findMany({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
      }),
    ]);
    return {
      data: rows.map(toCardDto),
      meta: buildPageMeta(q.page, q.limit, total),
    };
  }

  async create(
    setId: string,
    dto: CreateManualCardDto,
    admin: Admin,
  ): Promise<CardDto> {
    assertSafeFields(dto);
    const max = maxCardsPerSet();
    const row = await this.run(async (tx, budget, audit) => {
      await this.lockSet(tx, budget, setId);
      const current = await tx.simulatorCard.count({ where: { setId } });
      if (current >= max)
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'SIMULATOR_SET_CARD_LIMIT',
          `A set holds at most ${max} cards.`,
          { max, current, incoming: 1 },
        );
      const number = dto.number ?? null;
      if (number !== null) await this.assertNumberFree(tx, setId, number);
      const created = await tx.simulatorCard.create({
        data: {
          setId,
          name: dto.name,
          rarityTier: dto.rarityTier,
          number,
          imageUrl: dto.imageUrl ?? null,
          marketPriceUsd: priceToDb(dto.marketPriceUsd),
        },
      });
      await this.bump(tx, setId);
      audit.add({
        ...adminActor(admin),
        action: 'SIMULATOR_CARD_CREATED',
        entityType: 'SimulatorCard',
        entityId: created.id,
        after: auditState(created),
      });
      return created;
    });
    this.poolCache.clear();
    return toCardDto(row);
  }

  async update(
    setId: string,
    cardId: string,
    dto: UpdateManualCardDto,
    admin: Admin,
  ): Promise<CardDto> {
    assertSafeFields(dto);
    const out = await this.run(async (tx, budget, audit) => {
      const set = await this.lockSet(tx, budget, setId);
      const cur = await this.findCard(tx, setId, cardId);
      const data: Prisma.SimulatorCardUpdateInput = {};
      if (dto.name !== undefined && dto.name !== cur.name) data.name = dto.name;
      const tierChange =
        dto.rarityTier !== undefined && dto.rarityTier !== cur.rarityTier;
      if (tierChange) data.rarityTier = dto.rarityTier;
      if (dto.number !== undefined && dto.number !== cur.number) {
        if (dto.number !== null)
          await this.assertNumberFree(tx, setId, dto.number, cardId);
        data.number = dto.number;
      }
      if (dto.imageUrl !== undefined && dto.imageUrl !== cur.imageUrl)
        data.imageUrl = dto.imageUrl;
      if (dto.marketPriceUsd !== undefined) {
        const next = priceToDb(dto.marketPriceUsd);
        const same =
          next === null
            ? cur.marketPriceUsd === null
            : cur.marketPriceUsd !== null && cur.marketPriceUsd.equals(next);
        if (!same) data.marketPriceUsd = next;
      }
      if (Object.keys(data).length === 0)
        return { row: cur, wrote: false as const };
      const row = await tx.simulatorCard.update({
        where: { id: cardId },
        data,
      });
      await this.bump(tx, setId);
      // A105: an active set must stay openable; only a tier move can shrink it
      if (tierChange && set.isActive) await assertReadyIfActive(tx, setId);
      audit.add({
        ...adminActor(admin),
        action: 'SIMULATOR_CARD_UPDATED',
        entityType: 'SimulatorCard',
        entityId: cardId,
        before: auditState(cur),
        after: auditState(row),
      });
      return { row, wrote: true as const };
    });
    if (out.wrote) this.poolCache.clear();
    return toCardDto(out.row);
  }

  async remove(setId: string, cardId: string, admin: Admin): Promise<void> {
    await this.run(async (tx, budget, audit) => {
      const set = await this.lockSet(tx, budget, setId);
      const cur = await this.findCard(tx, setId, cardId);
      await tx.simulatorCard.delete({ where: { id: cardId } });
      await this.bump(tx, setId);
      if (set.isActive) await assertReadyIfActive(tx, setId);
      audit.add({
        ...adminActor(admin),
        action: 'SIMULATOR_CARD_DELETED',
        entityType: 'SimulatorCard',
        entityId: cardId,
        before: auditState(cur),
      });
    });
    this.poolCache.clear();
  }

  /** First statement of every write: `SELECT … FOR UPDATE` of the set row under the lock budget. */
  private async lockSet(
    tx: Tx,
    budget: LockBudget,
    id: string,
  ): Promise<LockedSet> {
    await budget.arm();
    const rows = await tx.$queryRaw<LockedSet[]>`
      SELECT "id", "isActive" FROM "Simulator_Sets" WHERE "id" = ${id}::uuid FOR UPDATE`;
    await budget.release();
    if (!rows[0]) this.setNotFound();
    return rows[0];
  }

  private async findCard(
    tx: Tx,
    setId: string,
    cardId: string,
  ): Promise<CardRow> {
    const row = await tx.simulatorCard.findFirst({
      where: { id: cardId, setId },
    });
    if (!row)
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'SIMULATOR_CARD_NOT_FOUND',
        'Simulator card not found.',
      );
    return row;
  }

  private async assertNumberFree(
    tx: Tx,
    setId: string,
    number: string,
    exceptId?: string,
  ): Promise<void> {
    const clash = await tx.simulatorCard.findFirst({
      where: { setId, number, ...(exceptId ? { NOT: { id: exceptId } } : {}) },
      select: { id: true },
    });
    if (clash) this.numberTaken();
  }

  private bump(tx: Tx, setId: string) {
    return tx.simulatorSet.update({
      where: { id: setId },
      data: { version: { increment: 1 } },
      select: { id: true },
    });
  }

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
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      )
        this.numberTaken();
      throw err;
    }
  }

  private setNotFound(): never {
    throw new ApiException(
      HttpStatus.NOT_FOUND,
      'SIMULATOR_SET_NOT_FOUND',
      'Simulator set not found.',
    );
  }

  private numberTaken(): never {
    throw new ApiException(
      HttpStatus.CONFLICT,
      'SIMULATOR_CARD_NUMBER_TAKEN',
      'Another card of this set already uses that number.',
    );
  }
}
