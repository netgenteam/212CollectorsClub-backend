import { Logger, Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PAYPAL_CLIENT, PaypalClient } from './paypal-client.interface.js';
import { PaypalHttpClient } from './paypal-http-client.js';
import { FakePaypalClient } from './fake-paypal-client.js';

const logger = new Logger('PaypalClientProvider');

/**
 * Story 4.3: selects which `PaypalClient` implementation the rest of the
 * app gets injected, based purely on whether real PayPal credentials are
 * configured — no code change is needed to go from "fake" to "real" later,
 * only setting `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` (see
 * `.env.example`).
 *
 * This dev environment has neither set (no PayPal Sandbox account
 * available here — see the Story 4.3 Dev report), so every environment
 * this code has actually run in — `pnpm test`, `pnpm test:e2e`, and the
 * live `curl` verification in the Dev report — used `FakePaypalClient`.
 * `FakePaypalClient` is registered as its own provider (not constructed ad
 * hoc here) specifically so a test can `app.get(FakePaypalClient)` and
 * script an outcome (`setOutcome`/`registerOrder`) against the exact same
 * singleton instance the app is actually using.
 */
export const paypalClientProvider: Provider = {
  provide: PAYPAL_CLIENT,
  useFactory: (
    configService: ConfigService,
    fake: FakePaypalClient,
  ): PaypalClient => {
    const clientId = configService.get<string>('PAYPAL_CLIENT_ID');
    const clientSecret = configService.get<string>('PAYPAL_CLIENT_SECRET');

    if (clientId && clientSecret) {
      logger.log(
        'PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET configured — using PaypalHttpClient (real SDK).',
      );
      return new PaypalHttpClient(configService);
    }

    logger.warn(
      'PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET not configured — using FakePaypalClient. ' +
        'PayPal checkout/confirmation will work end-to-end against Postgres, but no real ' +
        'PayPal API call is ever made. Set both env vars to activate the real client.',
    );
    return fake;
  },
  inject: [ConfigService, FakePaypalClient],
};
