import type { ExecutionContext } from '@nestjs/common';
import {
  CustomerAuthGuard,
  OptionalCustomerGuard,
} from './customer-auth.guard.js';
import type { CustomerAuth } from '../auth-core/customer-auth.factory.js';

function makeContext(cookie?: string) {
  const request: Record<string, unknown> = {
    headers: cookie ? { cookie } : {},
  };
  const response = { append: vi.fn() };
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
  return { context, request, response };
}

function authWith(getSession: ReturnType<typeof vi.fn>): CustomerAuth {
  return { api: { getSession } } as unknown as CustomerAuth;
}

const SESSION = {
  user: {
    id: 'u1',
    email: 'a@b.co',
    name: 'A',
    phone: null,
    emailVerified: false,
    createdAt: new Date(),
  },
  session: { token: 'tok' },
};

/** Story 12.3 (AD-28): hand-rolled customer guards. */
describe('CustomerAuthGuard / OptionalCustomerGuard', () => {
  it('401 INVALID_CUSTOMER_TOKEN without a cookie, without calling BetterAuth', async () => {
    const getSession = vi.fn();
    const { context } = makeContext();
    await expect(
      new CustomerAuthGuard(authWith(getSession)).canActivate(context),
    ).rejects.toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_CUSTOMER_TOKEN' },
    });
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    [
      'null session',
      () => Promise.resolve({ response: null, headers: new Headers() }),
    ],
    ['BetterAuth throws', () => Promise.reject(new Error('boom'))],
  ])('401 when %s', async (_name, impl) => {
    const { context } = makeContext('cc_session=x');
    await expect(
      new CustomerAuthGuard(authWith(vi.fn(impl))).canActivate(context),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('attaches a hash-free customer, forwards only the Cookie header and re-emits a refreshed Set-Cookie', async () => {
    const headers = new Headers();
    headers.append('set-cookie', 'cc_session=new; Path=/; HttpOnly');
    const getSession = vi
      .fn()
      .mockResolvedValue({ response: SESSION, headers });
    const { context, request, response } = makeContext('cc_session=x');
    (request.headers as Record<string, string>).authorization = 'Bearer admin';

    await expect(
      new CustomerAuthGuard(authWith(getSession)).canActivate(context),
    ).resolves.toBe(true);

    const forwarded = (getSession.mock.calls[0][0] as { headers: Headers })
      .headers;
    expect(forwarded.get('cookie')).toBe('cc_session=x');
    expect(forwarded.get('authorization')).toBeNull();
    expect(request.customer).toEqual({
      id: 'u1',
      email: 'a@b.co',
      name: 'A',
      phone: null,
      emailVerified: false,
    });
    expect(request.customerSessionToken).toBe('tok');
    expect(response.append).toHaveBeenCalledWith(
      'Set-Cookie',
      'cc_session=new; Path=/; HttpOnly',
    );
  });

  it('OptionalCustomerGuard never rejects: guest when invalid, customer when valid', async () => {
    const bad = makeContext('cc_session=x');
    await expect(
      new OptionalCustomerGuard(
        authWith(vi.fn().mockRejectedValue(new Error('x'))),
      ).canActivate(bad.context),
    ).resolves.toBe(true);
    expect(bad.request.customer).toBeUndefined();

    const good = makeContext('cc_session=x');
    await new OptionalCustomerGuard(
      authWith(
        vi
          .fn()
          .mockResolvedValue({ response: SESSION, headers: new Headers() }),
      ),
    ).canActivate(good.context);
    expect(good.request.customer).toMatchObject({ id: 'u1' });
  });
});
