import { ApiProperty } from '@nestjs/swagger';

// A class (not a plain interface) so @nestjs/swagger can read its
// @ApiProperty metadata at runtime and reflect the real response shape in
// the generated OpenAPI doc — mirrors HealthStatus in app.service.ts.
export class CategoryResponseDto {
  @ApiProperty({
    format: 'uuid',
    example: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
    description: 'Category id.',
  })
  id: string;

  @ApiProperty({
    example: 'Cartas Sueltas',
    description: 'Display name.',
  })
  name: string;

  @ApiProperty({
    example: 'cartas-sueltas',
    description: 'URL-safe, unique slug.',
  })
  slug: string;
}
