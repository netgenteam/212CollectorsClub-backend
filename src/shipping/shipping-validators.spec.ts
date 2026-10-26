import {
  normalizeIdDoc,
  normalizePhone,
  validateShippingInput,
  type ShippingInput,
} from './shipping-validators.js';

describe('normalizeIdDoc', () => {
  it.each([
    ['v12345678', 'V-12345678'],
    [' V 12.345.678 ', 'V-12345678'],
    ['e-1234567', 'E-1234567'],
    ['V-123456', 'V-123456'],
    ['X-1', null],
    ['V-12', null],
    ['J-12345678', null],
    ['V-1234567890', null],
    ['', null],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeIdDoc(raw)).toBe(expected);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['+58 (412) 123-4567', '+584121234567'],
    ['0412-123.4567', '04121234567'],
    ['123456789', null],
    ['1234567890123456', null],
    ['12345678901234', '12345678901234'],
    ['abc4121234567', null],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizePhone(raw)).toBe(expected);
  });
});

describe('validateShippingInput', () => {
  const base: ShippingInput = {
    recipientName: ' Maria Perez ',
    recipientPhone: '+58 412 123 4567',
    recipientIdDoc: 'v12345678',
    state: 'Miranda',
    municipality: 'Baruta',
  };

  it('home_delivery: ok and normalized', () => {
    const r = validateShippingInput({
      ...base,
      deliveryMode: 'home_delivery',
      addressLine1: 'Calle 1',
    });
    expect(r.errors).toBeUndefined();
    expect(r.value).toMatchObject({
      recipientName: 'Maria Perez',
      recipientPhone: '+584121234567',
      recipientIdDoc: 'V-12345678',
      addressLine2: null,
      agencyBranchName: null,
    });
  });

  it('home_delivery requires addressLine1', () => {
    const r = validateShippingInput({ ...base, deliveryMode: 'home_delivery' });
    expect(r.errors).toEqual([{ field: 'addressLine1', code: 'REQUIRED' }]);
  });

  it('agency_office requires agencyBranchName but not addressLine1', () => {
    expect(
      validateShippingInput({ ...base, deliveryMode: 'agency_office' }).errors,
    ).toEqual([{ field: 'agencyBranchName', code: 'REQUIRED' }]);
    expect(
      validateShippingInput({
        ...base,
        deliveryMode: 'agency_office',
        agencyBranchName: 'Oficina Centro',
      }).value,
    ).toBeDefined();
  });

  it('reports missing/invalid fields without echoing values', () => {
    const r = validateShippingInput({
      recipientPhone: '123',
      recipientIdDoc: 'X-1',
      deliveryMode: 'agency_office',
    });
    expect(r.errors).toEqual([
      { field: 'recipientName', code: 'REQUIRED' },
      { field: 'state', code: 'REQUIRED' },
      { field: 'municipality', code: 'REQUIRED' },
      { field: 'recipientPhone', code: 'INVALID' },
      { field: 'recipientIdDoc', code: 'INVALID' },
      { field: 'agencyBranchName', code: 'REQUIRED' },
    ]);
    expect(JSON.stringify(r)).not.toContain('X-1');
  });

  it('missing deliveryMode is an error', () => {
    expect(validateShippingInput(base).errors).toContainEqual({
      field: 'deliveryMode',
      code: 'REQUIRED',
    });
  });
});
