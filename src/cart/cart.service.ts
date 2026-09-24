import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
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
   * Story 3.2 (FR-9, AD-5). Updates the quantity of a Product already in
   * the caller's Cart, or removes it entirely when `quantity` is 0.
   *
   * **404 decision** (not spelled out by the story/AD-5, decided here same
   * as Story 3.1 decided its own gaps): a missing/unverifiable cart cookie,
   * a cookie pointing at an expired/nonexistent Cart, or a `productId` that
   * isn't a line in that specific Cart are all treated as the same thing —
   * "there is nothing at that address to update" — and all 404 via
   * `NotFoundException`. This mirrors how Story 2.3 already uses a plain
   * 404 for "no such resource" without needing a stable `errorCode` (a 404
   * needs no reason code to disambiguate, unlike the 409 below). We
   * deliberately do NOT fall back to "create a cart/line" the way `addItem`
   * creates a Cart on demand — updating a quantity presupposes the line
   * already exists; conjuring one here would silently do something the
   * caller didn't ask for.
   *
   * **Concurrency guard — improves on the Story 3.1 pattern.** QA flagged
   * (non-blocking) that `addItem`'s stock-race protection today relies on
   * the *side effect* of `Cart.update({ expiresAt })` taking a row lock
   * that happens to serialize concurrent requests against the same Cart,
   * not on an explicit guarded update like AD-16 requires elsewhere. This
   * method does NOT touch `Cart.expiresAt` at all (out of this story's
   * scope, and reusing that incidental lock would just inherit the same
   * fragility) — instead the quantity write itself is a single guarded SQL
   * `UPDATE ... WHERE ... stock - "heldQty" >= quantity`, executed inside
   * the transaction. Two concurrent requests targeting the *same*
   * `CartItem` row are already serialized by Postgres's own row-level
   * locking on that `UPDATE` (no incidental lock elsewhere needed): the
   * second one blocks until the first commits, then re-evaluates the WHERE
   * guard against the post-commit state, so it can never overwrite with a
   * quantity that stock no longer supports. If the guard's affected-row
   * count is 0, we re-check whether the `CartItem` still exists at all
   * (another concurrent request could have raced it away, e.g. a parallel
   * quantity=0 removal) to report 404 instead of a misleading 409 in that
   * narrow case; otherwise it's a genuine `INSUFFICIENT_STOCK`, and nothing
   * was written (the whole request rolls back with the transaction).
   *
   * This is still a *soft*, informational stock check, same class of
   * guarantee `addItem` already gives — carts don't reserve/hold stock
   * (that's AD-6, Epic 4 checkout scope). A different guest's cart bumping
   * the *same* Product at the exact same instant isn't serialized by this
   * guard either (each targets a different `CartItem` row) — closing that
   * gap for real requires AD-6's `heldQty` reservation at checkout, not
   * here. What this method does close, without depending on any incidental
   * side effect, is the same-Cart/same-line race this story's own AC
   * cares about.
   */
  async updateItemQuantity(
    cartId: string | null,
    productId: string,
    quantity: number,
  ): Promise<void> {
    if (!cartId) {
      throw new NotFoundException('No cart found for this request');
    }

    await this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({
        where: { id: cartId, expiresAt: { gt: new Date() } },
      });
      if (!cart) {
        throw new NotFoundException('No cart found for this request');
      }

      const cartItem = await tx.cartItem.findUnique({
        where: { cartId_productId: { cartId: cart.id, productId } },
      });
      if (!cartItem) {
        throw new NotFoundException(`Product ${productId} is not in this cart`);
      }

      if (quantity === 0) {
        // `deleteMany` (not `delete`) so a concurrent duplicate
        // quantity=0 request racing this one is a no-op, not a P2025
        // crash — idempotent removal, no explicit "already gone" error.
        await tx.cartItem.deleteMany({ where: { id: cartItem.id } });
        return;
      }

      const affected = await tx.$executeRaw(Prisma.sql`
        UPDATE "Cart_Items"
        SET quantity = ${quantity}, "updatedAt" = now()
        FROM "Products"
        WHERE "Cart_Items".id = ${cartItem.id}::uuid
          AND "Cart_Items"."productId" = "Products".id
          AND "Products".stock - "Products"."heldQty" >= ${quantity}
      `);

      if (affected === 0) {
        const stillExists = await tx.cartItem.findUnique({
          where: { id: cartItem.id },
          select: { id: true },
        });
        if (!stillExists) {
          throw new NotFoundException(
            `Product ${productId} is not in this cart`,
          );
        }

        const product = await tx.product.findUniqueOrThrow({
          where: { id: productId },
          select: { stock: true, heldQty: true },
        });
        const availableStock = Math.max(product.stock - product.heldQty, 0);

        throw new ApiException(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_STOCK',
          `Only ${availableStock} unit(s) of product ${productId} are currently available.`,
          { availableStock },
        );
      }
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
