import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Only `name` and `phone` are editable; anything else is a 400. */
export class UpdateCustomerProfileDto {
  @ApiPropertyOptional({ example: 'Ada Collector' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: '+58 412 555 0100',
    description: 'Send null to clear the phone number.',
  })
  @ValidateIf((_o, value) => value !== null)
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(/^[0-9+()\-\s]{6,25}$/, {
    message: 'phone must contain only digits, spaces, +, ( ), - (6-25 chars)',
  })
  phone?: string | null;
}
