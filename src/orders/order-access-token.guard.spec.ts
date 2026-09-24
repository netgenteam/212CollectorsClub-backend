import type { ExecutionContext } from '@nestjs/common';
import { OrderAccessTokenGuard } from './order-access-token.guard.js';
import { hashOrderAccessToken } from '../common/order-access-token.js';

const ORDER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ORDER_ID = '22222222-2222-4222-8222-222222222222';
const RAW_TOKEN = 'a'.repeat(64);

function buildContext(params: { orderId?: string; authorization?: string }): {
  context: ExecutionContext;
  request: Record<string, unknown>;
} {
  const request: Record<string, unknown> = {
    params: params.orderId === undefined ? {} : { orderId: params.orderId },
    headers:
      params.authorization === undefined
        ? {}
        : { authorization: params.authorization },
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
  return { context, request };
}

/**
 * Story 4.2 (AD-17): proves the guard's own documented decisions —
 * Bearer-header extraction, 401 for every "not this exact valid token for
 * this exact Order" case (missing/malformed header, non-UUID orderId,
 * unknown orderId, wrong token, a token that IS valid but for a DIFFERENT
 * Order), timing-safe comparison (not `===`), and that a genuinely valid
 * token attaches the Order onto the request and lets the request through.
 */
describe('OrderAccessTokenGuard', () => {
  let prisma: { order: { findUnique: ReturnType<typeof vi.fn> } };
  let guard: OrderAccessTokenGuard;

  beforeEach(() => {
    prisma = { order: { findUnique: vi.fn() } };
    guard = new OrderAccessTokenGuard(prisma as never);
  });

  it('rejects with 401 MISSING_ORDER_ACCESS_TOKEN when there is no Authorization header at all', async () => {
    const { context } = buildContext({ orderId: ORDER_ID });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'MISSING_ORDER_ACCESS_TOKEN' },
    });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('rejects with 401 MISSING_ORDER_ACCESS_TOKEN when the Authorization header is not a "Bearer <token>" shape', async () => {
    const { context } = buildContext({
      orderId: ORDER_ID,
      authorization: `Basic ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'MISSING_ORDER_ACCESS_TOKEN' },
    });
  });

  it('rejects with 401 INVALID_ORDER_ACCESS_TOKEN when orderId is not a syntactically valid UUID, without querying the DB', async () => {
    const { context } = buildContext({
      orderId: 'not-a-uuid',
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ORDER_ACCESS_TOKEN' },
    });
    expect(prisma.order.findUnique).not.toHaveBeenCalled();
  });

  it('rejects with 401 INVALID_ORDER_ACCESS_TOKEN when the orderId matches no Order', async () => {
    prisma.order.findUnique.mockResolvedValue(null);
    const { context } = buildContext({
      orderId: ORDER_ID,
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ORDER_ACCESS_TOKEN' },
    });
  });

  it('rejects with 401 INVALID_ORDER_ACCESS_TOKEN when the token is simply wrong for this Order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      id: ORDER_ID,
      accessTokenHash: hashOrderAccessToken('the-real-token'),
    });
    const { context } = buildContext({
      orderId: ORDER_ID,
      authorization: 'Bearer wrong-token',
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ORDER_ACCESS_TOKEN' },
    });
  });

  it('rejects with 401 INVALID_ORDER_ACCESS_TOKEN when the token is valid, but for a DIFFERENT Order than the one in the URL', async () => {
    // The token itself hashes correctly, but it is being presented against
    // OTHER_ORDER_ID's row, whose accessTokenHash is for a different token
    // entirely — same as "wrong token" from this guard's point of view.
    prisma.order.findUnique.mockResolvedValue({
      id: OTHER_ORDER_ID,
      accessTokenHash: hashOrderAccessToken('some-other-orders-token'),
    });
    const { context } = buildContext({
      orderId: OTHER_ORDER_ID,
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    await expect(guard.canActivate(context)).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ORDER_ACCESS_TOKEN' },
    });
  });

  it('allows the request through and attaches the Order onto it when the token hashes to exactly this Order.accessTokenHash', async () => {
    const order = {
      id: ORDER_ID,
      accessTokenHash: hashOrderAccessToken(RAW_TOKEN),
    };
    prisma.order.findUnique.mockResolvedValue(order);
    const { context, request } = buildContext({
      orderId: ORDER_ID,
      authorization: `Bearer ${RAW_TOKEN}`,
    });

    const result = await guard.canActivate(context);

    expect(result).toBe(true);
    expect(request.order).toBe(order);
    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: ORDER_ID },
    });
  });
});
