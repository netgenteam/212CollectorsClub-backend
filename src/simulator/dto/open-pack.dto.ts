import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class OpenPackDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  setId: string;
}
