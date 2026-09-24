import { ApiProperty } from '@nestjs/swagger';

/**
 * Story 6.1: deliberately minimal. The caller learns only that their
 * message was received (id + timestamp) — never whether the best-effort
 * admin-notification email succeeded or failed. That is an internal
 * operational detail (see `ContactInquiry.emailStatus` in the schema), not
 * something to disclose to an anonymous submitter, and per PRD UJ-4 the
 * confirmation is explicitly "received", not "read" or "delivered".
 */
export class ContactInquiryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  createdAt: Date;
}
