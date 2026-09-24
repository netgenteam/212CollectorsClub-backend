import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { ContactController } from './contact.controller.js';
import { ContactService } from './contact.service.js';
import { MailerModule } from '../common/mailer/mailer.module.js';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

// PrismaService is provided by the global PrismaModule — no need to
// re-import it here (same as CartModule/CatalogModule).
//
// Story 6.1 (FR-19, NFR-2): `ThrottlerModule` is imported here, scoped to
// this module, rather than registered app-wide via `APP_GUARD` in
// AppModule — the story's rate limit is specific to `POST /api/v1/contact`
// only, and `ContactController` is the only controller in this module, so
// this keeps every other endpoint in the app completely unaffected. Note
// `ThrottlerModule` itself is `@Global()` internally (its options/storage
// providers become app-wide once imported anywhere), but the *guard* is
// only ever attached via `@UseGuards(ThrottlerGuard)` on ContactController
// — nothing else in the app applies it.
@Module({
  imports: [
    MailerModule,
    ThrottlerModule.forRoot([
      {
        name: 'default',
        ttl: RATE_LIMIT_WINDOW_MS,
        limit: RATE_LIMIT_MAX_REQUESTS,
      },
    ]),
  ],
  controllers: [ContactController],
  providers: [ContactService],
})
export class ContactModule {}
