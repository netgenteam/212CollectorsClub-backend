import { HttpStatus, Injectable } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { isLegalSlug } from './legal-slugs.js';

/** Story 19.1: `:slug` must be one of the six documents (else 404). */
@Injectable()
export class LegalSlugPipe implements PipeTransform<string, string> {
  transform(value: string): string {
    if (typeof value !== 'string' || !isLegalSlug(value)) {
      throw new ApiException(
        HttpStatus.NOT_FOUND,
        'LEGAL_DOCUMENT_NOT_FOUND',
        'Legal document not found.',
      );
    }
    return value;
  }
}

/** `:n` of `/versions/:n`: a positive int32 or 400 (never a 500 from Postgres). */
export function parseVersionNumber(value: string): number {
  const n = /^\d{1,10}$/.test(value) ? +value : 0;
  if (n < 1 || n > 2_147_483_647) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'LEGAL_VERSION_INVALID',
      'The version number must be a positive integer.',
    );
  }
  return n;
}
