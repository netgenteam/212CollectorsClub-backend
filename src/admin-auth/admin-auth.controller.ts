import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ExtractJwt } from 'passport-jwt';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { AdminAuthService } from './admin-auth.service.js';
import { AdminLoginDto } from './dto/admin-login.dto.js';
import { AdminLoginResponseDto } from './dto/admin-login-response.dto.js';
import { AdminUserResponseDto } from './dto/admin-user-response.dto.js';

/**
 * Story 7.1 (FR-20, NFR-4; AD-11, AD-14). Two routes:
 *
 * - `POST /api/v1/admin/auth/login`: the only route in this module with no
 *   guard — issuing the very first credential an Admin has has to be
 *   unauthenticated by definition.
 * - `GET /api/v1/admin/auth/me`: exists purely to prove `AdminAuthGuard` is
 *   wired end-to-end (this story's third AC) — Epic 8/9/10 don't have any
 *   real protected routes yet, so this is deliberately the "something to
 *   point curl/tests at" the Dev brief asked for, not a route any real
 *   feature needs. It doubles as a genuinely useful "whoami" for the
 *   eventual Admin Dashboard frontend, so it is not removed once Epic
 *   8/9/10 land.
 * - `POST /api/v1/admin/auth/logout` (Story 7.2, AD-11, FR-21): also
 *   `AdminAuthGuard`-gated — an admin has to be authenticated to be able to
 *   log out at all, which is also exactly what makes "no token → 401"
 *   automatic here with no extra code (same guard, same 401 shape as
 *   `/me`). Revokes the presented token by delegating to
 *   `AdminAuthService.logout`.
 */
@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly adminAuthService: AdminAuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Admin login',
    description:
      'Verifies username-or-email + password (Argon2id) and issues an 8h Admin JWT. Wrong username, wrong email, and wrong password for a real user all produce the exact same 401 — this endpoint never reveals which one it was (AC2).',
  })
  @ApiResponse({ status: 200, type: AdminLoginResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'errorCode INVALID_ADMIN_CREDENTIALS — the username/email does not match any AdminUser, OR it does but the password is wrong. Identical response either way.',
  })
  async login(@Body() dto: AdminLoginDto): Promise<AdminLoginResponseDto> {
    return this.adminAuthService.login(dto.usernameOrEmail, dto.password);
  }

  @Get('me')
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth('admin-jwt')
  @ApiOperation({
    summary: 'Get the currently authenticated Admin',
    description:
      'Proves AdminAuthGuard is wired and working (AC3) — returns the AdminUser attached to the request by the guard, from the validated JWT. Never includes passwordHash (see AdminUserResponseDto).',
  })
  @ApiResponse({ status: 200, type: AdminUserResponseDto })
  @ApiResponse({
    status: 401,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing, malformed, expired, or tampered Authorization header/JWT.',
  })
  me(@Req() request: RequestWithAdminUser): AdminUserResponseDto {
    return request.user;
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AdminAuthGuard)
  @ApiBearerAuth('admin-jwt')
  @ApiOperation({
    summary: 'Log out the current Admin session',
    description:
      'Revokes the presented JWT (AD-11): its jti is inserted into the persisted Postgres RevokedToken table, so any subsequent request bearing this same token — including a repeat call to this same endpoint — is rejected with 401 INVALID_ADMIN_TOKEN from then on, even before its 8h expiry, and even across an app restart (the denylist lives in Postgres, not memory, so it survives a redeploy).',
  })
  @ApiResponse({ status: 204, description: 'Token revoked. No response body.' })
  @ApiResponse({
    status: 401,
    description:
      'errorCode INVALID_ADMIN_TOKEN — missing, malformed, expired, or already-revoked token. A second logout call for the same token also lands here, since it never reaches this handler at all the second time.',
  })
  logout(@Req() request: RequestWithAdminUser): Promise<void> {
    // AdminAuthGuard already required a well-formed, verified Bearer token
    // to reach this handler at all, so this extraction cannot fail here —
    // reusing the same passport-jwt extractor AdminJwtStrategy itself uses
    // rather than hand-parsing the header a second, slightly-different way.
    const rawToken = ExtractJwt.fromAuthHeaderAsBearerToken()(
      request,
    ) as string;
    return this.adminAuthService.logout(rawToken);
  }
}
