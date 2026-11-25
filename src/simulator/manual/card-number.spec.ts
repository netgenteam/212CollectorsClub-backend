import { describe, expect, it } from 'vitest';
import { numberKeyOf, numberKeyOrNull } from './card-number.js';

describe('numberKeyOf (22.10)', () => {
  it('lower-cases, keeps inner spaces, null stays null', () => {
    expect(numberKeyOf('A1')).toBe('a1');
    expect(numberKeyOf('TG12')).toBe(numberKeyOf('tg12'));
    expect(numberKeyOf('A 1')).not.toBe(numberKeyOf('A1'));
    expect(numberKeyOrNull(null)).toBeNull();
    expect(numberKeyOrNull(undefined)).toBeNull();
    expect(numberKeyOrNull('')).toBeNull();
    expect(numberKeyOrNull('025/165')).toBe('025/165');
  });
  it('numberKey column is wide enough for lower() of a 30-char number', () => {
    expect(numberKeyOf('İ'.repeat(30)).length).toBeLessThanOrEqual(64);
  });
});
