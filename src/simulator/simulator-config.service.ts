import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LANDING_SECTION_PACK_SIMULATOR } from '../admin-landing/landing-content.constants.js';
import { SimulatorPoolCache } from './pool-cache.js';
import { parseSimulatorConfig } from './simulator-config.validation.js';
import {
  defaultSimulatorConfig,
  type SimulatorConfig,
} from './simulator-defaults.js';

export const SIMULATOR_CONFIG_KEY = 'config';

@Injectable()
export class SimulatorConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly poolCache: SimulatorPoolCache,
  ) {}

  /** Effective config: the stored one, or the defaults when absent/corrupt. */
  async getEffective(): Promise<SimulatorConfig> {
    const row = await this.prisma.landingConfigEntry.findUnique({
      where: {
        section_key: {
          section: LANDING_SECTION_PACK_SIMULATOR,
          key: SIMULATOR_CONFIG_KEY,
        },
      },
      select: { value: true },
    });
    if (!row) return defaultSimulatorConfig();
    try {
      return parseSimulatorConfig(row.value);
    } catch {
      return defaultSimulatorConfig();
    }
  }

  async save(body: unknown, adminUserId: string): Promise<SimulatorConfig> {
    const cfg = parseSimulatorConfig(body);

    if (cfg.sets.length > 0) {
      const cursors = await this.prisma.tcgIngestCursor.findMany({
        where: {
          status: 'DONE',
          OR: cfg.sets.map((s) => ({ gameSlug: s.gameSlug, setId: s.setId })),
        },
        select: { gameSlug: true, setId: true },
      });
      const done = new Set(cursors.map((c) => `${c.gameSlug}:${c.setId}`));
      for (const s of cfg.sets) {
        if (!done.has(`${s.gameSlug}:${s.setId}`))
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'SIMULATOR_SET_NOT_INGESTED',
            `Set ${s.gameSlug}/${s.setId} has no completed ingestion (cursor status DONE).`,
            { gameSlug: s.gameSlug, setId: s.setId },
          );
      }
      for (const s of cfg.sets) {
        if (!s.template && !cfg.templates[s.gameSlug])
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'SIMULATOR_TEMPLATE_REQUIRED',
            `Game ${s.gameSlug} has no template in "templates" and set ${s.setId} has no template override.`,
            { gameSlug: s.gameSlug, setId: s.setId },
          );
      }
    }

    const value = cfg as unknown as Prisma.InputJsonValue;
    await this.prisma.landingConfigEntry.upsert({
      where: {
        section_key: {
          section: LANDING_SECTION_PACK_SIMULATOR,
          key: SIMULATOR_CONFIG_KEY,
        },
      },
      create: {
        section: LANDING_SECTION_PACK_SIMULATOR,
        key: SIMULATOR_CONFIG_KEY,
        valueType: 'json',
        value,
        updatedById: adminUserId,
      },
      update: { valueType: 'json', value, updatedById: adminUserId },
    });
    this.poolCache.clear(); // AD-67: pools and public sets list rebuilt on next use
    return cfg;
  }
}
