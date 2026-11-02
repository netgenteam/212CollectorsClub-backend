import type { NestExpressApplication } from '@nestjs/platform-express';

/** JSON body cap: a 200 KB legal draft (A78) plus JSON escaping, with margin. */
export const JSON_BODY_LIMIT = '400kb';

/**
 * Replaces Nest's default JSON parser (Express' 100 KB limit) with the same
 * parser at `JSON_BODY_LIMIT`, keeping `rawBody` (Stripe webhook signatures).
 * Call before `app.init()`; `main.ts` and the e2e suites that post big bodies use it.
 */
export function applyJsonBodyLimit(app: NestExpressApplication): void {
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT });
}
