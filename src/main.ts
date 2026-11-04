import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import {
  TrustProxyConfigError,
  applyTrustProxy,
} from './common/trust-proxy.js';
import {
  applyClientIpMonitor,
  proxyStartupWarning,
} from './common/proxy-diagnostics.js';
import { applyRequestContext } from './common/request-id.middleware.js';
import { applyJsonBodyLimit } from './common/json-body-limit.js';
import { createGlobalValidationPipe } from './common/global-validation-pipe.js';
import { RedactingLogger } from './common/redacting-logger.js';
import {
  PUBLIC_STATIC_PREFIX,
  UPLOADS_PUBLIC_ROOT,
} from './admin-catalog/product-image-upload-paths.constants.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Story 14.3 (AD-47): exposes req.rawBody (Buffer) for Stripe webhook
    // signature verification; JSON parsing of every route is unchanged.
    rawBody: true,
    // Story 20.2 (FR-129): no cedula/secret ever reaches a log line.
    logger: new RedactingLogger(),
  });
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Story 6.1 (FR-19, NFR-2) / 20.5: `req.ip` is the REAL client address, taken from
  // `X-Forwarded-For` only when the connection comes from a loopback proxy (Nginx, or the Next
  // server on the same host) and only the address that proxy added: see `common/trust-proxy.ts`.
  // `@nestjs/throttler` (contact, simulator, admin login...), the view rate limit and the audit
  // events (`RequestContext.ip`) all read `req.ip`.
  const trustProxy = configService.get<string>('TRUST_PROXY');
  applyTrustProxy(app, trustProxy);
  // `HOST` (optional): the interface to bind. Unset = all interfaces (Node's default; Docker needs it).
  const host = configService.get<string>('HOST');
  // `trust proxy` fails silently when the proxy is not trusted: say so (docs/deployment.md 9.4).
  if (process.env.NODE_ENV === 'production') {
    const warning = proxyStartupWarning({
      nodeEnv: process.env.NODE_ENV,
      trustProxy,
      host,
    });
    if (warning) new Logger('Bootstrap').warn(warning);
    applyClientIpMonitor(app, {
      hasExplicitTrustProxy: (trustProxy ?? '').trim() !== '',
    });
  }

  // Story 19.2 (A78, QA E): JSON bodies are capped at 100 KB (Express' default)
  // everywhere, except PUT /admin/legal/:slug/draft (a 200 KB Markdown draft,
  // only for requests carrying a Bearer token). See `json-body-limit.ts`.
  // Story 20.1: requestId + ip context for every request, before cookie-parser.
  applyRequestContext(app);

  applyJsonBodyLimit(app);

  // Story 3.1 / AD-5: cookie-parser, given the COOKIE_SECRET from
  // @nestjs/config, signs/verifies the HttpOnly cartId cookie. It also
  // sets `req.secret`, which is what lets CartCookieService's plain
  // `res.cookie(name, value, { signed: true })` calls sign outgoing
  // cookies with this same secret. Mounted before the versioning/pipe
  // setup below since it only touches cookie parsing, not routing.
  app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));

  // Story 8.2 (AD-12): `uploads/public/` is the ONE static-mounted
  // directory in this codebase — contrast with Story 4.2's
  // `uploads/private/` (proof-of-payment), which `src/orders/upload-paths.
  // constants.ts`'s own doc comment confirms is never passed to
  // `useStaticAssets`/`ServeStaticModule` anywhere. Express's static
  // middleware is NOT routed through Nest's controller layer, so it sits
  // completely outside `setGlobalPrefix('api')`/`enableVersioning(...)`
  // below — a Product image's real URL is `<host>/uploads/public/
  // products/<file>`, never `<host>/api/v1/...`.
  app.useStaticAssets(UPLOADS_PUBLIC_ROOT, { prefix: PUBLIC_STATIC_PREFIX });

  // FR-1: every route is reachable only under /api/v1 — a global prefix
  // ("api") plus URI versioning with default version "1" combine into that
  // prefix for every controller, with no unversioned route left exposed.
  app.setGlobalPrefix('api');
  app.enableVersioning({
    type: VersioningType.URI,
    defaultVersion: '1',
  });

  // NFR-3 (Story 2.2): malformed/invalid request params get a stable 400
  // error shape everywhere, not a raw 500 from downstream Prisma/Postgres.
  app.useGlobalPipes(createGlobalValidationPipe());

  // FR-2: OpenAPI/Swagger doc generated purely from @nestjs/swagger
  // decorators on controllers/DTOs — never a hand-maintained separate doc.
  // Mounted at /api/docs, independent of the API's own /api/v1 prefix.
  const swaggerConfig = new DocumentBuilder()
    .setTitle('212CollectorsClub API')
    .setDescription(
      'Versioned REST API for the 212CollectorsClub backend (e-commerce TCG platform).',
    )
    .setVersion('1.0')
    // Story 4.2 (AD-17): documents the "Authorization: Bearer <token>"
    // scheme every orders/:orderId/... route (Proof-of-Payment upload,
    // and later Story 5.1's order lookup) expects the one-time
    // orderAccessToken in — referenced by @ApiBearerAuth() on those routes.
    // Not actually a JWT (it's a raw SHA-256-backed opaque token — see
    // CheckoutService), so `bearerFormat` is left generic rather than
    // claiming a JWT shape the token doesn't have.
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description:
        'The one-time orderAccessToken from the checkout response (Story 4.1) — an opaque token, not a JWT.',
    })
    // Story 7.1 (AD-11): a second, separately-named bearer scheme for the
    // Admin JWT (`POST /api/v1/admin/auth/login`'s `accessToken`) — kept
    // distinct from the unnamed scheme above since the two are different
    // trust boundaries with different formats (this one really is a JWT).
    // Referenced by `@ApiBearerAuth('admin-jwt')` on every
    // AdminAuthGuard-gated route.
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'The Admin JWT from POST /api/v1/admin/auth/login (8h max-age, AD-11).',
      },
      'admin-jwt',
    )
    // Story 12.3 (AD-28): the customer session is an httpOnly cookie, never a
    // bearer token (Authorization stays for admin / orderAccessToken).
    .addCookieAuth(
      'cc_session',
      { type: 'apiKey', in: 'cookie', name: 'cc_session' },
      'customer-session',
    )
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  // Story 20.5: closing the app (SIGTERM from systemd) flushes what the services keep pending,
  // such as the discarded failed-login counts (`AdminLoginFailureSummary`).
  app.enableShutdownHooks();

  if (host && host.trim() !== '') await app.listen(port, host.trim());
  else await app.listen(port);
}
try {
  await bootstrap();
} catch (err) {
  // A bad TRUST_PROXY is an operator mistake: say which variable, not a stack of Express internals.
  if (err instanceof TrustProxyConfigError) {
    new Logger('Bootstrap').error(err.message);
    process.exit(1);
  }
  throw err;
}
