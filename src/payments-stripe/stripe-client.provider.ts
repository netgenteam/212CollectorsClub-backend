import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { STRIPE_CLIENT, StripeClient } from './stripe-client.interface.js';
import { StripeHttpClient } from './stripe-http-client.js';
import { FakeStripeClient } from './fake-stripe-client.js';
import { DisabledStripeClient } from './disabled-stripe-client.js';
import {
  isStripeEnabled,
  stripeProblems,
} from '../common/production-config.js';

const logger = new Logger('StripeClientProvider');

/**
 * Story 14.3 (AD-45) + Story 20.11:
 *  - `STRIPE_ENABLED=false` => `DisabledStripeClient` (checkout by Stripe answers 503, the webhook rejects all),
 *    in any environment. It is the ONLY way production runs without Stripe.
 *  - `NODE_ENV=production` => the real `StripeHttpClient`, or the boot fails (`main.ts` already checked the same
 *    rules; this repeats them so that no other entry point can ever put the fake client in production).
 *  - Otherwise: `STRIPE_SECRET_KEY` set => real client (and `STRIPE_WEBHOOK_SECRET` becomes mandatory:
 *    `getOrThrow`); unset => `FakeStripeClient` with a warning (development and tests).
 */
export const stripeClientProvider: Provider = {
  provide: STRIPE_CLIENT,
  useFactory: (
    configService: ConfigService,
    fake: FakeStripeClient,
  ): StripeClient => {
    if (
      !isStripeEnabled({ STRIPE_ENABLED: configService.get('STRIPE_ENABLED') })
    ) {
      logger.warn(
        'STRIPE_ENABLED=false: the Stripe rail is OFF. Checkout by Stripe answers 503 STRIPE_DISABLED and the webhook rejects every request.',
      );
      return new DisabledStripeClient();
    }

    const production = process.env.NODE_ENV === 'production';
    if (production) {
      const problems = stripeProblems({
        STRIPE_ENABLED: configService.get<string>('STRIPE_ENABLED'),
        STRIPE_SECRET_KEY: configService.get<string>('STRIPE_SECRET_KEY'),
        STRIPE_WEBHOOK_SECRET: configService.get<string>(
          'STRIPE_WEBHOOK_SECRET',
        ),
        STRIPE_ALLOW_TEST_KEYS: configService.get<string>(
          'STRIPE_ALLOW_TEST_KEYS',
        ),
      });
      if (problems.length > 0) {
        throw new Error(
          `Stripe is not configured for production: ${problems.join('; ')}`,
        );
      }
    }

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
