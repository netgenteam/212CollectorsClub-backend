import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { buildPageMeta } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  UpdateVitrinaAlgorithmDto,
  UpdateVitrinaAlgorithmResponseDto,
  VitrinaAlgorithmResponseDto,
  VitrinaAuditQueryDto,
  VitrinaAuditResponseDto,
  VitrinaPreviewQueryDto,
  VitrinaPreviewResponseDto,
  VitrinaRecomputeStatusDto,
  VitrinaRunSummaryDto,
} from './dto/admin-vitrina.dto.js';
import {
  lockSetting,
  toScoringConfig,
  VITRINA_SETTING_ID,
} from './vitrina-settings.js';
import type { SettingRow } from './vitrina-settings.js';
import {
  TX_TIMEOUT_MS,
  VitrinaScoringService,
} from './vitrina-scoring.service.js';
import type { RecomputeRun } from './vitrina-scoring.service.js';
import { VitrinaSelectionService } from './vitrina-selection.service.js';

const WEIGHT_KEYS = [
  'wSales',
  'wRevenue',
  'wVelocity',
  'wInterest',
  'wNovelty',
] as const;

/** Prisma P2028: interactive transaction timed out / could not start. */
const isTxTimeout = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2028';

export const toRunSummary = (r: RecomputeRun): VitrinaRunSummaryDto => ({
  runId: r.runId,
  computedAt: r.computedAt.toISOString(),
  mode: r.mode,
  salesCount: r.salesCount,
});

/** Story 18.8 (AD-84 "Admin", FR-99/100). */
@Injectable()
export class AdminVitrinaService {
  private readonly logger = new Logger(AdminVitrinaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scoring: VitrinaScoringService,
    private readonly selection: VitrinaSelectionService,
  ) {}

  async getAlgorithm(): Promise<VitrinaAlgorithmResponseDto> {
    // Lock-free read (no FOR UPDATE): never waits behind a long recompute/PUT.
    const row = await this.prisma.$transaction((tx) => lockSetting(tx, false));
    return this.toResponse(row);
  }

  async updateAlgorithm(
    dto: UpdateVitrinaAlgorithmDto,
    adminUserId: string,
  ): Promise<UpdateVitrinaAlgorithmResponseDto> {
    const sum = WEIGHT_KEYS.reduce((acc, k) => acc + dto[k], 0);
    if (sum !== 100) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'VITRINA_WEIGHTS_INVALID',
        `The five weights must add up to exactly 100 (got ${sum}).`,
        { sum },
      );
    }

    try {
      await this.prisma.$transaction(
        async (tx) => {
          // FOR UPDATE: concurrent PUTs queue here, so each audit's `before` is
          // exactly the previous audit's `after` (a coherent chain).
          const current = await lockSetting(tx);
          const before = toScoringConfig(current);
          const after = {
            ...before,
            wSales: dto.wSales,
            wRevenue: dto.wRevenue,
            wVelocity: dto.wVelocity,
            wInterest: dto.wInterest,
            wNovelty: dto.wNovelty,
            halfLifeDays: dto.halfLifeDays ?? before.halfLifeDays,
            windowDays: dto.windowDays ?? before.windowDays,
            noveltyDays: dto.noveltyDays ?? before.noveltyDays,
            maxPerFranchise: dto.maxPerFranchise ?? before.maxPerFranchise,
            mmrLambda: dto.mmrLambda ?? before.mmrLambda,
            priorM: dto.priorM ?? before.priorM,
          };
          if (after.windowDays < after.halfLifeDays) {
            throw new ApiException(
              HttpStatus.BAD_REQUEST,
              'VITRINA_PARAMS_INVALID',
              'windowDays must be greater than or equal to halfLifeDays.',
              {
                windowDays: after.windowDays,
                halfLifeDays: after.halfLifeDays,
              },
            );
          }
          await tx.vitrinaAlgorithmSetting.update({
            where: { id: VITRINA_SETTING_ID },
            data: {
              wSales: after.wSales,
              wRevenue: after.wRevenue,
              wVelocity: after.wVelocity,
              wInterest: after.wInterest,
              wNovelty: after.wNovelty,
              halfLifeDays: after.halfLifeDays,
              windowDays: after.windowDays,
              noveltyDays: after.noveltyDays,
              maxPerFranchise: after.maxPerFranchise,
              mmrLambda: new Prisma.Decimal(after.mmrLambda),
              priorM: new Prisma.Decimal(after.priorM),
              updatedById: adminUserId,
            },
          });
          await tx.vitrinaAlgorithmAudit.create({
            data: {
              adminUserId,
              before: before as unknown as Prisma.InputJsonObject,
              after: after,
            },
          });
        },
        // FOR UPDATE can queue behind a long recompute (up to TX_TIMEOUT_MS):
        // same budget as the recompute, not Prisma's 5 s default.
        { maxWait: TX_TIMEOUT_MS, timeout: TX_TIMEOUT_MS },
      );
    } catch (err) {
      if (isTxTimeout(err)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'VITRINA_BUSY',
          'The algorithm settings are locked by a running recompute; try again in a moment.',
        );
      }
      throw err;
    }

    // Optional recompute AFTER the save has committed: it can neither undo
    // the settings nor extend the PUT lock.
    let recompute: VitrinaRecomputeStatusDto = {
      status: 'NOT_REQUESTED',
      run: null,
    };
    if (dto.recompute === true) {
      try {
        const r = await this.scoring.recompute('ADMIN');
        recompute =
          r.status === 'OK'
            ? { status: 'DONE', run: toRunSummary(r) }
            : { status: 'IN_PROGRESS', run: null };
      } catch {
        this.logger.warn('Optional recompute after PUT algorithm failed.');
        recompute = { status: 'FAILED', run: null };
      }
    }
    const row = await this.prisma.$transaction((tx) => lockSetting(tx, false));
    return { ...(await this.toResponse(row)), recompute };
  }

  async audit(q: VitrinaAuditQueryDto): Promise<VitrinaAuditResponseDto> {
    const [total, rows] = await Promise.all([
      this.prisma.vitrinaAlgorithmAudit.count(),
      this.prisma.vitrinaAlgorithmAudit.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { adminUser: { select: { id: true, email: true } } },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        admin: r.adminUser
          ? { id: r.adminUser.id, email: r.adminUser.email }
          : null,
        before: r.before as Record<string, unknown>,
        after: r.after as Record<string, unknown>,
      })),
      meta: buildPageMeta(q.page, q.limit, total),
    };
  }

  async preview(q: VitrinaPreviewQueryDto): Promise<VitrinaPreviewResponseDto> {
    const r = await this.selection.resolve({
      mode: q.mode,
      size: q.size,
      pinned: q.pinned,
    });
    return {
      computedAt: r.computedAt?.toISOString() ?? null,
      runMode: r.runMode,
      runId: r.runId,
      items: r.items.map((i) => ({
        productId: i.productId,
        name: i.name,
        source: i.source,
        rank: i.rank,
        score: i.score,
        reason: i.reason,
        components: i.components as Record<string, unknown> | null,
      })),
    };
  }

  private async toResponse(
    r: SettingRow,
  ): Promise<VitrinaAlgorithmResponseDto> {
    const c = toScoringConfig(r);
    let lastRun: VitrinaRunSummaryDto | null = null;
    if (r.currentRunId) {
      const run = await this.prisma.productScoreRun.findUnique({
        where: { id: r.currentRunId },
      });
      if (run) {
        lastRun = {
          runId: run.id,
          computedAt: run.computedAt.toISOString(),
          mode: run.mode,
          salesCount: run.salesCount,
        };
      }
    }
    return {
      ...c,
      currentRunId: r.currentRunId,
      lastRun,
      updatedAt: r.updatedAt.toISOString(),
      updatedById: r.updatedById,
    };
  }
}
