import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** Story 20.6 (AD-98): the reason is 10-500 characters (checked by the service, with its own errorCode). */
export const ANONYMIZE_REASON_MIN = 10;
export const ANONYMIZE_REASON_MAX = 500;

/**
 * Body of `POST /admin/customers/:id/anonymize`. Both fields are optional AT THE DTO LEVEL on
 * purpose: a missing or short value must answer the stable `ANONYMIZE_CONFIRMATION_MISMATCH` /
 * `ANONYMIZE_REASON_REQUIRED` of the contract (after the 404 and the idempotent 200 that the
 * story orders first), not a generic validation 400. The upper bounds only protect the parser.
 */
export class AnonymizeCustomerDto {
  @ApiProperty({
    example: 'collector@example.com',
    description:
      'The EXACT email of the account, typed by the admin (compared lower-cased and trimmed). A wrong value is 400 ANONYMIZE_CONFIRMATION_MISMATCH and the answer never contains the real email.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  confirmEmail: string;

  @ApiProperty({
    minLength: ANONYMIZE_REASON_MIN,
    maxLength: ANONYMIZE_REASON_MAX,
    example: 'Solicitud del titular por WhatsApp, ref. TKT-1234, 2026-11-04',
    description:
      'Who asked, through which channel, and the date or reference of the request (10-500 characters). It is written to the immutable audit log: do NOT put an email, a phone number, a cedula or any other personal data in it (400 REASON_CONTAINS_ID_DOC / REASON_CONTAINS_PERSONAL_DATA).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason: string;
}

export class AnonymizeCustomerResponseDto {
  @ApiProperty({ format: 'uuid' }) customerId: string;
  @ApiProperty({ format: 'date-time' }) anonymizedAt: string;
  @ApiProperty({
    description:
      'true when the account was ALREADY anonymized: nothing was done and no audit event was written (double click, two admins).',
  })
  alreadyAnonymized: boolean;
  @ApiProperty({
    type: [String],
    description:
      "Codes the screen shows after a REAL anonymization (empty when alreadyAnonymized): BROWSER_LOCAL_STORAGE_NOT_ERASED (the address book of the frontend lives in the shopper's own browser; the server cannot erase it), BACKUPS_KEEP_DATA_UNTIL_ROTATION.",
  })
  notices: string[];
}
