import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Story 3.1: the first story that needs a rejection carrying a stable,
 * enumerable `errorCode` (e.g. `INSUFFICIENT_STOCK`) rather than Nest's
 * default free-text 4xx body. Nothing earlier in this codebase needed one
 * (Story 2.3's `NotFoundException` uses Nest's default shape since a plain
 * 404 needs no reason code to disambiguate). The shape below is not a new
 * invention — it's the error body the Architect already fixed in
 * `ARCHITECTURE-SPINE.md` ("Data & formats": `{ statusCode, errorCode,
 * message, details? }`) and PRD §8 ("Error/reason codes"), just not yet
 * implemented by any prior story. Every future story that needs a
 * business-rule rejection (as opposed to a generic 400/404) should reuse
 * this class instead of inventing another shape.
 */
export interface ApiErrorBody {
  statusCode: number;
  errorCode: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiException extends HttpException {
  constructor(
    status: HttpStatus,
    errorCode: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    const body: ApiErrorBody = {
      statusCode: status,
      errorCode,
      message,
      ...(details ? { details } : {}),
    };
    super(body, status);
  }
}
