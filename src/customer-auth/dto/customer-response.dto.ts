import { ApiProperty } from '@nestjs/swagger';

/** The only shape a customer takes in a response (never hash/tokens). */
export class CustomerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'collector@example.com' })
  email: string;

  @ApiProperty({ example: 'Ada Collector' })
  name: string;

  @ApiProperty({ nullable: true, type: String, example: null })
  phone: string | null;

  @ApiProperty({ example: false })
  emailVerified: boolean;
}

export class RegisterCustomerResponseDto {
  @ApiProperty({
    example:
      'If this email can be registered, the account has been created. You can now log in.',
  })
  message: string;
}

export class MessageResponseDto {
  @ApiProperty({ example: 'Email verified.' })
  message: string;
}
