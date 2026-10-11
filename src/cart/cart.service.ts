import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
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
    customerId?: string | null,
  ): Promise<AddCartItemResult> {
    if (customerId) {
      return this.addItemForCustomer(customerId, dto);
    }
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
            where: {
              id: existingCartId,
              customerId: null,
              expiresAt: { gt: new Date() },
            },
          })
        : null;

      // Story 12.5: a cart that a concurrent login merge just consumed
      // (deleted) degrades to "brand new cart" instead of a P2025 500.
      let cart = null;
      if (existingCart) {
        try {
          cart = await tx.cart.update({
            where: { id: existingCart.id },
            data: { expiresAt: newExpiresAt },
          });
        } catch (err) {
          if (!(
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2025'
          )) {
            throw err;
          }
        }
      }
      // Claimed by an account between the lookup and the update: not ours.
      if (cart?.customerId) {
        cart = null;
      }
      cart ??= await tx.cart.create({ data: { expiresAt: newExpiresAt } });

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
   * Shared by `removeItem` (Story 3.3) and `updateItemQuantity`'s
   * quantity=0 branch (Story 3.2): resolves the caller's live Cart and the
   * CartItem for `productId` within it, inside the given transaction.
   *
   * **404 decision** (not spelled out by the story/AD-5, decided here same
   * as Story 3.1 decided its own gaps, and kept identical for both
   * `PATCH`/quantity=0 and the dedicated `DELETE`): a missing/unverifiable
   * cart cookie, a cookie pointing at an expired/nonexistent Cart, or a
   * `productId` that isn't a line in that specific Cart are all treated as
   * the same thing — "there is nothing at that address" — and all 404 via
   * `NotFoundException`. This mirrors how Story 2.3 already uses a plain
   * 404 for "no such resource" without needing a stable `errorCode`.
   */
  private async findCartItemOrThrow(
    tx: Prisma.TransactionClient,
    cartId: string,
    productId: string,
    accountCart = false,
  ): Promise<{ id: string }> {
    const cart = await tx.cart.findFirst({
      where: accountCart
        ? { id: cartId }
        : { id: cartId, customerId: null, expiresAt: { gt: new Date() } },
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

    return cartItem;
  }

  /**
   * Story 3.3 (FR-10, AD-5). Deletes the CartItem for `productId` from the
   * caller's cart entirely — the dedicated-endpoint counterpart of
   * `updateItemQuantity`'s quantity=0 branch (Story 3.2), and deliberately
   * built to reuse that exact same logic rather than duplicate it: both
   * resolve the Cart/CartItem via `findCartItemOrThrow` (same 404
   * semantics) and both delete via `deleteMany` (see that method's own
   * idempotency note below, which applies here unchanged).
   *
   * If the removed item was the only one in the Cart, this leaves the Cart
   * row itself in place but with zero CartItems — `getCart` already
   * returns a valid `{ items: [], total: 0 }` for that shape (same code
   * path as "no cart at all"), never an error, satisfying this story's own
   * AC.
   *
   * **Idempotency of a repeated/sequential DELETE on the same productId**:
   * once the first call commits, the CartItem row is gone. A second,
   * *sequential* DELETE for that same productId finds no CartItem in
   * `findCartItemOrThrow` and 404s — consistent with (not a new rule vs.)
   * the 404 Story 3.2 already gives `PATCH` for "productId not in this
   * cart", since after the first DELETE that is literally true. This is
   * still "idempotent" in the sense that matters operationally: the
   * server-side effect (no CartItem for that productId) is identical after
   * 1 or N calls, and no call ever 500s — a 404 is not a crash. A
   * *concurrent* double DELETE (both transactions started before either
   * committed) is additionally safe at the SQL level because the delete
   * itself uses `deleteMany`, not `delete`: Postgres row-locks the target
   * row on the first `DELETE`, the second blocks until the first commits,
   * then re-evaluates its own `WHERE id = ...` against the now-deleted row
   * and simply affects 0 rows — a silent no-op, not Prisma's P2025 "record
   * to delete does not exist" throw that `delete` would raise instead.
   */
  async removeItem(
    cartId: string | null,
    productId: string,
    customerId?: string | null,
  ): Promise<void> {
    if (customerId) {
      cartId = await this.accountCartId(customerId);
    }
    if (!cartId) {
      throw new NotFoundException('No cart found for this request');
    }
    const account = !!customerId;

    await this.prisma.$transaction(async (tx) => {
      const cartItem = await this.findCartItemOrThrow(
        tx,
        cartId,
        productId,
        account,
      );
      await tx.cartItem.deleteMany({ where: { id: cartItem.id } });
    });
  }

  /**
   * Story 3.2 (FR-9, AD-5). Updates the quantity of a Product already in
   * the caller's Cart, or removes it entirely when `quantity` is 0 (same
   * deletion primitive `removeItem`/Story 3.3 uses, via
   * `findCartItemOrThrow` + `deleteMany` — see that method's own
   * idempotency note, which applies here too). We deliberately do NOT fall
   * back to "create a cart/line" the way `addItem` creates a Cart on
   * demand — updating a quantity presupposes the line already exists;
   * conjuring one here would silently do something the caller didn't ask
   * for.
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
   * quantity=0 removal, or a parallel `DELETE`) to report 404 instead of a
   * misleading 409 in that narrow case; otherwise it's a genuine
   * `INSUFFICIENT_STOCK`, and nothing was written (the whole request rolls
   * back with the transaction).
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
    customerId?: string | null,
  ): Promise<void> {
    if (customerId) {
      cartId = await this.accountCartId(customerId);
    }
    if (!cartId) {
      throw new NotFoundException('No cart found for this request');
    }
    const account = !!customerId;

    await this.prisma.$transaction(async (tx) => {
      const cartItem = await this.findCartItemOrThrow(
        tx,
        cartId,
        productId,
        account,
      );

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
  async getCart(
    cartId: string | null,
    customerId?: string | null,
  ): Promise<CartResponseDto> {
    if (!cartId && !customerId) {
      return EMPTY_CART;
    }

    const cart = await this.prisma.cart.findFirst({
      // Account carts (Story 12.5) are owned, not cookie-expiring.
      where: customerId
        ? { customerId }
        : {
            id: cartId as string,
            customerId: null,
            expiresAt: { gt: new Date() },
          },
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

  // ---------------------------------------------------------------------
  // Story 12.5 (FR-44, AD-29): account-bound cart + merge on login
  // ---------------------------------------------------------------------

  /** Id of the account's cart, or null when it has none yet. */
  private async accountCartId(customerId: string): Promise<string | null> {
    const cart = await this.prisma.cart.findUnique({
      where: { customerId },
      select: { id: true },
    });
    return cart?.id ?? null;
  }

  /**
   * Serializes everything that creates/assigns THE cart of one account
   * (account addItem vs. login merges) so the `customerId` unique index can
   * never be hit by a race. Released at commit/rollback.
   */
  private async lockAccountCart(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<void> {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${'cart:' + customerId}, 0))`,
    );
  }

  /**
   * Account variant of `addItem`: the cart is created on demand (under the
   * account lock) and the line is written by ONE guarded statement
   * (`INSERT ... SELECT ... WHERE stock - heldQty >= qty ON CONFLICT DO
   * UPDATE ... WHERE <same guard>`), so it never depends on incidental row
   * locks. 0 affected rows = genuinely insufficient stock (AD-16).
   */
  private async addItemForCustomer(
    customerId: string,
    dto: AddCartItemDto,
  ): Promise<AddCartItemResult> {
    return this.prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: dto.productId },
        select: { id: true },
      });
      if (!product) {
        throw new NotFoundException(`Product ${dto.productId} not found`);
      }

      await this.lockAccountCart(tx, customerId);
      const expiresAt = new Date(Date.now() + CART_COOKIE_TTL_MS);
      const cartId = await this.ensureAccountCart(tx, customerId, expiresAt);

      const q = dto.quantity;
      const affected = await executeGuardedUpdate(
        tx,
        Prisma.sql`
          INSERT INTO "Cart_Items" ("id", "cartId", "productId", "quantity", "createdAt", "updatedAt")
          SELECT ${randomUUID()}::uuid, ${cartId}::uuid, p.id, ${q}::int, now(), now()
          FROM "Products" p
          WHERE p.id = ${dto.productId}::uuid AND p.stock - p."heldQty" >= ${q}::int
          ON CONFLICT ("cartId", "productId") DO UPDATE
            SET quantity = "Cart_Items".quantity + ${q}::int, "updatedAt" = now()
            WHERE (SELECT p2.stock - p2."heldQty" FROM "Products" p2 WHERE p2.id = ${dto.productId}::uuid)
                  >= "Cart_Items".quantity + ${q}::int
        `,
      );

      if (affected === 0) {
        const fresh = await tx.product.findUnique({
          where: { id: dto.productId },
          select: { stock: true, heldQty: true },
        });
        const availableStock = Math.max(
          (fresh?.stock ?? 0) - (fresh?.heldQty ?? 0),
          0,
        );
        throw new ApiException(
          HttpStatus.CONFLICT,
          'INSUFFICIENT_STOCK',
          `Only ${availableStock} unit(s) of product ${dto.productId} are currently available.`,
          { availableStock },
        );
      }

      return { cartId };
    });
  }

  /** Caller must hold the account lock. */
  private async ensureAccountCart(
    tx: Prisma.TransactionClient,
    customerId: string,
    expiresAt: Date,
  ): Promise<string> {
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      INSERT INTO "Carts" ("id", "customerId", "expiresAt", "createdAt", "updatedAt")
      VALUES (${randomUUID()}::uuid, ${customerId}::uuid, ${expiresAt}, now(), now())
      ON CONFLICT ("customerId") DO UPDATE SET "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = now()
      RETURNING id
    `);
    return rows[0].id;
  }

  /**
   * AD-29: merges the anonymous cart `anonCartId` into the account's cart,
   * in ONE transaction. Idempotent and concurrency-safe:
   *  - per-account advisory lock (vs. other logins / account addItem);
   *  - the anonymous cart is "claimed" by a guarded
   *    `UPDATE ... WHERE customerId IS NULL`; a second concurrent merge of
   *    the same cookie blocks on that row, then finds it gone/owned (0 rows)
   *    and is a no-op, so quantities are never doubled;
   *  - lines are written with guarded `INSERT ... ON CONFLICT DO UPDATE`
   *    capped at `stock - heldQty` (trims silently, never errors); inactive
   *    products and out-of-stock lines are dropped. `heldQty` is only read.
   * Returns true when this call consumed the anonymous cart.
   */
  async mergeAnonymousCart(
    customerId: string,
    anonCartId: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockAccountCart(tx, customerId);
      const expiresAt = new Date(Date.now() + CART_COOKIE_TTL_MS);

      const accountCart = await tx.cart.findUnique({
        where: { customerId },
        select: { id: true },
      });

      if (!accountCart) {
        const assigned = await executeGuardedUpdate(
          tx,
          Prisma.sql`
            UPDATE "Carts"
            SET "customerId" = ${customerId}::uuid, "expiresAt" = ${expiresAt}, "updatedAt" = now()
            WHERE id = ${anonCartId}::uuid AND "customerId" IS NULL AND "expiresAt" > now()
          `,
        );
        if (assigned === 0) {
          return false;
        }
        await this.sanitizeCartLines(tx, anonCartId);
        return true;
      }

      const claimed = await executeGuardedUpdate(
        tx,
        Prisma.sql`
          UPDATE "Carts" SET "updatedAt" = now()
          WHERE id = ${anonCartId}::uuid AND "customerId" IS NULL AND "expiresAt" > now()
        `,
      );
      if (claimed === 0) {
        return false;
      }

      const lines = await tx.cartItem.findMany({
        where: { cartId: anonCartId },
        select: { productId: true, quantity: true },
      });
      for (const line of lines) {
        await tx.$executeRaw(Prisma.sql`
          INSERT INTO "Cart_Items" ("id", "cartId", "productId", "quantity", "createdAt", "updatedAt")
          SELECT ${randomUUID()}::uuid, ${accountCart.id}::uuid, p.id,
                 LEAST(${line.quantity}::int, p.stock - p."heldQty"), now(), now()
          FROM "Products" p
          WHERE p.id = ${line.productId}::uuid AND p."isActive" AND p.stock - p."heldQty" > 0
          ON CONFLICT ("cartId", "productId") DO UPDATE
            SET quantity = GREATEST(
                  "Cart_Items".quantity,
                  LEAST("Cart_Items".quantity + ${line.quantity}::int,
                        (SELECT p2.stock - p2."heldQty" FROM "Products" p2 WHERE p2.id = ${line.productId}::uuid))),
                "updatedAt" = now()
            WHERE EXISTS (SELECT 1 FROM "Products" p3 WHERE p3.id = ${line.productId}::uuid AND p3."isActive")
        `);
      }
      await tx.$executeRaw(
        Prisma.sql`UPDATE "Carts" SET "expiresAt" = ${expiresAt}, "updatedAt" = now() WHERE id = ${accountCart.id}::uuid`,
      );
      await tx.cart.deleteMany({
        where: { id: anonCartId, customerId: null },
      });
      return true;
    });
  }

  /** Drops inactive/out-of-stock lines and trims the rest to availability. */
  private async sanitizeCartLines(
    tx: Prisma.TransactionClient,
    cartId: string,
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      DELETE FROM "Cart_Items" ci USING "Products" p
      WHERE ci."cartId" = ${cartId}::uuid AND ci."productId" = p.id
        AND (NOT p."isActive" OR p.stock - p."heldQty" <= 0)
    `);
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Cart_Items" ci SET quantity = p.stock - p."heldQty", "updatedAt" = now()
      FROM "Products" p
      WHERE ci."cartId" = ${cartId}::uuid AND ci."productId" = p.id
        AND ci.quantity > p.stock - p."heldQty"
    `);
  }
}
