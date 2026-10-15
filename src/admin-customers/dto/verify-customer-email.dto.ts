import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, MaxLength } from 'class-validator';

/** Story 13.1 (FR-53): same email normalization as register/resend. */
export class VerifyCustomerEmailDto {
  @ApiProperty({ example: 'collector@example.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class VerifyCustomerEmailResponseDto {
  @ApiProperty({ example: 'collector@example.com' })
  email: string;

  @ApiProperty({ example: true })
  emailVerified: boolean;
}
