import './common/env-at-import.js';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, VersioningType } from '@nestjs/common';
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
import { UsageLogBuffer } from './usage/usage-log.buffer.js';
import { applyUsageLog } from './usage/usage-log.middleware.js';
import { applyJsonBodyLimit } from './common/json-body-limit.js';
import { createGlobalValidationPipe } from './common/global-validation-pipe.js';
import { installShutdownDeadline } from './common/shutdown-deadline.js';
import {
  ProductionConfigError,
  assertProductionConfig,
} from './common/production-config.js';
import { setupSwagger } from './common/swagger-setup.js';
import { applySecurityHeaders } from './common/security-headers.js';
import { RedactingLogger } from './common/redacting-logger.js';
import {
  PUBLIC_STATIC_PREFIX,
  UPLOADS_PUBLIC_ROOT,
} from './admin-catalog/product-image-upload-paths.constants.js';

async function bootstrap() {
  // Story 20.11: with NODE_ENV=production a dev secret, the fake Stripe client or LEGAL_REQUIRE_PUBLISHED=false
  // stop the boot here, naming the variable (never its value), before Nest, the database or the port are touched.
  // `.env` is already loaded (env-at-import, imported first, the same file ConfigModule reads).
  assertProductionConfig(process.env);
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

  // Story 20.11: helmet headers on every response (static files and errors included), before anything else.
  applySecurityHeaders(app, process.env);

  // Story 20.7 (AD-100): the usage log. A plain Express middleware (an interceptor would not see a 404
  // nor a request a guard rejected), right after the request id it records and before cookie-parser.
  // It only queues a row when the response finishes; the write is asynchronous and never blocks.
  // `USAGE_LOG_ENABLED=false` mounts nothing.
  applyUsageLog(app, app.get(UsageLogBuffer));

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

  // FR-2 / Story 20.11: OpenAPI/Swagger at /api/docs (see common/swagger-setup.ts for the production rule).
  setupSwagger(app, process.env);

  // Story 20.5: closing the app (SIGTERM from systemd) flushes what the services keep pending,
  // such as the discarded failed-login counts (`AdminLoginFailureSummary`), and (Story 20.7) the usage
  // rows still in memory (`UsageLogBuffer.onModuleDestroy`, 2 s at most, before Prisma disconnects).
  app.enableShutdownHooks();
  // Story 20.7 round 2: a database that does not answer can no longer keep the process alive for minutes.
  installShutdownDeadline(app);

  if (host && host.trim() !== '') await app.listen(port, host.trim());
  else await app.listen(port);
}
try {
  await bootstrap();
} catch (err) {
  // A bad TRUST_PROXY is an operator mistake: say which variable, not a stack of Express internals.
  if (err instanceof ProductionConfigError) {
    new Logger('Bootstrap').error(err.message);
    process.exit(1);
  }
  if (err instanceof TrustProxyConfigError) {
    new Logger('Bootstrap').error(err.message);
    process.exit(1);
  }
  throw err;
}
