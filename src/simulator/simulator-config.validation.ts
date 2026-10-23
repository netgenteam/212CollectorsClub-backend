import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PACK_TIERS, RARE_SLOT_TIERS, type PackTier } from './pack-tiers.js';
import type {
  RareOdds,
  SimulatorConfig,
  SimulatorSetConfig,
  Slot,
  Template,
} from './simulator-defaults.js';

export const ODDS_SUM_TOLERANCE = 0.001;
export const MAX_SETS = 50;
export const MAX_CARDS_PER_PACK = 15;
const LANDING_IMAGE_RE = /^\/uploads\/public\/landing\/[A-Za-z0-9_\-./]+$/;
const SLUG_RE = /^[A-Za-z0-9_.-]{1,100}$/;
/** Would pollute/shadow Object.prototype when used as an object key. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(path: string, reason: string): never {
  throw new ApiException(
    HttpStatus.BAD_REQUEST,
    'SIMULATOR_CONFIG_INVALID',
    `Invalid simulator config at ${path}: ${reason}.`,
    { path },
  );
}

function onlyKeys(o: Obj, allowed: string[], path: string): void {
  for (const k of Object.keys(o))
    if (!allowed.includes(k)) invalid(`${path}.${k}`, 'unknown property');
}

function intIn(v: unknown, min: number, max: number, path: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max)
    invalid(path, `must be an integer ${min}..${max}`);
  return v;
}

function parseTemplate(v: unknown, path: string): Template {
  if (!isObj(v)) invalid(path, 'must be an object');
  onlyKeys(v, ['slots'], path);
  if (!Array.isArray(v.slots) || v.slots.length === 0)
    invalid(`${path}.slots`, 'must be a non-empty array');
  const slots: Slot[] = [];
  let total = 0;
  let rareCount = 0;
  const slotsRaw: unknown[] = v.slots;
  slotsRaw.forEach((raw, i) => {
    const p = `${path}.slots[${i}]`;
    if (!isObj(raw)) invalid(p, 'must be an object');
    if (raw.kind === 'fixed') {
      onlyKeys(raw, ['kind', 'tier', 'count'], p);
      if (!PACK_TIERS.includes(raw.tier as PackTier))
        invalid(`${p}.tier`, 'unknown tier');
      const count = intIn(raw.count, 1, 8, `${p}.count`);
      total += count;
      slots.push({ kind: 'fixed', tier: raw.tier as PackTier, count });
    } else if (raw.kind === 'reverse') {
      onlyKeys(raw, ['kind', 'count'], p);
      const count = intIn(raw.count, 1, 4, `${p}.count`);
      total += count;
      slots.push({ kind: 'reverse', count });
    } else if (raw.kind === 'rare') {
      onlyKeys(raw, ['kind', 'odds'], p);
      if (!isObj(raw.odds)) invalid(`${p}.odds`, 'must be an object');
      const odds: RareOdds = {};
      for (const [tier, w] of Object.entries(raw.odds)) {
        if (!RARE_SLOT_TIERS.includes(tier as PackTier))
          invalid(`${p}.odds.${tier}`, 'tier not allowed in a rare slot');
        // Values > 100 are not a shape error: the sum is then != 100, which
        // AD-66 reports as SIMULATOR_ODDS_INVALID_SUM (checked in checkOddsSum).
        if (typeof w !== 'number' || !Number.isFinite(w) || w < 0)
          invalid(`${p}.odds.${tier}`, 'must be a non-negative number');
        odds[tier as PackTier] = w;
      }
      rareCount++;
      total += 1;
      if (i !== slotsRaw.length - 1)
        invalid(p, 'the rare slot must be the last slot');
      slots.push({ kind: 'rare', odds });
    } else {
      invalid(`${p}.kind`, 'must be fixed, reverse or rare');
    }
  });
  if (rareCount !== 1)
    invalid(`${path}.slots`, 'exactly one rare slot is required');
  if (total < 1 || total > MAX_CARDS_PER_PACK)
    invalid(`${path}.slots`, `total cards must be 1..${MAX_CARDS_PER_PACK}`);
  return { slots };
}

function checkOddsSum(t: Template, path: string): void {
  t.slots.forEach((s, i) => {
    if (s.kind !== 'rare') return;
    const sum = Object.values(s.odds).reduce((a, b) => a + b, 0);
    if (Math.abs(sum - 100) > ODDS_SUM_TOLERANCE)
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'SIMULATOR_ODDS_INVALID_SUM',
        `Rare slot odds must sum to 100 (±${ODDS_SUM_TOLERANCE}); got ${sum}.`,
        { path: `${path}.slots[${i}].odds`, sum },
      );
  });
}

/** Shape validation + odds sums. Semantic checks vs DB live in the service. */
export function parseSimulatorConfig(body: unknown): SimulatorConfig {
  if (!isObj(body)) invalid('$', 'body must be an object');
  onlyKeys(body, ['templates', 'sets'], '$');
  if (!isObj(body.templates)) invalid('templates', 'must be an object');
  const templates: Record<string, Template> = {};
  for (const [game, t] of Object.entries(body.templates)) {
    if (FORBIDDEN_KEYS.has(game) || !SLUG_RE.test(game))
      invalid(`templates.${game}`, 'invalid game slug');
    templates[game] = parseTemplate(t, `templates.${game}`);
  }
  if (!Array.isArray(body.sets) || body.sets.length > MAX_SETS)
    invalid('sets', `must be an array of at most ${MAX_SETS}`);
  const seen = new Set<string>();
  const sets: SimulatorSetConfig[] = (body.sets as unknown[]).map((raw, i) => {
    const p = `sets[${i}]`;
    if (!isObj(raw)) invalid(p, 'must be an object');
    onlyKeys(
      raw,
      ['gameSlug', 'setId', 'displayName', 'imageUrl', 'template'],
      p,
    );
    if (
      typeof raw.gameSlug !== 'string' ||
      FORBIDDEN_KEYS.has(raw.gameSlug) ||
      !SLUG_RE.test(raw.gameSlug)
    )
      invalid(`${p}.gameSlug`, 'invalid');
    if (typeof raw.setId !== 'string' || !raw.setId || raw.setId.length > 100)
      invalid(`${p}.setId`, 'invalid');
    const id = `${raw.gameSlug}:${raw.setId}`;
    if (seen.has(id)) invalid(p, 'duplicate set');
    seen.add(id);
    const out: SimulatorSetConfig = {
      gameSlug: raw.gameSlug,
      setId: raw.setId,
    };
    if (raw.displayName !== undefined) {
      if (
        typeof raw.displayName !== 'string' ||
        raw.displayName.length < 1 ||
        raw.displayName.length > 80
      )
        invalid(`${p}.displayName`, 'must be a string of 1..80 chars');
      out.displayName = raw.displayName;
    }
    if (raw.imageUrl !== undefined) {
      if (
        typeof raw.imageUrl !== 'string' ||
        !LANDING_IMAGE_RE.test(raw.imageUrl) ||
        raw.imageUrl.includes('..')
      )
        invalid(`${p}.imageUrl`, 'must be a /uploads/public/landing/ path');
      out.imageUrl = raw.imageUrl;
    }
    if (raw.template !== undefined)
      out.template = parseTemplate(raw.template, `${p}.template`);
    return out;
  });
  const cfg: SimulatorConfig = { templates, sets };
  for (const [g, t] of Object.entries(templates))
    checkOddsSum(t, `templates.${g}`);
  sets.forEach((s, i) => {
    if (s.template) checkOddsSum(s.template, `sets[${i}].template`);
  });
  return cfg;
}
