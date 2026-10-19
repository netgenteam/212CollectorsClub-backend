import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STRIPE_CLIENT, StripeClient } from './stripe-client.interface.js';
import { StripeHttpClient } from './stripe-http-client.js';
import { FakeStripeClient } from './fake-stripe-client.js';

const logger = new Logger('StripeClientProvider');

/**
 * Story 14.3 (AD-45): `STRIPE_SECRET_KEY` set => real `StripeHttpClient`
 * (and `STRIPE_WEBHOOK_SECRET` becomes mandatory: `getOrThrow` fails the
 * boot). Unset => `FakeStripeClient` with a warning.
 */
export const stripeClientProvider: Provider = {
  provide: STRIPE_CLIENT,
  useFactory: (
    configService: ConfigService,
    fake: FakeStripeClient,
  ): StripeClient => {
    const secretKey = configService.get<string>('STRIPE_SECRET_KEY');

    if (secretKey) {
      configService.getOrThrow<string>('STRIPE_WEBHOOK_SECRET');
      logger.log('STRIPE_SECRET_KEY configured — using StripeHttpClient.');
      return new StripeHttpClient(configService);
    }

    logger.warn(
      'STRIPE_SECRET_KEY not configured — using FakeStripeClient. No real ' +
        'Stripe API call is ever made. Set STRIPE_SECRET_KEY and ' +
        'STRIPE_WEBHOOK_SECRET to activate the real client.',
    );
    return fake;
  },
  inject: [ConfigService, FakeStripeClient],
};
