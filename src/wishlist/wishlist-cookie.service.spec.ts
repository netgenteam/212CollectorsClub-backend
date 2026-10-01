import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import {
  WISHLIST_COOKIE_NAME,
  WISHLIST_COOKIE_TTL_MS,
  WishlistCookieService,
} from './wishlist-cookie.service.js';

describe('WishlistCookieService', () => {
  const build = (env: string) =>
    new WishlistCookieService({
      get: vi.fn().mockReturnValue(env),
    } as unknown as ConfigService);

  it('reads the verified signed cookie value', () => {
    const req = {
      signedCookies: { [WISHLIST_COOKIE_NAME]: 'abc' },
    } as unknown as Request;
    expect(build('development').readWishlistId(req)).toBe('abc');
  });

  it.each([[undefined], [false]])(
    'returns null for absent/tampered cookie (%s)',
    (value) => {
      const req = {
        signedCookies: { [WISHLIST_COOKIE_NAME]: value },
      } as unknown as Request;
      expect(build('development').readWishlistId(req)).toBeNull();
      expect(
        build('development').readWishlistId({} as unknown as Request),
      ).toBeNull();
    },
  );

  it('writes a signed HttpOnly lax 30-day cookie; secure only outside development', () => {
    const cookie = vi.fn();
    const res = { cookie } as unknown as Response;
    build('development').writeWishlistId(res, 'id-1');
    expect(cookie).toHaveBeenCalledWith('wishlistId', 'id-1', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: WISHLIST_COOKIE_TTL_MS,
    });
    const prodCookie = vi.fn();
    build('production').writeWishlistId(
      { cookie: prodCookie } as unknown as Response,
      'id-1',
    );
    expect(prodCookie.mock.calls[0][2]).toMatchObject({ secure: true });
  });
});
