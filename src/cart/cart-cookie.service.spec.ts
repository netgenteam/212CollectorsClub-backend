import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  CART_COOKIE_NAME,
  CART_COOKIE_TTL_MS,
  CartCookieService,
} from './cart-cookie.service.js';

describe('CartCookieService', () => {
  let service: CartCookieService;
  let configService: { get: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    configService = { get: vi.fn().mockReturnValue('development') };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CartCookieService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<CartCookieService>(CartCookieService);
  });

  describe('readCartId', () => {
    it('returns the signed cookie value when present', () => {
      const req = {
        signedCookies: { [CART_COOKIE_NAME]: 'abc-123' },
      } as unknown as Request;
      expect(service.readCartId(req)).toBe('abc-123');
    });

    it('returns null when the cookie is absent (undefined)', () => {
      const req = { signedCookies: {} } as unknown as Request;
      expect(service.readCartId(req)).toBeNull();
    });

    it('returns null when the signature failed to verify (cookie-parser yields false)', () => {
      const req = {
        signedCookies: { [CART_COOKIE_NAME]: false },
      } as unknown as Request;
      expect(service.readCartId(req)).toBeNull();
    });

    it('returns null when signedCookies itself is undefined (no cookie header at all)', () => {
      const req = {} as unknown as Request;
      expect(service.readCartId(req)).toBeNull();
    });
  });

  describe('writeCartId', () => {
    it('sets an HttpOnly, signed, SameSite=Lax cookie with the 30-day TTL', () => {
      const cookie = vi.fn();
      const res = { cookie } as unknown as Response;

      service.writeCartId(res, 'cart-id-1');

      expect(cookie).toHaveBeenCalledWith(
        CART_COOKIE_NAME,
        'cart-id-1',
        expect.objectContaining({
          httpOnly: true,
          sameSite: 'lax',
          signed: true,
          path: '/',
          maxAge: CART_COOKIE_TTL_MS,
        }),
      );
    });

    it('sets secure: false in development (so curl/local HTTP testing can round-trip the cookie)', () => {
      configService.get.mockReturnValue('development');
      const cookie = vi.fn();
      const res = { cookie } as unknown as Response;

      service.writeCartId(res, 'cart-id-1');

      expect(cookie).toHaveBeenCalledWith(
        CART_COOKIE_NAME,
        'cart-id-1',
        expect.objectContaining({ secure: false }),
      );
    });

    it('sets secure: true outside development (AD-5 requires Secure in real deployments)', () => {
      configService.get.mockReturnValue('production');
      const cookie = vi.fn();
      const res = { cookie } as unknown as Response;

      service.writeCartId(res, 'cart-id-1');

      expect(cookie).toHaveBeenCalledWith(
        CART_COOKIE_NAME,
        'cart-id-1',
        expect.objectContaining({ secure: true }),
      );
    });
  });
});
