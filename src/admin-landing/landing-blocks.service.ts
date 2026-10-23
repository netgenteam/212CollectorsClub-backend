import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  LandingBlockDetailDto,
  LandingBlockSummaryDto,
} from './dto/landing-block-response.dto.js';
import {
  LANDING_BLOCKS,
  LANDING_SECTION_HOME,
  isLandingBlock,
  type LandingBlock,
} from './landing-blocks.constants.js';
import { validateLandingBlock } from './landing-blocks.validation.js';

const BLOCK_SELECT = {
  key: true,
  value: true,
  draftValue: true,
  draftUpdatedAt: true,
  publishedAt: true,
} as const;

type BlockRow = Prisma.LandingConfigEntryGetPayload<{
  select: typeof BLOCK_SELECT;
}>;

type PublishableRow = { key: string; draftValue: Prisma.JsonValue };

const HAS_DRAFT = { draftValue: { not: Prisma.DbNull } } as const;

/**
 * Story 16.1 (FR-71, FR-74; AD-60, AD-61). Draft/publish cycle over the
 * seven `section='home'` rows of `LandingConfigEntry`. `value` is always the
 * PUBLISHED value; a draft lives in `draftValue` until it is published
 * (`value = draftValue`, draft cleared, all in one transaction) or
 * discarded. A block with a draft but never published has `value = '{}'`
 * and `publishedAt NULL` — "no published value". Last writer wins (no
 * versioning, AD-69 R-d). Legacy rows are never touched here.
 */
@Injectable()
export class LandingBlocksService {
  constructor(private readonly prisma: PrismaService) {}

  /** Always the 7 blocks, in canonical order, even if no row exists yet. */
  async listBlocks(): Promise<{ data: LandingBlockSummaryDto[] }> {
    const rows = await this.prisma.landingConfigEntry.findMany({
      where: {
        section: LANDING_SECTION_HOME,
        key: { in: [...LANDING_BLOCKS] },
      },
      select: BLOCK_SELECT,
    });
    const byKey = new Map(rows.map((r) => [r.key, r]));
    return {
      data: LANDING_BLOCKS.map((block) => {
        const row = byKey.get(block);
        return {
          block,
          hasDraft: !!row && row.draftValue !== null,
          hasPublished: !!row && row.publishedAt !== null,
          publishedAt: row?.publishedAt ?? null,
          draftUpdatedAt: row?.draftUpdatedAt ?? null,
        };
      }),
    };
  }

  async getBlock(blockParam: string): Promise<LandingBlockDetailDto> {
    const block = assertKnownBlock(blockParam);
    const row = await this.prisma.landingConfigEntry.findUnique({
      where: { section_key: { section: LANDING_SECTION_HOME, key: block } },
      select: BLOCK_SELECT,
    });
    return toDetail(block, row);
  }

  /** Saves ONLY the draft; `value`/`publishedAt` are never touched. */
  async saveDraft(
    blockParam: string,
    body: unknown,
    adminUserId: string,
  ): Promise<LandingBlockDetailDto> {
    const block = assertKnownBlock(blockParam);
    const value = await validateLandingBlock(block, body);
    if (block === 'vitrina') {
      await this.assertProductsExist(value.productIds as string[]);
    }

    const now = new Date();
    const row = await this.prisma.landingConfigEntry.upsert({
      where: { section_key: { section: LANDING_SECTION_HOME, key: block } },
      create: {
        section: LANDING_SECTION_HOME,
        key: block,
        valueType: 'json',
        value: {},
        draftValue: value as Prisma.InputJsonObject,
        draftUpdatedAt: now,
        draftUpdatedById: adminUserId,
      },
      update: {
        draftValue: value as Prisma.InputJsonObject,
        draftUpdatedAt: now,
        draftUpdatedById: adminUserId,
      },
      select: BLOCK_SELECT,
    });
    return toDetail(block, row);
  }

  /** Promotes the draft of one block. 409 `LANDING_NO_DRAFT` without one. */
  async publishBlock(
    blockParam: string,
    adminUserId: string,
  ): Promise<LandingBlockDetailDto> {
    const block = assertKnownBlock(blockParam);
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.landingConfigEntry.findUnique({
        where: { section_key: { section: LANDING_SECTION_HOME, key: block } },
        select: { key: true, draftValue: true },
      });
      if (!current || current.draftValue === null) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'LANDING_NO_DRAFT',
          `Block "${block}" has no draft to publish.`,
        );
      }
      return this.publishRow(tx, current, adminUserId);
    });
    return toDetail(block, row);
  }

  /**
   * Publishes every block that has a draft in ONE transaction: either all
   * are promoted or (on any failure) none is. No drafts -> `[]`.
   */
  async publishAll(adminUserId: string): Promise<{ published: string[] }> {
    const published = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.landingConfigEntry.findMany({
        where: { section: LANDING_SECTION_HOME, ...HAS_DRAFT },
        select: { key: true, draftValue: true },
      });
      rows.sort(
        (a, b) =>
          LANDING_BLOCKS.indexOf(a.key as LandingBlock) -
          LANDING_BLOCKS.indexOf(b.key as LandingBlock),
      );
      for (const row of rows) {
        await this.publishRow(tx, row, adminUserId);
      }
      return rows.map((r) => r.key);
    });
    return { published };
  }

  /** Idempotent: discarding when there is no draft is a no-op. */
  async discardDraft(blockParam: string): Promise<void> {
    const block = assertKnownBlock(blockParam);
    await this.prisma.landingConfigEntry.updateMany({
      where: { section: LANDING_SECTION_HOME, key: block, ...HAS_DRAFT },
      data: {
        draftValue: Prisma.DbNull,
        draftUpdatedAt: null,
        draftUpdatedById: null,
      },
    });
  }

  /** One row's promotion, shared by single and bulk publish (inside a tx). */
  protected publishRow(
    tx: Prisma.TransactionClient,
    row: PublishableRow,
    adminUserId: string,
  ): Promise<BlockRow> {
    return tx.landingConfigEntry.update({
      where: { section_key: { section: LANDING_SECTION_HOME, key: row.key } },
      data: {
        value: row.draftValue as Prisma.InputJsonValue,
        publishedAt: new Date(),
        updatedById: adminUserId,
        draftValue: Prisma.DbNull,
        draftUpdatedAt: null,
        draftUpdatedById: null,
      },
      select: BLOCK_SELECT,
    });
  }

  /** Inactive products are accepted at save time; only non-existent ids fail. */
  private async assertProductsExist(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const found = await this.prisma.product.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const foundIds = new Set(found.map((p) => p.id));
    const missing = ids.filter((id) => !foundIds.has(id));
    if (missing.length > 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LANDING_PRODUCT_NOT_FOUND',
        `Some productIds do not exist: ${missing.join(', ')}.`,
        { ids: missing },
      );
    }
  }
}

function assertKnownBlock(block: string): LandingBlock {
  if (!isLandingBlock(block)) {
    throw new ApiException(
      HttpStatus.NOT_FOUND,
      'LANDING_BLOCK_UNKNOWN',
      `"${block}" is not a landing block. Known blocks: ${LANDING_BLOCKS.join(', ')}.`,
    );
  }
  return block;
}

function toDetail(
  block: LandingBlock,
  row: BlockRow | null,
): LandingBlockDetailDto {
  return {
    block,
    published:
      row && row.publishedAt !== null
        ? (row.value as Record<string, unknown>)
        : null,
    draft: row?.draftValue ? (row.draftValue as Record<string, unknown>) : null,
    publishedAt: row?.publishedAt ?? null,
    draftUpdatedAt: row?.draftUpdatedAt ?? null,
  };
}
