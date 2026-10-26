export type DeliveryModeWire = 'agency_office' | 'home_delivery';

export interface ShippingInput {
  recipientName?: string | null;
  recipientPhone?: string | null;
  recipientIdDoc?: string | null;
  deliveryMode?: DeliveryModeWire | null;
  agencyBranchName?: string | null;
  agencyBranchCode?: string | null;
  state?: string | null;
  municipality?: string | null;
  parish?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  referencePoint?: string | null;
}

export interface ShippingValue {
  recipientName: string;
  recipientPhone: string;
  recipientIdDoc: string;
  deliveryMode: DeliveryModeWire;
  agencyBranchName: string | null;
  agencyBranchCode: string | null;
  state: string;
  municipality: string;
  parish: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  referencePoint: string | null;
}

export interface ShippingFieldError {
  field: string;
  code: 'REQUIRED' | 'INVALID';
}

export type ShippingValidation =
  | { value: ShippingValue; errors?: undefined }
  | { value?: undefined; errors: ShippingFieldError[] };

/** Story 17.2 (AD-71): `v12345678` -> `V-12345678`; anything else -> null. */
export function normalizeIdDoc(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s.-]/g, '');
  const m = /^([VE])(\d{6,9})$/.exec(s);
  return m ? `${m[1]}-${m[2]}` : null;
}

/** Strips separators; optional leading `+`; 10-15 digits, else null. */
export function normalizePhone(raw: string): string | null {
  const s = raw.replace(/[\s.()-]/g, '');
  const m = /^(\+?)(\d{10,15})$/.exec(s);
  return m ? `${m[1]}${m[2]}` : null;
}

const clean = (v: string | null | undefined): string | null => {
  const t = typeof v === 'string' ? v.trim() : '';
  return t === '' ? null : t;
};

/**
 * FR-85 cross-field rules. Errors carry field names and codes only, never
 * values (NFR-17.4: no ID/phone/address in responses or logs).
 */
export function validateShippingInput(
  input: ShippingInput,
): ShippingValidation {
  const errors: ShippingFieldError[] = [];
  const need = (field: string, v: string | null): string => {
    if (v === null) errors.push({ field, code: 'REQUIRED' });
    return v ?? '';
  };

  const recipientName = need('recipientName', clean(input.recipientName));
  const state = need('state', clean(input.state));
  const municipality = need('municipality', clean(input.municipality));

  let recipientPhone = '';
  const phoneRaw = clean(input.recipientPhone);
  if (phoneRaw === null)
    errors.push({ field: 'recipientPhone', code: 'REQUIRED' });
  else {
    const p = normalizePhone(phoneRaw);
    if (p === null) errors.push({ field: 'recipientPhone', code: 'INVALID' });
    else recipientPhone = p;
  }

  let recipientIdDoc = '';
  const idRaw = clean(input.recipientIdDoc);
  if (idRaw === null)
    errors.push({ field: 'recipientIdDoc', code: 'REQUIRED' });
  else {
    const d = normalizeIdDoc(idRaw);
    if (d === null) errors.push({ field: 'recipientIdDoc', code: 'INVALID' });
    else recipientIdDoc = d;
  }

  const mode = input.deliveryMode;
  if (mode !== 'agency_office' && mode !== 'home_delivery') {
    errors.push({ field: 'deliveryMode', code: 'REQUIRED' });
  }
  const addressLine1 = clean(input.addressLine1);
  const agencyBranchName = clean(input.agencyBranchName);
  if (mode === 'home_delivery' && addressLine1 === null) {
    errors.push({ field: 'addressLine1', code: 'REQUIRED' });
  }
  if (mode === 'agency_office' && agencyBranchName === null) {
    errors.push({ field: 'agencyBranchName', code: 'REQUIRED' });
  }

  if (errors.length > 0) return { errors };
  return {
    value: {
      recipientName,
      recipientPhone,
      recipientIdDoc,
      deliveryMode: mode as DeliveryModeWire,
      agencyBranchName,
      agencyBranchCode: clean(input.agencyBranchCode),
      state,
      municipality,
      parish: clean(input.parish),
      addressLine1,
      addressLine2: clean(input.addressLine2),
      referencePoint: clean(input.referencePoint),
    },
  };
}
