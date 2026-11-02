import type { NextFunction, Request, Response } from 'express';
import { json } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { isLegalSlug } from '../legal/legal-slugs.js';

/** Express' own default, kept for every route (public ones included). */
export const JSON_BODY_LIMIT = '100kb';

/** A 200 KB legal draft (A78) plus JSON escaping, with margin. */
export const LEGAL_DRAFT_JSON_BODY_LIMIT = '400kb';

/**
 * EXACTLY `PUT /api/v1/admin/legal/<legal slug>/draft` (optional trailing
 * slash); the slug goes through the same `isLegalSlug` as `LegalSlugPipe`.
 * Nothing else may get the big limit.
 */
const LEGAL_DRAFT_PATH = /^\/api\/v1\/admin\/legal\/([^/]+)\/draft\/?$/;

const isLegalDraftPut = (req: Request): boolean => {
  if (req.method !== 'PUT') return false;
  const m = LEGAL_DRAFT_PATH.exec(req.path);
  return m !== null && isLegalSlug(m[1]);
};

/**
 * Story 19.2 (A78, QA E): the JSON limit is 100 KB everywhere (Nest's default
 * parser, untouched) except the legal draft route, whose parser is mounted
 * BEFORE Nest's own (body-parser skips a request already parsed). That parser
 * runs ahead of guards and the throttler, so it only applies when the request
 * carries a `Authorization: Bearer ...` header (not validated here: the guard
 * does that); an anonymous caller keeps the 100 KB parser and gets 413 beyond it.
 * Call before `app.init()`; `main.ts` and the e2e suites that post big drafts use it.
 */
export function applyJsonBodyLimit(app: NestExpressApplication): void {
  const big = json({ limit: LEGAL_DRAFT_JSON_BODY_LIMIT });
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (
      isLegalDraftPut(req) &&
      /^Bearer\s+\S+/i.test(req.headers.authorization ?? '')
    ) {
      big(req, res, next);
      return;
    }
    next();
  });
}
