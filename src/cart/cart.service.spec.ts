import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { CartService } from './cart.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiException } from '../common/api-exception.js';
import type { AddCartItemDto } from './dto/add-cart-item.dto.js';

describe('CartService', () => {
  let service: CartService;
  let tx: {
    product: { findUnique: ReturnType<typeof vi.fn> };
    cart: {
      findFirst: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
    cartItem: {
      findUnique: ReturnType<typeof vi.fn>;
      create: ReturnType<typeof vi.fn>;
      update: ReturnType<typeof vi.fn>;
    };
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    cart: { findFirst: ReturnType<typeof vi.fn> };
  };

  function buildDto(overrides: Partial<AddCartItemDto> = {}): AddCartItemDto {
    return {
      productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
      quantity: 1,
      ...overrides,
    };
  }

  beforeEach(async () => {
    tx = {
      product: { findUnique: vi.fn() },
      cart: {
        findFirst: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      cartItem: {
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      cart: { findFirst: vi.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [CartService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get<CartService>(CartService);
  });

  describe('addItem', () => {
    it('creates a new Cart + CartItem when no existing cartId is given', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 12,
        heldQty: 0,
      });
      tx.cart.create.mockResolvedValue({ id: 'new-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue(null);

      const result = await service.addItem(null, buildDto({ quantity: 2 }));

      expect(result).toEqual({ cartId: 'new-cart-id' });
      expect(tx.cart.findFirst).not.toHaveBeenCalled();
      expect(tx.cart.create).toHaveBeenCalledWith({
        data: { expiresAt: expect.any(Date) as Date },
      });
      expect(tx.cartItem.create).toHaveBeenCalledWith({
        data: {
          cartId: 'new-cart-id',
          productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
          quantity: 2,
        },
      });
    });

    it('reuses the existing Cart (by cookie cartId) instead of creating a new one, and slides its expiry', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 12,
        heldQty: 0,
      });
      tx.cart.findFirst.mockResolvedValue({
        id: 'existing-cart-id',
        expiresAt: new Date(Date.now() + 1000),
      });
      tx.cart.update.mockResolvedValue({ id: 'existing-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue(null);

      const result = await service.addItem('existing-cart-id', buildDto());

      expect(result).toEqual({ cartId: 'existing-cart-id' });
      expect(tx.cart.create).not.toHaveBeenCalled();
      expect(tx.cart.update).toHaveBeenCalledWith({
        where: { id: 'existing-cart-id' },
        data: { expiresAt: expect.any(Date) as Date },
      });
      expect(tx.cartItem.create).toHaveBeenCalledWith({
        data: {
          cartId: 'existing-cart-id',
          productId: 'f65915f5-2931-4e50-af95-630b1fd7b950',
          quantity: 1,
        },
      });
    });

    it('treats a cartId that matches no live Cart (expired/deleted/forged) as "no cart" and creates a new one', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 12,
        heldQty: 0,
      });
      tx.cart.findFirst.mockResolvedValue(null); // no live Cart for that id
      tx.cart.create.mockResolvedValue({ id: 'brand-new-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue(null);

      const result = await service.addItem('stale-or-forged-id', buildDto());

      expect(result).toEqual({ cartId: 'brand-new-cart-id' });
      expect(tx.cart.create).toHaveBeenCalled();
    });

    it('increments quantity on the existing CartItem row instead of creating a duplicate line, when the Product is already in the cart', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 12,
        heldQty: 0,
      });
      tx.cart.findFirst.mockResolvedValue({
        id: 'existing-cart-id',
        expiresAt: new Date(Date.now() + 1000),
      });
      tx.cart.update.mockResolvedValue({ id: 'existing-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue({
        id: 'existing-item-id',
        quantity: 3,
      });

      await service.addItem('existing-cart-id', buildDto({ quantity: 2 }));

      expect(tx.cartItem.create).not.toHaveBeenCalled();
      expect(tx.cartItem.update).toHaveBeenCalledWith({
        where: { id: 'existing-item-id' },
        data: { quantity: 5 },
      });
    });

    it('rejects with ApiException(409, INSUFFICIENT_STOCK) and the real available stock when requested quantity exceeds stock - heldQty', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 10,
        heldQty: 3,
      });
      tx.cart.create.mockResolvedValue({ id: 'new-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue(null);

      await expect(
        service.addItem(null, buildDto({ quantity: 8 })),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'INSUFFICIENT_STOCK',
          details: { availableStock: 7 },
        },
      });
      expect(tx.cartItem.create).not.toHaveBeenCalled();
    });

    it('rejects with ApiException when the ALREADY-in-cart quantity plus the new request exceeds available stock, even if the new request alone would fit', async () => {
      tx.product.findUnique.mockResolvedValue({
        id: 'f65915f5-2931-4e50-af95-630b1fd7b950',
        stock: 10,
        heldQty: 0,
      });
      tx.cart.findFirst.mockResolvedValue({
        id: 'existing-cart-id',
        expiresAt: new Date(Date.now() + 1000),
      });
      tx.cart.update.mockResolvedValue({ id: 'existing-cart-id' });
      tx.cartItem.findUnique.mockResolvedValue({
        id: 'existing-item-id',
        quantity: 8,
      });

      await expect(
        service.addItem('existing-cart-id', buildDto({ quantity: 5 })),
      ).rejects.toBeInstanceOf(ApiException);
      expect(tx.cartItem.update).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the Product does not exist', async () => {
      tx.product.findUnique.mockResolvedValue(null);

      await expect(service.addItem(null, buildDto())).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(tx.cart.create).not.toHaveBeenCalled();
    });
  });

  describe('getCart', () => {
    it('returns an empty cart (never throws) when cartId is null', async () => {
      await expect(service.getCart(null)).resolves.toEqual({
        items: [],
        total: 0,
      });
      expect(prisma.cart.findFirst).not.toHaveBeenCalled();
    });

    it('returns an empty cart when the cartId matches no live Cart', async () => {
      prisma.cart.findFirst.mockResolvedValue(null);

      await expect(service.getCart('missing-or-expired')).resolves.toEqual({
        items: [],
        total: 0,
      });
    });

    it("computes each line's price/lineTotal from the Product's CURRENT priceUsd, and the total from those lines", async () => {
      prisma.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [
          {
            productId: 'p1',
            quantity: 2,
            product: { name: 'Charizard VMAX', priceUsd: '89.99' },
          },
          {
            productId: 'p2',
            quantity: 3,
            product: { name: 'Pikachu Promo Card', priceUsd: '14.99' },
          },
        ],
      });

      const result = await service.getCart('cart-1');

      expect(result).toEqual({
        items: [
          {
            productId: 'p1',
            name: 'Charizard VMAX',
            quantity: 2,
            price: 89.99,
            lineTotal: 179.98,
          },
          {
            productId: 'p2',
            name: 'Pikachu Promo Card',
            quantity: 3,
            price: 14.99,
            lineTotal: 44.97,
          },
        ],
        total: 224.95,
      });
    });
  });
});
