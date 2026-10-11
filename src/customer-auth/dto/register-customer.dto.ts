import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsNotEmpty,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterCustomerDto {
  @ApiProperty({ example: 'collector@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
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
}
