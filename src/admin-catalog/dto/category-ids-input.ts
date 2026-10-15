import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsUUID, ValidateIf } from 'class-validator';

export const CATEGORY_IDS_MAX = 20;

/**
 * Story 13.5 (FR-50, AD-38): `categoryIds` for both transports. JSON body =
 * array already; multipart = JSON-encoded string or repeated fields. Anything
 * else (bare string, object, nested arrays, null) is left untouched so the
 * validators below answer 400.
 */
export function CategoryIdsInput() {
  return applyDecorators(
    ApiPropertyOptional({
      type: String,
      format: 'uuid',
      isArray: true,
      maxItems: CATEGORY_IDS_MAX,
      description:
        'Taxonomy tags (Category ids). Duplicates are de-duplicated; unknown id -> 400 CATEGORY_NOT_FOUND. Tags derived from franchise/productType are always merged and the other seeded tags dropped. On PATCH, omitted = tags untouched, array (incl. []) = full replacement. On multipart create, send a JSON-encoded string or repeat the field.',
    }),
    Transform(({ value }: { value: unknown }) => {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value) as unknown;
      } catch {
        return value;
      }
    }),
    ValidateIf((_o, value) => value !== undefined),
    IsArray(),
    ArrayMaxSize(CATEGORY_IDS_MAX),
    IsUUID(undefined, { each: true }),
  );
}
