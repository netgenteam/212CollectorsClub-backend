import { Injectable, Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { CartCookieService } from '../cart/cart-cookie.service.js';
import { CartService } from '../cart/cart.service.js';
import { WishlistCookieService } from '../wishlist/wishlist-cookie.service.js';
import { WishlistService } from '../wishlist/wishlist.service.js';

/**
 * Story 12.5 (FR-44, AD-29): after a SUCCESSFUL login, folds the anonymous
 * cart/wishlist (signed `cartId`/`wishlistId` cookies) into the account's.
 * Each merge is independent and best-effort: a failure is logged and leaves
 * the anonymous data and its cookie untouched, never failing the login.
 * A cookie is cleared only after its merge committed (or found nothing).
 */
@Injectable()
export class AccountMergeService {
  private readonly logger = new Logger(AccountMergeService.name);

  constructor(
    private readonly carts: CartService,
    private readonly cartCookie: CartCookieService,
    private readonly wishlists: WishlistService,
    private readonly wishlistCookie: WishlistCookieService,
  ) {}

  async mergeOnLogin(
    customerId: string,
    req: Request,
    res: Response,
  ): Promise<void> {
    const cartId = this.cartCookie.readCartId(req);
    if (cartId) {
      try {
        await this.carts.mergeAnonymousCart(customerId, cartId);
        this.cartCookie.clearCartId(res);
      } catch (err) {
        this.logger.error(`Cart merge failed: ${String(err)}`);
      }
    }
    const wishlistId = this.wishlistCookie.readWishlistId(req);
    if (wishlistId) {
      try {
        await this.wishlists.mergeAnonymousWishlist(customerId, wishlistId);
        this.wishlistCookie.clearWishlistId(res);
      } catch (err) {
        this.logger.error(`Wishlist merge failed: ${String(err)}`);
      }
    }
  }
}
