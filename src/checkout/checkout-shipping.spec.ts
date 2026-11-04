import { makeTestCrypto } from '../../test/helpers/iddoc-test-crypto.js';
import {
  assertCheckoutShippingPreconditions,
  prepareCheckoutIdDoc,
  isNewShippingFormat,
  isShippingRequired,
  resolveCheckoutShipping,
} from './checkout-shipping.js';

const crypto = makeTestCrypto();
const noId = { crypto, prepared: null };
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
      ['TRUE', false],
      ['True', false],
      [' true ', false],
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
        noId,
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
        recipientIdDoc: null,
        recipientIdDocEnc: crypto.encrypt('V-12345678'),
        recipientIdDocBlind: crypto.blindIndex('V', '12345678'),
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
        noId,
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
            noId,
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
          noId,
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
        noId,
      );
      expect(r).not.toHaveProperty('recipientIdDoc');
      expect(crypto.decrypt(r.recipientIdDocEnc as string)).toBe('V-12345678');
      expect(r.recipientIdDocBlind).toBe(crypto.blindIndex('V', '12345678'));
      expect(r).toMatchObject({
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
          noId,
        ),
      ).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'SHIPPING_AGENCY_UNAVAILABLE' },
      });
    });
  });

  describe('cedula encryption (Story 20.3)', () => {
    const addr = (over: Record<string, unknown>) => ({
      recipientName: 'N',
      recipientPhone: '04121234567',
      recipientIdDoc: null,
      recipientIdDocEnc: null,
      recipientIdDocBlind: null,
      deliveryMode: 'AGENCY_OFFICE',
      agencyId: AGENCY,
      agencyBranchName: 'S',
      agencyBranchCode: null,
      addressLine1: null,
      addressLine2: null,
      state: 'Miranda',
      municipality: 'Baruta',
      parish: null,
      referencePoint: null,
      ...over,
    });
    const usable = () => ({
      assertAgencyUsable: vi.fn().mockResolvedValue({}),
    });

    it('a saved address: Enc/Blind are COPIED from the row, never decrypted nor re-encrypted', async () => {
      const enc = crypto.encrypt('E-87654321');
      const blind = crypto.blindIndex('E', '87654321');
      const spy = {
        protect: vi.fn(),
        decrypt: vi.fn(),
      };
      const r = await resolveCheckoutShipping(
        {
          customerAddress: {
            findFirst: vi
              .fn()
              .mockResolvedValue(
                addr({ recipientIdDocEnc: enc, recipientIdDocBlind: blind }),
              ),
          },
        } as never,
        usable() as never,
        { customerAddressId: ADDR },
        'cust-1',
        { crypto: spy, prepared: null },
      );
      expect(r.recipientIdDocEnc).toBe(enc);
      expect(r.recipientIdDocBlind).toBe(blind);
      expect(spy.protect).not.toHaveBeenCalled();
      expect(spy.decrypt).not.toHaveBeenCalled();
    });

    it('a legacy address (plain only, not backfilled yet): the order still gets ciphertext, never plain', async () => {
      const r = await resolveCheckoutShipping(
        {
          customerAddress: {
            findFirst: vi
              .fn()
              .mockResolvedValue(addr({ recipientIdDoc: 'V-12345678' })),
          },
        } as never,
        usable() as never,
        { customerAddressId: ADDR },
        'cust-1',
        noId,
      );
      expect(r).not.toHaveProperty('recipientIdDoc');
      expect(crypto.decrypt(r.recipientIdDocEnc as string)).toBe('V-12345678');
      expect(r.recipientIdDocBlind).toBe(crypto.blindIndex('V', '12345678'));
    });

    it('prepareCheckoutIdDoc: encrypts a valid body cedula before the transaction; null otherwise', () => {
      const p = prepareCheckoutIdDoc(
        { recipientIdDoc: ' v-12.345.678 ', municipality: 'x' },
        crypto,
      );
      expect(p?.canonical).toBe('V-12345678');
      expect(crypto.decrypt(p?.enc as string)).toBe('V-12345678');
      expect(prepareCheckoutIdDoc({ recipientName: 'a' }, crypto)).toBeNull(); // flat format
      expect(
        prepareCheckoutIdDoc(
          { customerAddressId: ADDR, recipientIdDoc: 'V12345678' },
          crypto,
        ),
      ).toBeNull(); // the saved address prevails
      expect(
        prepareCheckoutIdDoc(
          { recipientIdDoc: 'J-123456789', municipality: 'x' },
          crypto,
        ),
      ).toBeNull(); // not a recipient cedula: the builder reports SHIPPING_INVALID
      expect(
        prepareCheckoutIdDoc(
          { recipientIdDoc: 'V-****5678', municipality: 'x' },
          crypto,
        ),
      ).toBeNull(); // a masked value is never a new cedula
    });

    it('the prepared ciphertext is the one stored (not re-encrypted); a mismatching one is recomputed', async () => {
      const body = {
        recipientName: 'Ana',
        recipientPhone: '04121234567',
        recipientIdDoc: 'V12345678',
        deliveryMode: 'home_delivery',
        shippingAgencyId: AGENCY,
        addressLine1: 'x',
        state: 'M',
        municipality: 'B',
      };
      const prepared = prepareCheckoutIdDoc(body, crypto);
      const spy = { protect: vi.fn() };
      const same = await resolveCheckoutShipping(
        {} as never,
        usable() as never,
        body,
        null,
        {
          crypto: spy,
          prepared,
        },
      );
      expect(same.recipientIdDocEnc).toBe(prepared?.enc);
      expect(spy.protect).not.toHaveBeenCalled();
      const other = prepareCheckoutIdDoc(
        { ...body, recipientIdDoc: 'V87654321' },
        crypto,
      );
      const r = await resolveCheckoutShipping(
        {} as never,
        usable() as never,
        body,
        null,
        {
          crypto,
          prepared: other,
        },
      );
      expect(crypto.decrypt(r.recipientIdDocEnc as string)).toBe('V-12345678');
    });

    it('a masked cedula in the body is SHIPPING_INVALID (never stored as a cedula)', async () => {
      await expect(
        resolveCheckoutShipping(
          {} as never,
          usable() as never,
          {
            recipientName: 'Ana',
            recipientPhone: '04121234567',
            recipientIdDoc: 'V-****5678',
            deliveryMode: 'home_delivery',
            shippingAgencyId: AGENCY,
            addressLine1: 'x',
            state: 'M',
            municipality: 'B',
          },
          null,
          noId,
        ),
      ).rejects.toMatchObject({
        status: 400,
        response: { errorCode: 'SHIPPING_INVALID' },
      });
    });
  });

  describe('flat format with the cedula inside recipientName (Story 20.3 fix)', () => {
    const flat = (over: Record<string, unknown>) => ({
      recipientName: 'Ana Prueba',
      recipientPhone: '04121234567',
      addressLine1: 'L1',
      city: 'Caracas',
      state: 'DC',
      ...over,
    });
    const run = async (dto: Record<string, unknown>) => {
      const prepared = prepareCheckoutIdDoc(dto, crypto);
      return resolveCheckoutShipping({} as never, {} as never, dto, null, {
        crypto,
        prepared,
      });
    };
    const plain = (enc: string | null) => (enc ? crypto.decrypt(enc) : null);

    it.each([
      'Ana Prueba (V-70123456)',
      'Ana Prueba ( V70123456 )',
      'Ana Prueba V-70123456',
      'Ana Prueba, V-70.123.456',
      'Ana Prueba (CI: V-70123456)',
    ])('%j: name stored clean, cedula only in Enc/Blind', async (name) => {
      const r = await run(flat({ recipientName: name }));
      expect(r.recipientName).toBe('Ana Prueba');
      expect(plain(r.recipientIdDocEnc)).toBe('V-70123456');
      expect(r.recipientIdDocBlind).toBe(crypto.blindIndexOf('V-70123456'));
      expect(JSON.stringify(r)).not.toMatch(/7012\s*3456/);
    });

    it('an explicit recipientIdDoc in its own field is accepted by the flat format and wins over the name', async () => {
      const r = await run(
        flat({
          recipientIdDoc: 'v 81234567',
          recipientName: 'Ana (V-70123456)',
        }),
      );
      expect(r.recipientName).toBe('Ana');
      expect(plain(r.recipientIdDocEnc)).toBe('V-81234567');
      const r2 = await run(flat({ recipientIdDoc: 'V-70123456' }));
      expect(r2.recipientName).toBe('Ana Prueba');
      expect(plain(r2.recipientIdDocEnc)).toBe('V-70123456');
      expect(r2.shippingAgencyId).toBeNull();
      expect(r2.addressLine1).toBe('L1');
    });

    it('recipientIdDoc alone does not make the body the agency format', () => {
      expect(isNewShippingFormat({ recipientIdDoc: 'V-70123456' })).toBe(false);
      expect(
        isNewShippingFormat({
          recipientIdDoc: 'V-70123456',
          deliveryMode: 'x',
        }),
      ).toBe(true);
    });

    it.each(['Ana Prueba', 'Ana 3era', 'Ana Prueba (hermana)', 'Calle 12345'])(
      'a name without a cedula stays as it is: %j',
      async (name) => {
        const r = await run(flat({ recipientName: name }));
        expect(r.recipientName).toBe(name);
        expect(r.recipientIdDocEnc).toBeNull();
        expect(r.recipientIdDocBlind).toBeNull();
      },
    );

    it('an invalid explicit cedula (or a masked one) is 400 SHIPPING_INVALID, field only', async () => {
      for (const bad of ['abc', 'V-123', 'V-****5678', 'V-70123456*']) {
        await expect(run(flat({ recipientIdDoc: bad }))).rejects.toMatchObject({
          response: {
            errorCode: 'SHIPPING_INVALID',
            details: { errors: [{ field: 'recipientIdDoc', code: 'INVALID' }] },
          },
        });
      }
    });

    it('two different cedulas in the name, or a name that is only a cedula, are 400', async () => {
      await expect(
        run(flat({ recipientName: 'Ana (V-70123456) y Luis (E-81234567)' })),
      ).rejects.toMatchObject({ response: { errorCode: 'SHIPPING_INVALID' } });
      await expect(
        run(flat({ recipientName: '(V-70123456)' })),
      ).rejects.toMatchObject({
        response: {
          details: { errors: [{ field: 'recipientName', code: 'REQUIRED' }] },
        },
      });
    });

    it('the agency format also gets a clean name (explicit cedula wins)', async () => {
      const usable = { assertAgencyUsable: vi.fn().mockResolvedValue({}) };
      const dto = {
        recipientName: 'Ana Perez (V-70123456)',
        recipientPhone: '04121234567',
        recipientIdDoc: 'V-81234567',
        deliveryMode: 'agency_office',
        shippingAgencyId: AGENCY,
        agencyBranchName: 'Sucursal',
        state: 'Miranda',
        municipality: 'Baruta',
      };
      const prepared = prepareCheckoutIdDoc(dto, crypto);
      const r = await resolveCheckoutShipping(
        {} as never,
        usable as never,
        dto,
        null,
        { crypto, prepared },
      );
      expect(r.recipientName).toBe('Ana Perez');
      expect(plain(r.recipientIdDocEnc)).toBe('V-81234567');
    });
  });
});
