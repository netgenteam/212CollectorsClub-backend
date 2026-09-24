import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { VersioningType } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module.js';
import { createGlobalValidationPipe } from './common/global-validation-pipe.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);
  const port = configService.get<number>('PORT', 3000);

  // Story 3.1 / AD-5: cookie-parser, given the COOKIE_SECRET from
  // @nestjs/config, signs/verifies the HttpOnly cartId cookie. It also
  // sets `req.secret`, which is what lets CartCookieService's plain
  // `res.cookie(name, value, { signed: true })` calls sign outgoing
  // cookies with this same secret. Mounted before the versioning/pipe
  // setup below since it only touches cookie parsing, not routing.
  app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));

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
    .build();
  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  await app.listen(port);
}
await bootstrap();
