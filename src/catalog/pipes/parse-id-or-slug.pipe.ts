import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import { isUUID } from 'class-validator';

/**
 * Story 21.1 (AD-104). Same pattern as `CreateProductDto.slug`.
 */
export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SLUG_MAX_LENGTH = 200;

export type ProductRef = { kind: 'id' | 'slug'; value: string };

/**
 * Deterministic order: (1) UUID => id (a UUID is never read as a slug);
 * (2) slug shape and length <= 200 => slug; (3) anything else => the exact
 * 400 body `ParseUUIDPipe` produced before (no `errorCode`, FR-142).
 */
@Injectable()
export class ParseIdOrSlugPipe implements PipeTransform<string, ProductRef> {
  transform(value: string): ProductRef {
    if (typeof value === 'string') {
      if (isUUID(value)) {
        return { kind: 'id', value };
      }
      if (value.length <= SLUG_MAX_LENGTH && SLUG_REGEX.test(value)) {
        return { kind: 'slug', value };
      }
    }
    throw new BadRequestException('Validation failed (uuid is expected)');
  }
}
