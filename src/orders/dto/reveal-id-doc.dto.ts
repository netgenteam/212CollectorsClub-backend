import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

/** Story 20.4 (FR-126): body of `POST /admin/orders/:orderId/reveal-id-doc`. */
export class RevealIdDocDto {
  @ApiProperty({
    enum: ['recipient', 'buyer'],
    description:
      'Which ID document of the order: the recipient (delivery) or the buyer (invoice).',
  })
  @IsIn(['recipient', 'buyer'])
  field: 'recipient' | 'buyer';
}

export class RevealIdDocResponseDto {
  @ApiProperty({
    example: 'V-12345678',
    description:
      'The FULL ID document (canonical). Sent with Cache-Control: no-store; the frontend hides it after 30 s.',
  })
  value: string;

  @ApiProperty({
    description:
      'True for a legacy value that never had a recognizable type: it has no blind index, so it could not be cross-checked against the row.',
  })
  unparsed: boolean;
}
