import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { tap } from 'rxjs';
import type { Observable } from 'rxjs';

/** AD-91: `Cache-Control: public, max-age=60` on SUCCESS only (errors are never cached). */
@Injectable()
export class LegalCacheInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const res = ctx.switchToHttp().getResponse<Response>();
    return next
      .handle()
      .pipe(tap(() => res.setHeader('Cache-Control', 'public, max-age=60')));
  }
}
