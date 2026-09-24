import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Story 7.1 (AD-11, NFR-4): the ONLY shape `AdminUser` is ever allowed to
 * take in an HTTP response, anywhere in this codebase — `passwordHash` is
 * not merely omitted from this class, it is never fetched from Postgres in
 * the first place by any code path that can reach a response body (see
 * `AdminJwtStrategy.validate`'s explicit Prisma `select`, and
 * `AuthenticatedAdminUser` in `src/common/admin-auth.guard.ts`, which this
 * DTO's shape intentionally mirrors field-for-field). Every future
 * Epic 8/9/10 endpoint that needs to surface "which Admin did this" should
 * reuse this exact DTO rather than defining a second, possibly-looser one.
 */
export class AdminUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'admin' })
  username: string;

  @ApiProperty({ example: 'admin@212collectorsclub.test' })
  email: string;

  @ApiPropertyOptional({
    nullable: true,
    example: null,
    description:
      'Reserved hook for a future staff-role split (PRD OQ10, AD-11) — always null in the MVP; no logic anywhere reads this field yet.',
  })
  roleTier: string | null;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}
