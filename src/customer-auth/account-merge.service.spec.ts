import type { Request, Response } from 'express';
import { AccountMergeService } from './account-merge.service.js';

describe('AccountMergeService (Story 12.5)', () => {
  const build = (opts: {
    cartId?: string | null;
    wishlistId?: string | null;
    cartFails?: boolean;
    wishFails?: boolean;
  }) => {
    const carts = {
      mergeAnonymousCart: opts.cartFails
        ? vi.fn().mockRejectedValue(new Error('boom'))
        : vi.fn().mockResolvedValue(true),
    };
    const wishlists = {
      mergeAnonymousWishlist: opts.wishFails
        ? vi.fn().mockRejectedValue(new Error('boom'))
        : vi.fn().mockResolvedValue(true),
    };
    const cartCookie = {
      readCartId: vi.fn().mockReturnValue(opts.cartId ?? null),
      clearCartId: vi.fn(),
    };
    const wishlistCookie = {
      readWishlistId: vi.fn().mockReturnValue(opts.wishlistId ?? null),
      clearWishlistId: vi.fn(),
    };
    const service = new AccountMergeService(
      carts as never,
      cartCookie as never,
      wishlists as never,
      wishlistCookie as never,
    );
    return { service, carts, wishlists, cartCookie, wishlistCookie };
  };
  const req = {} as Request;
  const res = {} as Response;

  it('does nothing without anonymous cookies', async () => {
    const m = build({});
    await m.service.mergeOnLogin('c1', req, res);
    expect(m.carts.mergeAnonymousCart).not.toHaveBeenCalled();
    expect(m.wishlists.mergeAnonymousWishlist).not.toHaveBeenCalled();
    expect(m.cartCookie.clearCartId).not.toHaveBeenCalled();
  });

  it('merges both and clears both cookies', async () => {
    const m = build({ cartId: 'a', wishlistId: 'b' });
    await m.service.mergeOnLogin('c1', req, res);
    expect(m.carts.mergeAnonymousCart).toHaveBeenCalledWith('c1', 'a');
    expect(m.wishlists.mergeAnonymousWishlist).toHaveBeenCalledWith('c1', 'b');
    expect(m.cartCookie.clearCartId).toHaveBeenCalledWith(res);
    expect(m.wishlistCookie.clearWishlistId).toHaveBeenCalledWith(res);
  });

  it('a failing merge never throws and keeps its cookie; the other still runs', async () => {
    const m = build({ cartId: 'a', wishlistId: 'b', cartFails: true });
    await expect(
      m.service.mergeOnLogin('c1', req, res),
    ).resolves.toBeUndefined();
    expect(m.cartCookie.clearCartId).not.toHaveBeenCalled();
    expect(m.wishlistCookie.clearWishlistId).toHaveBeenCalledWith(res);

    const w = build({ cartId: 'a', wishlistId: 'b', wishFails: true });
    await expect(
      w.service.mergeOnLogin('c1', req, res),
    ).resolves.toBeUndefined();
    expect(w.wishlistCookie.clearWishlistId).not.toHaveBeenCalled();
    expect(w.cartCookie.clearCartId).toHaveBeenCalledWith(res);
  });
});
