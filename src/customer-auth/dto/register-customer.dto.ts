import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsInt,
  IsOptional,
  Matches,
  Min,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

import { IsNotAnonymizedEmailDomain } from '../../common/anonymized-email.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterCustomerDto {
  @ApiProperty({ example: 'collector@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  // Story 20.6 (QA round 2): no zero-width, control or whitespace character anywhere (validator.js
  // accepts a U+200B in the local part, BetterAuth does not: it was a 500).
  @Matches(/^[^\p{Cf}\p{Cc}\p{Z}]*$/u, {
    message: 'email must not contain invisible, control or space characters',
  })
  // Story 20.6: `anonymized.invalid` is the reserved domain of deleted accounts.
  @IsNotAnonymizedEmailDomain()
  email: string;

  @ApiProperty({ minLength: 8, maxLength: 128, example: 'a-strong-password' })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @ApiProperty({ example: 'Ada Collector' })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name: string;

  @ApiPropertyOptional({
    example: 3,
    description:
      'Story 19.4 (FR-112): version of `terminos` in force. Optional only at DTO level (a missing one is 400 CONSENT_REQUIRED from the service when that document has a version in force).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  acceptedTermsVersion?: number;

  @ApiPropertyOptional({
    example: 2,
    description: 'Story 19.4: version of `privacidad` in force.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  acceptedPrivacyVersion?: number;

  @ApiPropertyOptional({
    description:
      "Story 19.4 (FR-116): declaration of being 18+ (or having a legal representative's authorization). Always required: anything other than the boolean `true` (including the string true or the number 1) is 400 CONSENT_REQUIRED. Stored as a declaration; no birth date is asked.",
  })
  // No @IsBoolean (QA 19.4a): a non-boolean must reach the service so the
  // answer is CONSENT_REQUIRED, not the generic validation 400.
  @IsOptional()
  ageDeclared?: boolean;
}
