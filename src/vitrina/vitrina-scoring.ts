import type {
  DailyCountEvent,
  ScoreComponents,
  ScoredProduct,
  ScoringConfig,
  ScoringInput,
  ScoringProduct,
  ScoringResult,
  VitrinaReason,
} from './vitrina.types.js';

/**
 * Story 18.6 (AD-83, FR-98): pure, deterministic Vitrina ranking.
 *
 * No Prisma, Nest, clock or randomness: the reference instant arrives as
 * `now`, and the output only depends on the *set* of inputs (permuting the
 * input arrays yields the same ranking; every sum is accumulated over a
 * canonically sorted event list so float rounding cannot depend on input
 * order). Numbers are plain JS numbers; the loader rounds to 4 dp on persist.
 *
 * Resolved ambiguities of AD-83 are marked `AMBIGUITY` below.
 */

export const VITRINA_MMR_K = 48;
const DAY_MS = 86_400_000;
const MMR_SIM_SAME_FRANCHISE = 1;
const MMR_SIM_SAME_TYPE = 0.4;
const INTEREST_W_WISHLIST = 3;
const INTEREST_W_CART = 2;
const INTEREST_W_VIEW = 1;
/** Raw signals / scores are compared at 1e-9 so float noise cannot break ties. */
const EPS_SCALE = 1e9;

const round9 = (x: number): number => Math.round(x * EPS_SCALE) / EPS_SCALE;
const key9 = (x: number): number => Math.round(x * EPS_SCALE);

function assertConfig(c: ScoringConfig): void {
  const nonNeg: (keyof ScoringConfig)[] = [
    'wSales',
    'wRevenue',
    'wVelocity',
    'wInterest',
    'wNovelty',
    'noveltyDays',
    'priorM',
    'scarcityThreshold',
    'minSalesForRanking',
    'viewDayCap',
  ];
  for (const k of nonNeg) {
    if (!Number.isFinite(c[k]) || c[k] < 0) {
      throw new RangeError(`Invalid scoring config: ${k}`);
    }
  }
  for (const k of ['halfLifeDays', 'windowDays'] as const) {
    if (!Number.isFinite(c[k]) || c[k] <= 0) {
      throw new RangeError(`Invalid scoring config: ${k}`);
    }
  }
  if (!Number.isFinite(c.mmrLambda) || c.mmrLambda < 0 || c.mmrLambda > 1) {
    throw new RangeError('Invalid scoring config: mmrLambda');
  }
  if (!Number.isInteger(c.maxPerFranchise) || c.maxPerFranchise < 1) {
    throw new RangeError('Invalid scoring config: maxPerFranchise');
  }
}

interface Acc {
  S: number;
  R: number;
  Wl: number;
  Ca: number;
  Vw: number;
  u7: number;
  u7p: number;
  units: number;
  wishCount: number;
  cartCount: number;
  viewCount: number;
}

const newAcc = (): Acc => ({
  S: 0,
  R: 0,
  Wl: 0,
  Ca: 0,
  Vw: 0,
  u7: 0,
  u7p: 0,
  units: 0,
  wishCount: 0,
  cartCount: 0,
  viewCount: 0,
});

const tsOf = (d: Date): number => (d instanceof Date ? d.getTime() : NaN);

/** Age in days if the event is inside `[0, windowDays]`, else `null`. */
function ageInWindow(at: Date, nowMs: number, windowDays: number) {
  const t = tsOf(at);
  if (!Number.isFinite(t)) return null;
  const age = (nowMs - t) / DAY_MS;
  return age < 0 || age > windowDays ? null : age;
}

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Percentile with mid-rank on ties among the entries (all positive):
 * `z = (midRank - 0.5) / N`, midRank 1-based.
 */
function percentiles(
  entries: { id: string; v: number }[],
): Map<string, number> {
  const out = new Map<string, number>();
  const sorted = [...entries].sort((a, b) => a.v - b.v || cmpStr(a.id, b.id));
  const n = sorted.length;
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && sorted[j + 1].v === sorted[i].v) j++;
    const midRank = (i + 1 + (j + 1)) / 2;
    const z = (midRank - 0.5) / n;
    for (let k = i; k <= j; k++) out.set(sorted[k].id, z);
    i = j + 1;
  }
  return out;
}

interface Cand {
  p: ScoringProduct;
  createdMs: number;
  avail: number;
  acc: Acc;
  novelty: number;
  components: ScoreComponents;
  score: number;
  reason: VitrinaReason | null;
}

/** Total order: score DESC, createdAt DESC, id ASC. */
function cmpTotal(a: Cand, b: Cand): number {
  return (
    key9(b.score) - key9(a.score) ||
    b.createdMs - a.createdMs ||
    cmpStr(a.p.id, b.p.id)
  );
}

function similarity(a: ScoringProduct, b: ScoringProduct): number {
  if (a.franchiseKey === b.franchiseKey) return MMR_SIM_SAME_FRANCHISE;
  if (a.productType === b.productType) return MMR_SIM_SAME_TYPE;
  return 0;
}

export function computeRanking(input: ScoringInput): ScoringResult {
  const { config: c, now } = input;
  assertConfig(c);
  const nowMs = tsOf(now);
  if (!Number.isFinite(nowMs)) throw new RangeError('Invalid `now`');

  // Canonical product list: sorted by id (then createdAt) and de-duplicated
  // by id so the first occurrence never depends on the caller's order.
  const seen = new Set<string>();
  const products = [...input.products]
    .sort(
      (a, b) =>
        cmpStr(a.id, b.id) ||
        (tsOf(a.createdAt) || 0) - (tsOf(b.createdAt) || 0),
    )
    .filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  const accs = new Map<string, Acc>();
  for (const p of products) accs.set(p.id, newAcc());
  const H = c.halfLifeDays;
  const decay = (age: number): number => Math.pow(0.5, age / H);

  // ---- 1. Raw signals (events sorted canonically before accumulating) -----
  const sales = input.events.sales
    .filter((e) => accs.has(e.productId))
    .map((e) => ({
      e,
      age: ageInWindow(e.at, nowMs, c.windowDays),
    }))
    .filter(
      (x): x is { e: (typeof x)['e']; age: number } =>
        x.age !== null && Number.isFinite(x.e.qty) && x.e.qty > 0,
    )
    .sort(
      (a, b) =>
        cmpStr(a.e.productId, b.e.productId) ||
        a.age - b.age ||
        a.e.qty - b.e.qty ||
        (a.e.lineTotal || 0) - (b.e.lineTotal || 0),
    );
  let salesCount = 0;
  for (const { e, age } of sales) {
    const a = accs.get(e.productId)!;
    const d = decay(age);
    const total =
      Number.isFinite(e.lineTotal) && e.lineTotal > 0 ? e.lineTotal : 0;
    a.S += e.qty * d;
    a.R += total * d;
    a.units += e.qty;
    salesCount += e.qty;
    if (age < 7) a.u7 += e.qty;
    else if (age < 14) a.u7p += e.qty;
  }

  const wish = input.events.wishlist
    .filter((e) => accs.has(e.productId))
    .map((e) => ({ e, age: ageInWindow(e.at, nowMs, c.windowDays) }))
    .filter((x): x is { e: (typeof x)['e']; age: number } => x.age !== null)
    .sort((a, b) => cmpStr(a.e.productId, b.e.productId) || a.age - b.age);
  for (const { e, age } of wish) {
    const a = accs.get(e.productId)!;
    a.Wl += decay(age);
    a.wishCount += 1;
  }

  const daily = (
    list: DailyCountEvent[],
    apply: (a: Acc, n: number, d: number) => void,
  ): void => {
    list
      .filter((e) => accs.has(e.productId))
      .map((e) => ({ e, age: ageInWindow(e.day, nowMs, c.windowDays) }))
      .filter(
        (x): x is { e: DailyCountEvent; age: number } =>
          x.age !== null && Number.isFinite(x.e.n) && x.e.n > 0,
      )
      .sort(
        (a, b) =>
          cmpStr(a.e.productId, b.e.productId) ||
          a.age - b.age ||
          a.e.n - b.e.n,
      )
      .forEach(({ e, age }) => apply(accs.get(e.productId)!, e.n, decay(age)));
  };
  daily(input.events.cartAdds, (a, n, d) => {
    a.Ca += n * d;
    a.cartCount += n;
  });
  daily(input.events.views, (a, n, d) => {
    const capped = Math.min(n, c.viewDayCap);
    a.Vw += capped * d;
    a.viewCount += capped;
  });

  // ---- Candidates: active, effective stock >= 1 --------------------------
  const cands: Cand[] = [];
  for (const p of products) {
    if (p.isActive === false) continue;
    if (!Number.isFinite(p.availableStock) || p.availableStock < 1) continue;
    const created = tsOf(p.createdAt);
    cands.push({
      p,
      createdMs: Number.isFinite(created) ? created : 0,
      avail: p.availableStock,
      acc: accs.get(p.id)!,
      novelty: 0,
      components: undefined as unknown as ScoreComponents,
      score: 0,
      reason: null,
    });
  }

  const m = c.priorM;
  const velocityOf = (a: Acc): number => {
    if (a.u7 <= 0) return 0;
    const denom = a.u7p + m;
    // AMBIGUITY: with m = 0 and no previous-week units the ratio is undefined;
    // fall back to m = 1 for that single case (r = 1 + u7).
    const r = denom > 0 ? (a.u7 + m) / denom : 1 + a.u7;
    return Math.max(0, Math.log(r)) * Math.log(1 + a.u7);
  };

  type SigKey = 'sales' | 'revenue' | 'velocity' | 'interest';
  const sigs: Record<
    SigKey,
    { raw: (a: Acc) => number; n: (a: Acc) => number; w: number }
  > = {
    sales: { raw: (a) => a.S, n: (a) => a.units, w: c.wSales },
    revenue: { raw: (a) => a.R, n: (a) => a.units, w: c.wRevenue },
    velocity: { raw: velocityOf, n: (a) => a.u7 + a.u7p, w: c.wVelocity },
    interest: {
      raw: (a) =>
        INTEREST_W_WISHLIST * a.Wl +
        INTEREST_W_CART * a.Ca +
        INTEREST_W_VIEW * a.Vw,
      n: (a) => a.wishCount + a.cartCount + a.viewCount,
      w: c.wInterest,
    },
  };

  // ---- 2-3. Percentile + Bayesian smoothing per signal --------------------
  const byId = new Map(cands.map((x) => [x.p.id, x] as const));
  const perSignal = {} as Record<
    SigKey,
    Map<string, { raw: number; z: number; zs: number }>
  >;
  for (const k of Object.keys(sigs) as SigKey[]) {
    const def = sigs[k];
    const res = new Map<string, { raw: number; z: number; zs: number }>();
    const positives: { id: string; v: number }[] = [];
    for (const cd of cands) {
      const raw = round9(def.raw(cd.acc));
      if (Number.isFinite(raw) && raw > 0)
        positives.push({ id: cd.p.id, v: raw });
      else
        res.set(cd.p.id, {
          raw: Number.isFinite(raw) ? Math.max(0, raw) : 0,
          z: 0,
          zs: 0,
        });
    }
    const z = percentiles(positives);
    // C = mean z among products with evidence (~0.5 by construction).
    let sumZ = 0;
    for (const { id } of positives) sumZ += z.get(id)!;
    const C = positives.length > 0 ? sumZ / positives.length : 0.5;
    for (const { id, v } of positives) {
      const n = def.n(byId.get(id)!.acc);
      const zi = z.get(id)!;
      res.set(id, {
        raw: v,
        z: zi,
        zs: n + m > 0 ? (n * zi + m * C) / (n + m) : zi,
      });
    }
    perSignal[k] = res;
  }

  // ---- 4-7. Novelty, base, scarcity, score --------------------------------
  const T = c.scarcityThreshold;
  for (const cd of cands) {
    const age = Math.max(0, (nowMs - cd.createdMs) / DAY_MS);
    cd.novelty = c.noveltyDays > 0 ? Math.max(0, 1 - age / c.noveltyDays) : 0;
    const comp = (k: SigKey) => {
      const e = perSignal[k].get(cd.p.id)!;
      return {
        raw: e.raw,
        z: e.z,
        zSmoothed: e.zs,
        weight: sigs[k].w,
        points: sigs[k].w * e.zs,
      };
    };
    const sales_ = comp('sales');
    const revenue = comp('revenue');
    const velocity = comp('velocity');
    const interest = comp('interest');
    const novelty = {
      raw: cd.novelty,
      weight: c.wNovelty,
      points: c.wNovelty * cd.novelty,
    };
    const base =
      sales_.points +
      revenue.points +
      velocity.points +
      interest.points +
      novelty.points;
    const f = cd.avail > T ? 1 : 0.7 + (0.3 * (cd.avail - 1)) / T;
    cd.score = base * f;
    cd.components = {
      sales: sales_,
      revenue,
      velocity,
      interest,
      novelty,
      scarcityFactor: f,
      score: cd.score,
    };
    cd.reason = reasonOf(cd);
  }

  // ---- 7/10. Ordering (total order, or fallback order) --------------------
  const mode = salesCount < c.minSalesForRanking ? 'FALLBACK' : 'RANKED';
  if (mode === 'FALLBACK') {
    // AMBIGUITY: the "Wl sin decaer" tie-break is the number of wishlist
    // events inside the window; novelty (N DESC) comes first, then the total
    // order (score DESC, createdAt DESC, id ASC) breaks remaining ties.
    cands.sort(
      (a, b) =>
        key9(b.novelty) - key9(a.novelty) ||
        b.acc.wishCount - a.acc.wishCount ||
        cmpTotal(a, b),
    );
    for (const cd of cands) cd.reason = cd.novelty > 0 ? 'NEW' : null;
  } else {
    cands.sort(cmpTotal);
  }

  // ---- 8. MMR with hard per-franchise cap ---------------------------------
  const n = cands.length;
  const scoreMax =
    cands.length > 0 ? Math.max(...cands.map((x) => x.score)) : 0;
  // AMBIGUITY: relevance is score/scoreMax in RANKED mode; in FALLBACK the
  // order is not score-driven, so relevance follows the fallback position
  // (1 - pos/n) to keep novelties first, as FR-99 requires.
  const rel = (cd: Cand, pos: number): number =>
    mode === 'FALLBACK' ? 1 - pos / n : scoreMax > 0 ? cd.score / scoreMax : 0;
  const lambda = c.mmrLambda;
  const maxSim = new Array<number>(n).fill(0);
  const taken = new Array<boolean>(n).fill(false);
  const perFranchise = new Map<string, number>();
  const selected: Cand[] = [];
  const target = Math.min(VITRINA_MMR_K, n);
  while (selected.length < target) {
    let best = -1;
    let bestVal = -Infinity;
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      if ((perFranchise.get(cands[i].p.franchiseKey) ?? 0) >= c.maxPerFranchise)
        continue;
      const val = key9((1 - lambda) * rel(cands[i], i) - lambda * maxSim[i]);
      if (val > bestVal) {
        bestVal = val;
        best = i;
      }
    }
    if (best < 0) break; // every remaining candidate is blocked by the cap
    taken[best] = true;
    const chosen = cands[best];
    selected.push(chosen);
    perFranchise.set(
      chosen.p.franchiseKey,
      (perFranchise.get(chosen.p.franchiseKey) ?? 0) + 1,
    );
    for (let i = 0; i < n; i++) {
      if (taken[i]) continue;
      const s = similarity(cands[i].p, chosen.p);
      if (s > maxSim[i]) maxSim[i] = s;
    }
  }

  const ranked: ScoredProduct[] = selected.map((cd, idx) => ({
    id: cd.p.id,
    rank: idx + 1,
    score: cd.score,
    reason: cd.reason,
    components: cd.components,
  }));
  return { mode, salesCount, ranked };
}

/**
 * AD-83 step 9, priority in this order. AMBIGUITY: "dominant signal" for
 * WISHLIST_FAVORITE = the interest points are strictly greater than the points
 * of every other signal (sales, revenue, velocity, novelty).
 */
function reasonOf(cd: Cand): VitrinaReason | null {
  const k = cd.components;
  if (k.sales.zSmoothed >= 0.8) return 'TOP_SALES';
  if (k.velocity.zSmoothed >= 0.8) return 'TRENDING';
  if (cd.novelty > 0 && (k.sales.zSmoothed > 0 || k.interest.zSmoothed >= 0.5))
    return 'NEW_WITH_TRACTION';
  if (
    k.interest.zSmoothed >= 0.8 &&
    k.interest.points >
      Math.max(
        k.sales.points,
        k.revenue.points,
        k.velocity.points,
        k.novelty.points,
      )
  )
    return 'WISHLIST_FAVORITE';
  if (cd.novelty > 0) return 'NEW';
  return null;
}
