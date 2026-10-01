import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { WishlistCookieService } from './wishlist-cookie.service.js';
import { WishlistService } from './wishlist.service.js';
import {
  AddWishlistItemDto,
  WishlistProductIdsResponseDto,
  WishlistResponseDto,
} from './dto/wishlist.dto.js';

/** Story 11.5 (FR-36, AD-22): anonymous wishlist keyed by a signed cookie. */
@ApiTags('wishlist')
@Controller('wishlist')
export class WishlistController {
  constructor(
    private readonly wishlistService: WishlistService,
    private readonly wishlistCookie: WishlistCookieService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'View the saved products',
    description:
      'Active saved products (newest first) plus their ids. No valid wishlist cookie returns an empty list (200), never an error.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: WishlistResponseDto })
  getWishlist(@Req() req: Request): Promise<WishlistResponseDto> {
    return this.wishlistService.getWishlist(
      this.wishlistCookie.readWishlistId(req),
    );
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Save a product',
    description:
      'Idempotent. Creates the wishlist + signed HttpOnly cookie when needed and refreshes the 30-day sliding expiry.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: WishlistProductIdsResponseDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'Unknown or inactive product.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'errorCode WISHLIST_FULL — the wishlist holds 200 items.',
  })
  async addItem(
    @Body() dto: AddWishlistItemDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<WishlistProductIdsResponseDto> {
    const { wishlistId, productIds } = await this.wishlistService.addItem(
      this.wishlistCookie.readWishlistId(req),
      dto.productId,
    );
    this.wishlistCookie.writeWishlistId(res, wishlistId);
    return { productIds };
  }

  @Delete('items/:productId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Remove a saved product',
    description:
      '204 whether or not the product was saved, and even without a cookie.',
  })
  @ApiParam({ name: 'productId', format: 'uuid' })
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  async removeItem(
    @Param('productId', ParseUUIDPipe) productId: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.wishlistService.removeItem(
      this.wishlistCookie.readWishlistId(req),
      productId,
    );
  }
}
