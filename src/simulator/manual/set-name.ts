import { BadRequestException } from '@nestjs/common';

/** Story 22.4 (AC3): name rules of a manual set. `nameKey` is the unique, case-insensitive key. */
export const SET_NAME_MAX = 120;

const cpLen = (s: string): number => Array.from(s).length;

/** trim + collapse whitespace; 400 (standard shape) when empty, > 120 characters or holding NUL. */
export function normalizeSetName(raw: unknown): {
  name: string;
  nameKey: string;
} {
  if (typeof raw !== 'string')
    throw new BadRequestException('name must be a string');
  if (raw.includes('\u0000'))
    throw new BadRequestException('name must not contain NUL characters');
  const name = raw.replace(/\s+/gu, ' ').trim();
  if (name.length === 0)
    throw new BadRequestException('name must not be empty');
  if (cpLen(name) > SET_NAME_MAX)
    throw new BadRequestException(
      `name must be at most ${SET_NAME_MAX} characters`,
    );
  const nameKey = name.toLowerCase();
  // lower-casing can lengthen a string (e.g. "İ"): the column is VarChar(120)
  if (cpLen(nameKey) > SET_NAME_MAX)
    throw new BadRequestException(
      `name must be at most ${SET_NAME_MAX} characters`,
    );
  return { name, nameKey };
}
