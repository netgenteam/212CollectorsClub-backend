import { Injectable } from '@nestjs/common';
import type { SetPool } from './pack-draw.js';

export const POOL_TTL_MS = 5 * 60 * 1000;
export const POOL_MAX_SETS = 20;

export interface CachedSet {
  gameSlug: string;
  setId: string;
  setName: string;
  pool: SetPool;
  at: number;
}

/** Story 16.4 (AD-67): per-set pool cache, TTL 5 min, max 20 sets, cleared on config save. */
@Injectable()
export class SimulatorPoolCache {
  private readonly map = new Map<string, CachedSet>();
  /** Listeners (public sets list cache) cleared together with the pools. */
  private readonly listeners: (() => void)[] = [];

  onClear(fn: () => void): void {
    this.listeners.push(fn);
  }

  get(key: string, now = Date.now()): CachedSet | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (now - hit.at > POOL_TTL_MS) {
      this.map.delete(key);
      return undefined;
    }
    return hit;
  }

  set(key: string, value: Omit<CachedSet, 'at'>, now = Date.now()): void {
    this.map.delete(key);
    this.map.set(key, { ...value, at: now });
    while (this.map.size > POOL_MAX_SETS) {
      const oldest = this.map.keys().next().value as string;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
    for (const fn of this.listeners) fn();
  }

  size(): number {
    return this.map.size;
  }
}
