import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

/** AD-22: 30-day sliding expiry (cookie and `Wishlist.expiresAt`). */
export const WISHLIST_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const WISHLIST_COOKIE_NAME = 'wishlistId';

/**
 * AD-22: signed, HttpOnly `wishlistId` cookie. Same mechanism as the cart
 * cookie (cookie-parser `signed: true`), but fully independent of it. A
 * missing or tampered cookie (`false`) is "no wishlist", never an error.
 */
@Injectable()
export class WishlistCookieService {
  constructor(private readonly configService: ConfigService) {}

  readWishlistId(req: Request): string | null {
    const value = (req.signedCookies as Record<string, unknown> | undefined)?.[
      WISHLIST_COOKIE_NAME
    ];
    return typeof value === 'string' ? value : null;
  }

  writeWishlistId(res: Response, wishlistId: string): void {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    res.cookie(WISHLIST_COOKIE_NAME, wishlistId, {
      httpOnly: true,
      secure: nodeEnv !== 'development',
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: WISHLIST_COOKIE_TTL_MS,
    });
  }
}
