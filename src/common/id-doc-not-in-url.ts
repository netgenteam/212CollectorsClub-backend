import { HttpStatus } from '@nestjs/common';
import { ApiException } from './api-exception.js';

/**
 * Story 20.4 (FR-124, NFR-20.5): a cedula never travels in a URL (proxy `error_log`, browser
 * history, referrers). Routes that search by cedula take it in a POST body; a GET that still
 * carries a query key naming one is answered 400, WITHOUT looking at (or echoing) the value and
 * WITHOUT querying anything. Covers `idDoc=`, `idDoc[]=`, `idDoc[a]=`, `recipientIdDoc=`, repeated keys and
 * any letter case (the query parser has already decoded the key).
 */
export const ID_DOC_QUERY_KEY = /id_?doc|cedula/i;
export const ID_DOC_IN_URL = 'ID_DOC_IN_URL_NOT_ALLOWED';

export function assertNoIdDocInQuery(
  query: Record<string, unknown> | undefined,
  postPath: string,
): void {
  if (!query) return;
  if (Object.keys(query).some((k) => ID_DOC_QUERY_KEY.test(k))) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      ID_DOC_IN_URL,
      `An ID document must not be sent in the URL. Use ${postPath} with a JSON body.`,
      { reason: 'USE_POST_SEARCH' },
    );
  }
}
