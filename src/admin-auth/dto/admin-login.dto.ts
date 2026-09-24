import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

/**
 * Story 7.1: accepts either the Admin's `username` OR `email` in the same
 * field (AC says "username or email") — a single identifier field, not two
 * optional ones, so the DTO shape can never represent "both filled" or
 * "neither filled" ambiguously. Which one the caller sent is never
 * distinguished downstream (`AdminAuthService.login` matches against
 * either column with a single `OR` query) — that distinction is
 * irrelevant to the caller and, per the generic-failure requirement,
 * must never be revealed on rejection anyway.
 */
export class AdminLoginDto {
  @ApiProperty({
    example: 'admin',
    description: "The AdminUser's username OR email.",
  })
  @IsString()
  @IsNotEmpty()
  usernameOrEmail: string;

  @ApiProperty({ example: 'a-strong-password' })
  @IsString()
  @IsNotEmpty()
  password: string;
}
