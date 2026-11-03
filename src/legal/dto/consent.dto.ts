import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Story 19.4: version fields are optional AT THE DTO LEVEL on purpose: a
 * missing one must reach the service to answer 400 `CONSENT_REQUIRED` (with
 * `details.missing`), not the generic validation 400.
 */
export class ReacceptConsentDto {
  @ApiPropertyOptional({
    example: 3,
    description:
      'Version of `terminos` in force. Required only while `terminos` is pending for the account; optional otherwise (if sent it must still be the one in force, and nothing is recorded for a non-pending document).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  acceptedTermsVersion?: number;

  @ApiPropertyOptional({
    example: 2,
    description:
      'Version of `privacidad` in force. Required only while `privacidad` is pending for the account; optional otherwise (same rules as `acceptedTermsVersion`).',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  acceptedPrivacyVersion?: number;

  @ApiPropertyOptional({
    description:
      'Must be `true` while `ageDeclarationPending` (the customer has no AGE_DECLARATION yet); ignored otherwise. A non-boolean value ("true", 1) is 400 CONSENT_REQUIRED, not the generic validation error.',
  })
  // No @IsBoolean (QA 19.4a): see RegisterCustomerDto.ageDeclared.
  @IsOptional()
  ageDeclared?: boolean;
}

export class PendingConsentDto {
  @ApiProperty({ example: 'terminos' }) slug: string;
  @ApiProperty({ example: 3, description: 'Version in force.' })
  version: number;
  @ApiProperty() changeSummary: string;
}

export class ConsentStatusResponseDto {
  @ApiProperty({
    type: [PendingConsentDto],
    description:
      'Only `terminos` / `privacidad` that have a version in force and are not accepted (never, or older than the last substantial version).',
  })
  pending: PendingConsentDto[];

  @ApiProperty({
    description: 'True while the customer has no AGE_DECLARATION record.',
  })
  ageDeclarationPending: boolean;
}

export class AdminConsentRowDto {
  @ApiProperty({ format: 'uuid' }) id: string;
  @ApiProperty({
    enum: [
      'TERMS',
      'PRIVACY',
      'SHIPPING',
      'RETURNS',
      'AGE_DECLARATION',
      'COOKIES',
    ],
  })
  type: string;
  @ApiProperty({
    description:
      'Version number accepted. 0 only for an AGE_DECLARATION made while TERMS had no version in force.',
  })
  version: number;
  @ApiProperty({ format: 'uuid', nullable: true }) documentVersionId:
    string | null;
  @ApiProperty({ enum: ['REGISTER', 'CHECKOUT', 'RE_ACCEPT'] }) context: string;
  @ApiProperty({ example: '2026-11-03T14:00:00.000Z' }) acceptedAt: string;
  @ApiProperty({ format: 'uuid', nullable: true }) customerId: string | null;
  @ApiProperty({ format: 'uuid', nullable: true }) orderId: string | null;
}

export class AdminConsentsResponseDto {
  @ApiProperty({ type: [AdminConsentRowDto] }) consents: AdminConsentRowDto[];
}
