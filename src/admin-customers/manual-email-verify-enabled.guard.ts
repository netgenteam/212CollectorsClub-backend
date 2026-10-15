import {
  CanActivate,
  ExecutionContext,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';

/**
 * Story 13.1 (FR-53, AD-39, A24) - TEMPORARY, remove with real SMTP.
 * Must run BEFORE `AdminAuthGuard`: with the flag off the route answers the
 * standard Nest 404 (no `errorCode`), indistinguishable from a route that
 * does not exist, and no auth is evaluated. Reads the flag on every request.
 */
@Injectable()
export class ManualEmailVerifyEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.config.get<string>('MANUAL_EMAIL_VERIFY_ENABLED') !== 'true') {
      // Same body Nest builds for an unmatched route (`Cannot POST /x`).
      const req = context.switchToHttp().getRequest<Request>();
      throw new NotFoundException(`Cannot ${req.method} ${req.originalUrl}`);
    }
    return true;
  }
}
