import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Min } from 'class-validator';

/**
 * Story 8.3 (FR-24, NFR-2, NFR-4; AD-10). Body of
 * `PATCH /api/v1/admin/products/:id/stock` — a single-purpose sibling of
 * `UpdateProductDto` (Story 8.2), which already allows `stock` as one of
 * several optional partial-update fields. This DTO exists as its own
 * dedicated endpoint (rather than pointing the AC at the existing generic
 * `PATCH /admin/products/:id`) because the story frames this as its own
 * operation — "correct the count after a physical inventory count" — with
 * its own intent, audit trail (see the `AdminProductsService.adjustStock`
 * doc comment) and Swagger surface, independent of the general Product
 * editor.
 *
 * `@Min(0)` is the entire negative-value rejection requirement — same
 * criterion Story 8.2 already established for `CreateProductDto`/
 * `UpdateProductDto`'s own `stock` field: `class-validator` runs before the
 * service/Prisma ever sees the value, so a negative adjustment is rejected
 * with a plain 400 and nothing is persisted.
 */
export class AdjustProductStockDto {
  @ApiProperty({
    example: 40,
    minimum: 0,
    description:
      'New absolute Product.stock value (not a delta). Negative values are rejected (400).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  stock: number;
}
