import { ApiProperty } from '@nestjs/swagger';

export class LandingImageResponseDto {
  @ApiProperty({
    example:
      '/uploads/public/landing/0b5d6a3e-1c1e-4b57-9d0a-2a8f2c7e9a10.webp',
  })
  url: string;

  @ApiProperty({ example: 630 })
  width: number;

  @ApiProperty({ example: 880 })
  height: number;

  @ApiProperty({ example: 48211 })
  bytes: number;
}
