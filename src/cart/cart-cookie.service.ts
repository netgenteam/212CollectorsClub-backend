import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';

/** AD-5: 30-day sliding expiry. */
export const CART_COOKIE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Name of the cookie carrying the opaque `cartId` (AD-5). Exported so
 * tests can read/clear it without hardcoding the string in two places.
 */
export const CART_COOKIE_NAME = 'cartId';

/**
 * AD-5's cart-identity mechanism, isolated from CartController so it can
 * be unit-tested without spinning up Express. Uses cookie-parser's
 * `signed: true` support (wired up in `main.ts` / e2e specs via
 * `app.use(cookieParser(secret))`, secret sourced from `COOKIE_SECRET` via
 * `@nestjs/config`) — never a JWT, per AD-5. cookie-parser signs with
 * HMAC-SHA256 and stores `req.secret` on the request so Express's own
 * native `res.cookie(name, value, { signed: true })` can sign outgoing
 * cookies with that same secret; on the way in, `req.signedCookies[name]`
 * is the verified value, `false` if the signature doesn't match (tampered
 * or signed with a different secret), or `undefined` if absent. A `false`
 * (tampered) or `undefined` (absent) cartId is always treated as "no cart"
 * — never trusted, never surfaced as an error to the caller (see
 * CartService/CartController for what "no cart" does in each case).
 *
 * `secure` is only forced on outside local development: AD-5 requires a
 * `Secure` cookie for the real deployment (HTTPS-only transmission), but a
 * `Secure` cookie is dropped by browsers *and* by curl's cookie jar over
 * plain HTTP, which is how this app is served in local dev (see
 * `docker-compose.yml`/`.env`, no TLS locally). Gating on `NODE_ENV`
 * mirrors how the rest of this app already treats `NODE_ENV` as the
 * dev-vs-real-deployment switch (see `.env.example`).
 */
@Injectable()
export class CartCookieService {
  constructor(private readonly configService: ConfigService) {}

  /**
   * Returns the verified cartId from the request's signed cookie, or
   * `null` when there is none or its signature doesn't check out.
   */
  readCartId(req: Request): string | null {
    const value = (req.signedCookies as Record<string, unknown> | undefined)?.[
      CART_COOKIE_NAME
    ];
    return typeof value === 'string' ? value : null;
  }

  /**
   * Sets (or refreshes) the signed cartId cookie with a fresh `maxAge`
   * window. Called every time `POST /cart/items` succeeds, whether the
   * Cart is brand new or just had its AD-5 sliding expiry pushed forward
   * server-side (`Cart.expiresAt`, see CartService.addItem) — both cases
   * need the client's cookie Max-Age refreshed in lockstep with that same
   * `CART_COOKIE_TTL_MS` window so the cookie and the DB row expire
   * together.
   */
  writeCartId(res: Response, cartId: string): void {
    const nodeEnv = this.configService.get<string>('NODE_ENV', 'development');
    res.cookie(CART_COOKIE_NAME, cartId, {
      httpOnly: true,
      secure: nodeEnv !== 'development',
      sameSite: 'lax',
      signed: true,
      path: '/',
      maxAge: CART_COOKIE_TTL_MS,
    });
  }
}
