import { Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { isSwaggerEnabled } from './production-config.js';

/**
 * Story 20.11: NOT mounted with NODE_ENV=production unless SWAGGER_ENABLED=true (an explicit, documented opt-in);
 * /api/docs and /api/docs-json are then plain 404s. Outside production it stays on (SWAGGER_ENABLED=false turns it
 * off). Returns whether it was mounted.
 */
export function setupSwagger(
  app: NestExpressApplication,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!isSwaggerEnabled(env)) {
    new Logger('Bootstrap').log(
      'Swagger is not mounted (NODE_ENV=production without SWAGGER_ENABLED=true).',
    );
    return false;
  }
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
  return true;
}
