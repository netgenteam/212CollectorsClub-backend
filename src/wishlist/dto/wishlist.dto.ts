import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { ProductListItemDto } from '../../catalog/dto/product-list-item.dto.js';

/** Story 11.5 (FR-36): body of `POST /api/v1/wishlist/items`. */
export class AddWishlistItemDto {
  @ApiProperty({ format: 'uuid', description: 'Product id to save.' })
  @IsUUID()
  productId: string;
}

/** `GET /api/v1/wishlist` response (AD-22). */
export class WishlistResponseDto {
  @ApiProperty({ type: () => [ProductListItemDto] })
  data: ProductListItemDto[];

  @ApiProperty({ type: [String], format: 'uuid' })
  productIds: string[];
}

/** `POST /api/v1/wishlist/items` response (AD-22). */
export class WishlistProductIdsResponseDto {
  @ApiProperty({ type: [String], format: 'uuid' })
  productIds: string[];
}
