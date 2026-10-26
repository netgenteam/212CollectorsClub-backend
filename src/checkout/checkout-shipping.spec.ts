import {
  assertCheckoutShippingPreconditions,
  isNewShippingFormat,
  isShippingRequired,
  resolveCheckoutShipping,
} from './checkout-shipping.js';

const AGENCY = '0b7f3c1e-8d2a-4c5e-9a11-3f6d2b9c7e10';
const ADDR = '5d1c2f4a-1b3e-4f60-8a7b-9c0d1e2f3a4b';

describe('checkout-shipping (Story 17.4)', () => {
  const original = process.env.CHECKOUT_REQUIRE_SHIPPING;
  afterEach(() => {
    if (original === undefined) delete process.env.CHECKOUT_REQUIRE_SHIPPING;
    else process.env.CHECKOUT_REQUIRE_SHIPPING = original;
  });

  describe('isShippingRequired (read per call)', () => {
    it.each([
      [undefined, false],
      ['false', false],
      ['1', false],
      ['yes', false],
      ['', false],
      ['true', true],
      [' TRUE ', true],
    ])('%j -> %s', (v, expected) => {
      if (v === undefined) delete process.env.CHECKOUT_REQUIRE_SHIPPING;
      else process.env.CHECKOUT_REQUIRE_SHIPPING = v;
      expect(isShippingRequired()).toBe(expected);
    });

    it('reflects env changes between calls', () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      expect(isShippingRequired()).toBe(true);
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'false';
      expect(isShippingRequired()).toBe(false);
    });
  });

  describe('isNewShippingFormat', () => {
    it('is false for the flat format and true if any new field is present', () => {
      expect(isNewShippingFormat({ addressLine1: 'x', state: 'y' })).toBe(
        false,
      );
      expect(isNewShippingFormat({ parish: 'p' })).toBe(true);
      expect(isNewShippingFormat({ customerAddressId: ADDR })).toBe(true);
      expect(isNewShippingFormat({ municipality: undefined })).toBe(false);
    });
  });

  describe('assertCheckoutShippingPreconditions', () => {
    it('pickup -> 400 PICKUP_NOT_SUPPORTED', () => {
      expect(() =>
        assertCheckoutShippingPreconditions(
          { fulfillmentType: 'pickup' },
          true,
        ),
      ).toThrowError(expect.objectContaining({ status: 400 }));
    });
    it('customerAddressId without customer -> ADDRESS_REQUIRES_ACCOUNT', () => {
      try {
        assertCheckoutShippingPreconditions({ customerAddressId: ADDR }, false);
        throw new Error('no throw');
      } catch (e) {
        expect(
          (e as { response: { errorCode: string } }).response.errorCode,
        ).toBe('ADDRESS_REQUIRES_ACCOUNT');
      }
    });
    it('flat format + flag true -> SHIPPING_REQUIRED; flag off -> ok', () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      expect(() => assertCheckoutShippingPreconditions({}, false)).toThrow();
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'nope';
      expect(() =>
        assertCheckoutShippingPreconditions({}, false),
      ).not.toThrow();
    });
    it('new format passes even with the flag on', () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      expect(() =>
        assertCheckoutShippingPreconditions(
          { shippingAgencyId: AGENCY },
          false,
        ),
      ).not.toThrow();
    });
  });

  describe('resolveCheckoutShipping', () => {
    const usable = () => ({
      assertAgencyUsable: vi.fn().mockResolvedValue({}),
    });

    it('flat format keeps legacy fields and leaves new ones null', async () => {
      const r = await resolveCheckoutShipping(
        {} as never,
        usable() as never,
        {
          recipientName: 'A',
          recipientPhone: '1',
          addressLine1: 'L1',
          city: 'Caracas',
          state: 'DC',
        },
        null,
      );
      expect(r).toMatchObject({
        city: 'Caracas',
        state: 'DC',
        municipality: null,
        shippingAgencyId: null,
        deliveryMode: null,
        country: 'Venezuela',
      });
    });

    it('saved address: scoped by customer, city=municipality, active agency required', async () => {
      const findFirst = vi.fn().mockResolvedValue({
        recipientName: 'N',
        recipientPhone: '04121234567',
        recipientIdDoc: 'V-12345678',
        deliveryMode: 'AGENCY_OFFICE',
        agencyId: AGENCY,
        agencyBranchName: 'Sucursal',
        agencyBranchCode: null,
        addressLine1: null,
        addressLine2: null,
        state: 'Miranda',
        municipality: 'Baruta',
        parish: null,
        referencePoint: null,
      });
      const svc = usable();
      const r = await resolveCheckoutShipping(
        { customerAddress: { findFirst } } as never,
        svc as never,
        { customerAddressId: ADDR, state: 'IGNORED', municipality: 'IGNORED' },
        'cust-1',
      );
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: ADDR, customerId: 'cust-1' },
      });
      expect(svc.assertAgencyUsable).toHaveBeenCalledWith(
        AGENCY,
        'agency_office',
        { requireActive: true },
        expect.anything(),
      );
      expect(r).toMatchObject({
        state: 'Miranda',
        municipality: 'Baruta',
        city: 'Baruta',
        shippingAgencyId: AGENCY,
      });
    });

    it('foreign/missing/malformed address id -> same 404 ADDRESS_NOT_FOUND', async () => {
      const findFirst = vi.fn().mockResolvedValue(null);
      for (const id of [ADDR, 'not-a-uuid']) {
        await expect(
          resolveCheckoutShipping(
            { customerAddress: { findFirst } } as never,
            usable() as never,
            { customerAddressId: id },
            'cust-1',
          ),
        ).rejects.toMatchObject({
          status: 404,
          response: { errorCode: 'ADDRESS_NOT_FOUND' },
        });
      }
    });

    it('explicit body: invalid -> 400 SHIPPING_INVALID with field errors incl. missing agency', async () => {
      await expect(
        resolveCheckoutShipping(
          {} as never,
          usable() as never,
          { municipality: 'Baruta' },
          null,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: {
          errorCode: 'SHIPPING_INVALID',
          details: {
            errors: expect.arrayContaining([
              { field: 'shippingAgencyId', code: 'REQUIRED' },
              { field: 'recipientIdDoc', code: 'REQUIRED' },
            ]) as unknown,
          },
        },
      });
    });

    it('explicit body: valid -> normalized snapshot with city=municipality', async () => {
      const svc = usable();
      const r = await resolveCheckoutShipping(
        {} as never,
        svc as never,
        {
          recipientName: 'Ana',
          recipientPhone: '0412 123-4567',
          recipientIdDoc: 'v12345678',
          deliveryMode: 'home_delivery',
          shippingAgencyId: AGENCY,
          addressLine1: 'Calle 1',
          state: 'Miranda',
          municipality: 'Baruta',
        },
        null,
      );
      expect(r).toMatchObject({
        recipientIdDoc: 'V-12345678',
        recipientPhone: '04121234567',
        deliveryMode: 'HOME_DELIVERY',
        city: 'Baruta',
        shippingAgencyId: AGENCY,
      });
      expect(svc.assertAgencyUsable).toHaveBeenCalledWith(
        AGENCY,
        'home_delivery',
        { requireActive: true },
        expect.anything(),
      );
    });

    it('explicit body with non-uuid agency -> 422 SHIPPING_AGENCY_UNAVAILABLE', async () => {
      await expect(
        resolveCheckoutShipping(
          {} as never,
          usable() as never,
          {
            recipientName: 'Ana',
            recipientPhone: '04121234567',
            recipientIdDoc: 'V12345678',
            deliveryMode: 'home_delivery',
            shippingAgencyId: 'zzz',
            addressLine1: 'x',
            state: 'M',
            municipality: 'B',
          },
          null,
        ),
      ).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'SHIPPING_AGENCY_UNAVAILABLE' },
      });
    });
  });
});
