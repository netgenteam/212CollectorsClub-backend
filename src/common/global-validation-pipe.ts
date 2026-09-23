import { ValidationPipe } from '@nestjs/common';

/**
 * Single source of truth for the app's global validation/transformation
 * pipe (Story 2.2, NFR-3): malformed or invalid request params (e.g.
 * `page=abc`, a `franchise` value outside the enum) are rejected with
 * Nest's stable `{ statusCode, message, error }` 400 shape instead of a
 * raw 500 surfacing from downstream Prisma/Postgres. Shared by main.ts and
 * every e2e spec that boots a full Nest app, so tests exercise the exact
 * same pipe production uses instead of a hand-rolled approximation.
 *
 * `whitelist: true` strips unknown properties rather than rejecting the
 * request outright — permissive on unrecognized query params, strict on
 * recognized-but-invalid ones (the actual NFR-3 requirement).
 */
export function createGlobalValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
  });
}
