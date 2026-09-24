import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 7.1 (AD-11): response body of a successful
 * `POST /api/v1/admin/auth/login`. `accessToken` is the JWT itself — send
 * it back as `Authorization: Bearer <accessToken>` on any
 * `AdminAuthGuard`-gated route (e.g. `GET /api/v1/admin/auth/me`).
 * Nothing about `AdminUser` — let alone `passwordHash` — is echoed here
 * beyond what the JWT payload itself carries (just the AdminUser's `id`,
 * see `AdminJwtPayload`).
 */
export class AdminLoginResponseDto {
  @ApiProperty({
    description: 'The signed Admin JWT (passport-jwt-verifiable, 8h max-age).',
  })
  accessToken: string;

  @ApiProperty({ example: 'Bearer' })
  tokenType: string;

  @ApiProperty({
    example: 28800,
    description: 'Seconds until the token expires (AD-11: fixed 8h).',
  })
  expiresIn: number;
}
