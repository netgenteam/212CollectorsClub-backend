import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VerifyEmailDto {
  @ApiProperty({ description: 'Token from the verification email link.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  token: string;
}
