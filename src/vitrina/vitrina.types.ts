/**
 * Story 18.6 (AD-81, AD-83): plain types for the pure Vitrina scoring
 * function. No Prisma/Nest imports on purpose: the loader (18.8) maps DB rows
 * (Decimals -> numbers) into these shapes.
 */

export type VitrinaMode = 'RANKED' | 'FALLBACK';

/** Story 18.9 (AD-85): how the Home `vitrina` block picks its products. */
export const VITRINA_BLOCK_MODES = ['MANUAL', 'AUTO', 'MIXED'] as const;
export type VitrinaBlockMode = (typeof VITRINA_BLOCK_MODES)[number];
export const VITRINA_SIZE_MIN = 4;
export const VITRINA_SIZE_MAX = 12;
export const VITRINA_SIZE_DEFAULT = 8;

export type VitrinaReason =
  'TOP_SALES' | 'TRENDING' | 'NEW_WITH_TRACTION' | 'WISHLIST_FAVORITE' | 'NEW';

export interface ScoringProduct {
  id: string;
  createdAt: Date;
  /** `franchise`, or `'OTHER:' + franchise category id` when franchise = OTHER. */
  franchiseKey: string;
  productType: string;
  /** `stock - heldQty` (effective). Products with `< 1` are excluded. */
  availableStock: number;
  /** Defaults to `true`; inactive products are excluded. */
  isActive?: boolean;
}

export interface SaleEvent {
  productId: string;
  qty: number;
  lineTotal: number;
  at: Date;
}

export interface WishlistEvent {
  productId: string;
  at: Date;
}

/** Per-day aggregate (`Product_Daily_Stats`): `day` is the UTC date (00:00Z). */
export interface DailyCountEvent {
  productId: string;
  day: Date;
  n: number;
}

export interface ScoringEvents {
  sales: SaleEvent[];
  wishlist: WishlistEvent[];
  cartAdds: DailyCountEvent[];
  views: DailyCountEvent[];
}

export interface ScoringConfig {
  wSales: number;
  wRevenue: number;
  wVelocity: number;
  wInterest: number;
  wNovelty: number;
  halfLifeDays: number;
  windowDays: number;
  noveltyDays: number;
  maxPerFranchise: number;
  mmrLambda: number;
  priorM: number;
  scarcityThreshold: number;
  minSalesForRanking: number;
  viewDayCap: number;
}

export interface ScoringInput {
  products: ScoringProduct[];
  events: ScoringEvents;
  config: ScoringConfig;
  /** Reference instant. The function never reads the clock itself. */
  now: Date;
}

export interface SignalComponent {
  raw: number;
  z: number;
  zSmoothed: number;
  weight: number;
  points: number;
}

export interface NoveltyComponent {
  /** `N = max(0, 1 - age/noveltyDays)` in [0,1]. */
  raw: number;
  weight: number;
  points: number;
}

/**
 * Invariant: `(sales + revenue + velocity + interest + novelty).points
 * * scarcityFactor === score` (unrounded; equal at 4 dp once persisted).
 */
export interface ScoreComponents {
  sales: SignalComponent;
  revenue: SignalComponent;
  velocity: SignalComponent;
  interest: SignalComponent;
  novelty: NoveltyComponent;
  scarcityFactor: number;
  score: number;
}

export interface ScoredProduct {
  id: string;
  /** 1-based position after MMR. */
  rank: number;
  score: number;
  reason: VitrinaReason | null;
  components: ScoreComponents;
}

export interface ScoringResult {
  mode: VitrinaMode;
  /** Units sold inside the window (all listed products); drives the mode. */
  salesCount: number;
  /** At most `VITRINA_MMR_K` (48) products, in final order. */
  ranked: ScoredProduct[];
}
