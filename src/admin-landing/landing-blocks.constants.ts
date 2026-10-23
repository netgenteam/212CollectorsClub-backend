import { Drop212BlockDto } from './dto/blocks/home-blocks.dto.js';
import {
  HeroBlockDto,
  HeroSceneBlockDto,
  ManifestoBlockDto,
  SimulatorBlockDto,
  TickerBlockDto,
  VitrinaBlockDto,
} from './dto/blocks/home-blocks.dto.js';

/**
 * Story 16.1 (FR-71; AD-60). The seven typed Home blocks. Each one is ONE
 * `LandingConfigEntry` row (`section = 'home'`, `valueType = 'json'`) holding
 * the whole block as a JSON unit — unlike the legacy sections there is no
 * row per field. The tuple order is the canonical order of
 * `GET /admin/landing-content/blocks` and of "publish all".
 */
export const LANDING_SECTION_HOME = 'home';

export const LANDING_BLOCKS = [
  'ticker',
  'hero',
  'heroScene',
  'manifesto',
  'vitrina',
  'drop212',
  'simulator',
] as const;
export type LandingBlock = (typeof LANDING_BLOCKS)[number];

export function isLandingBlock(value: string): value is LandingBlock {
  return (LANDING_BLOCKS as readonly string[]).includes(value);
}

/** block -> DTO class used by `validateLandingBlock` (plainToInstance + validate). */
export const LANDING_BLOCK_DTOS: Record<LandingBlock, new () => object> = {
  ticker: TickerBlockDto,
  hero: HeroBlockDto,
  heroScene: HeroSceneBlockDto,
  manifesto: ManifestoBlockDto,
  vitrina: VitrinaBlockDto,
  drop212: Drop212BlockDto,
  simulator: SimulatorBlockDto,
};

/** Max serialized size of a block payload (AD-60: 20 KB). */
export const LANDING_BLOCK_MAX_BYTES = 20 * 1024;
