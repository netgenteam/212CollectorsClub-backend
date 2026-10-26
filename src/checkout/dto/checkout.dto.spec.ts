import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutDto } from './checkout.dto.js';

const errs = async (o: object) =>
  (await validate(plainToInstance(CheckoutDto, o))).map((e) => e.property);

describe('CheckoutDto (Story 17.4)', () => {
  it('pickup without recipient/address passes DTO validation so the service answers PICKUP_NOT_SUPPORTED', async () => {
    expect(
      await errs({ paymentRail: 'pago_movil', fulfillmentType: 'pickup' }),
    ).toEqual([]);
  });
  it('flat delivery still requires recipient and address', async () => {
    expect(await errs({ paymentRail: 'pago_movil' })).toEqual(
      expect.arrayContaining([
        'recipientName',
        'recipientPhone',
        'addressLine1',
      ]),
    );
  });
  it('new format does not require flat recipient/address in the DTO', async () => {
    expect(
      await errs({ paymentRail: 'pago_movil', shippingAgencyId: 'x' }),
    ).toEqual([]);
  });
});
