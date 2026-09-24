import { ApiProperty } from '@nestjs/swagger';

/** One uploaded Proof-of-Payment file's metadata — never a public URL
 * (AD-12: `uploads/private/` is never static-mounted, so there isn't one). */
export class ProofOfPaymentDto {
  @ApiProperty({ example: '3f9e2b1a-6c4d-4e7f-9a1b-c1a2d3e4f5a6' })
  id: string;

  @ApiProperty({ example: 'image/png' })
  mimeType: string;

  @ApiProperty({ example: 482113, description: 'File size in bytes.' })
  sizeBytes: number;

  @ApiProperty({ example: '2026-09-24T17:41:08.000Z' })
  createdAt: string;
}

/**
 * Story 4.2 AC3: shared response shape for both the upload endpoint (POST)
 * and the status-check endpoint (GET) — an Order with nothing uploaded yet
 * is a normal, well-formed `{ hasProofOfPayment: false, latestProofOfPayment:
 * null }`, never a 404/empty-body special case, so "pending, no proof yet"
 * stays distinguishable from "proof attached" without ever erroring.
 */
export class ProofOfPaymentStatusResponseDto {
  @ApiProperty({
    description: 'Whether this Order has at least one ProofOfPayment attached.',
  })
  hasProofOfPayment: boolean;

  @ApiProperty({
    type: ProofOfPaymentDto,
    nullable: true,
    description:
      'The most recently uploaded proof (an Order may be re-uploaded against, e.g. an illegible first screenshot), or null when none has been uploaded yet.',
  })
  latestProofOfPayment: ProofOfPaymentDto | null;
}
