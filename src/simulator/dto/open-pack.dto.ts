import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length, Matches } from 'class-validator';

export class OpenPackDto {
  @ApiProperty({ example: 'sv3pt5', minLength: 1, maxLength: 64 })
  @IsString()
  @Length(1, 64)
  @Matches(/^[\w.:-]+$/)
  setId: string;
}
