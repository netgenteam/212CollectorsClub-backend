import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Story 20.6 (AD-97/98, FR-124, NFR-20.5): body of `POST /admin/customers/search`. Nothing here ever
 * travels in a URL: an email fragment and a cedula are personal data and a URL is written to proxy
 * logs. Unknown properties are 400 (`strictBody`).
 */
export class SearchCustomersDto {
  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 100,
    example: 'ana@',
    description:
      'Partial, case-insensitive match on the email OR the name. Combined (AND) with `idDoc`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  // A NUL byte cannot be stored or compared by PostgreSQL (it was a 500): 400.
  // eslint-disable-next-line no-control-regex -- matching the NUL control character is the point
  @Matches(/^[^\u0000]*$/, { message: 'q must not contain a NUL character' })
  q?: string;

  @ApiPropertyOptional({
    maxLength: 30,
    example: 'V-12345678',
    description:
      'EXACT ID document, by blind index: the customers with a saved address OR an order (recipient or buyer) carrying it. Same validation as POST /admin/orders/search (400 ID_DOC_FILTER_INVALID, never echoed). Equality only, no partial match.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  idDoc?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description:
      'Opaque `meta.nextCursor` of the previous page. A malformed one is 400 CURSOR_INVALID.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}
