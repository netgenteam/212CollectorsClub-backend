import { ApiException } from '../common/api-exception.js';
import { ShippingValidationService } from './shipping-validation.service.js';

const agency = {
  id: 'a',
  code: 'DOMESA',
  isActive: true,
  allowsOfficePickup: true,
  allowsHomeDelivery: false,
};

function build(row: object | null) {
  const findUnique = vi.fn().mockResolvedValue(row);
  const svc = new ShippingValidationService({
    shippingAgency: { findUnique },
  } as never);
  return { svc, findUnique };
}

async function failure(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
      details?: unknown;
    };
  }
  return null;
}

describe('ShippingValidationService.assertAgencyUsable', () => {
  it('missing agency -> 422 SHIPPING_AGENCY_UNAVAILABLE', async () => {
    const { svc } = build(null);
    const r = await failure(
      svc.assertAgencyUsable('x', 'agency_office', { requireActive: true }),
    );
    expect(r).toMatchObject({
      statusCode: 422,
      errorCode: 'SHIPPING_AGENCY_UNAVAILABLE',
    });
  });

  it('inactive agency: rejected when requireActive, accepted otherwise', async () => {
    const { svc } = build({ ...agency, isActive: false });
    expect(
      await failure(
        svc.assertAgencyUsable('a', 'agency_office', { requireActive: true }),
      ),
    ).toMatchObject({ errorCode: 'SHIPPING_AGENCY_UNAVAILABLE' });
    await expect(
      svc.assertAgencyUsable('a', 'agency_office', { requireActive: false }),
    ).resolves.toMatchObject({ code: 'DOMESA' });
  });

  it('mode not allowed -> 422 DELIVERY_MODE_NOT_ALLOWED with details', async () => {
    const { svc } = build(agency);
    expect(
      await failure(
        svc.assertAgencyUsable('a', 'home_delivery', { requireActive: true }),
      ),
    ).toMatchObject({
      statusCode: 422,
      errorCode: 'DELIVERY_MODE_NOT_ALLOWED',
      details: { agencyCode: 'DOMESA', deliveryMode: 'home_delivery' },
    });
  });

  it('single query per call; uses tx when given', async () => {
    const { svc, findUnique } = build(agency);
    await svc.assertAgencyUsable('a', 'agency_office', { requireActive: true });
    expect(findUnique).toHaveBeenCalledTimes(1);
    const txFind = vi.fn().mockResolvedValue(agency);
    await svc.assertAgencyUsable(
      'a',
      'agency_office',
      { requireActive: true },
      { shippingAgency: { findUnique: txFind } } as never,
    );
    expect(txFind).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledTimes(1);
  });
});
