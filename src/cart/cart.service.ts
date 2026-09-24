import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiException } from '../common/api-exception.js';
import { AddCartItemDto } from './dto/add-cart-item.dto.js';
import {
  CartItemResponseDto,
  CartResponseDto,
} from './dto/cart-response.dto.js';
import { CART_COOKIE_TTL_MS } from './cart-cookie.service.js';

const EMPTY_CART: CartResponseDto = { items: [], total: 0 };

export interface AddCartItemResult {
  cartId: string;
}

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 3.1 (FR-8, AD-5). `existingCartId` is whatever CartController
   * read from the (already signature-verified) cartId cookie, or `null`
   * when there was none / it didn't verify.
   *
   * Everything below runs in a single Prisma transaction so a concurrent
   * request against the same Cart can never interleave with the
   * read-desired-quantity / check-stock / write-quantity sequence below
   * and cause a lost update or an over-commit past available stock.
   *
   * Decisions made here (documented per the Dev brief, since neither the
   * story nor AD-5 spell them out):
   *
   * - **Duplicate Product in the same Cart**: `CartItem` has
   *   `@@unique([cartId, productId])`, so re-adding a Product already in
   *   the Cart increments that same row's `quantity` instead of inserting
   *   a second row for the same Product. This is the more natural
   *   "shopping cart" behavior (a buyer adding "Charizard VMAX" twice
   *   expects one line with quantity 2, not two separate lines) and it
   *   plays cleanly with Story 3.2 (update quantity) / 3.3 (remove
   *   product), both of which are naturally "one row per Product".
   * - **Stock check is against the Product's TOTAL desired quantity**
   *   (existing quantity already in the cart + this request's quantity),
   *   not just this request's quantity in isolation — otherwise two
   *   requests of quantity 1 each could silently over-commit past
   *   available stock one request at a time.
   * - **A cookie cartId that doesn't resolve to a live, unexpired Cart**
   *   (never existed, was deleted, or its AD-5 sliding expiry lapsed) is
   *   treated exactly like "no cart cookie at all": a brand new Cart is
   *   created. This never surfaces as an error to the caller.
   */
  async addItem(
    existingCartId: string | null,
    dto: AddCartItemDto,
  ): Promise<AddCartItemResult> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: dto.productId },
        select: { id: true, stock: true, heldQty: true },
      });
      if (!product) {
        throw new NotFoundException(`Product ${dto.productId} not found`);
      }

      const newExpiresAt = new Date(Date.now() + CART_COOKIE_TTL_MS);
      const existingCart = existingCartId
        ? await tx.cart.findFirst({
            where: { id: existingCartId, expiresAt: { gt: new Date() } },
          })
        : null;

      const cart = existingCart
        ? await tx.cart.update({
            where: { id: existingCart.id },
            data: { expiresAt: newExpiresAt },
          })
        : await tx.cart.create({ data: { expiresAt: newExpiresAt } });

      const existingItem = await tx.cartItem.findUnique({
        where: {
          cartId_productId: { cartId: cart.id, productId: dto.productId },
        },
      });

      const desiredQuantity = (existingItem?.quantity ?? 0) + dto.quantity;
      const availableStock = Math.max(product.stock - product.heldQty, 0);

      if (desiredQuantity > availableStock) {
        // 409: the request is well-formed, but conflicts with the
        // Product's current stock state — same reasoning AD-2 already
        // applied to `409 CATEGORY_IN_USE`.
        throw new ApiException(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_STOCK',
          `Only ${availableStock} unit(s) of product ${dto.productId} are currently available.`,
          { availableStock },
        );
      }

      if (existingItem) {
        await tx.cartItem.update({
          where: { id: existingItem.id },
          data: { quantity: desiredQuantity },
        });
      } else {
        await tx.cartItem.create({
          data: {
            cartId: cart.id,
            productId: dto.productId,
            quantity: dto.quantity,
          },
        });
      }

      return { cartId: cart.id };
    });
  }

  /**
   * Story 3.1 (FR-11). `cartId` is `null` when the caller had no
   * (verified) cart cookie at all — decided to return an empty cart (200)
   * rather than an error, consistent with how Story 2.1/2.2 already treat
   * "nothing to show" as a valid empty result, not a failure.
   *
   * `price`/`lineTotal` always come from each Product's current `priceUsd`
   * read in this same call — never anything cached on `CartItem` — so a
   * price change made directly in the DB between an add-to-cart and a
   * later `GET` is reflected immediately (FR-11's explicit AC).
   */
  async getCart(cartId: string | null): Promise<CartResponseDto> {
    if (!cartId) {
      return EMPTY_CART;
    }

    const cart = await this.prisma.cart.findFirst({
      where: { id: cartId, expiresAt: { gt: new Date() } },
      include: {
        items: {
          include: { product: { select: { name: true, priceUsd: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!cart) {
      return EMPTY_CART;
    }

    const items: CartItemResponseDto[] = cart.items.map((item) => {
      const price = Number(item.product.priceUsd);
      const lineTotal = Math.round(price * item.quantity * 100) / 100;
      return {
        productId: item.productId,
        name: item.product.name,
        quantity: item.quantity,
        price,
        lineTotal,
      };
    });

    const total =
      Math.round(items.reduce((sum, item) => sum + item.lineTotal, 0) * 100) /
      100;

    return { items, total };
  }
}
