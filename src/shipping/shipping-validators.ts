import { normalizeIdDoc } from '../crypto/id-doc-normalize.js';

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

/**
 * Story 17.2 (AD-71) + 20.3: the RECIPIENT rule for a delivery: only V/E with 6..9 digits.
 * `v12345678` -> `V-12345678`; anything else -> null. The canonical text comes from the single
 * normalizer of `src/crypto` (`normalizeIdDoc`, A87): this function only adds the policy
 * (types and length), it does not parse by itself, so the two can never disagree on what the
 * same cedula looks like. (It used to be a second function with the same name.)
 */
export function canonicalRecipientIdDoc(raw: string): string | null {
  const n = normalizeIdDoc(raw);
  if (!n || n.unparsed) return null;
  if (n.type !== 'V' && n.type !== 'E') return null;
  return /^\d{6,9}$/.test(n.digits) ? n.canonical : null;
}

/** A value the API itself returns (`V-****5678`) and a client may echo back: never a new cedula. */
export const isMaskedIdDoc = (raw: string): boolean => raw.includes('*');

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
  opts: { idDoc?: 'required' | 'keep' } = {},
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

  // `keep` (address edit, Story 20.3): the stored cedula is encrypted and stays as it is, so it is
  // not validated here; the value returned is '' and the caller must not write it.
  let recipientIdDoc = '';
  const idRaw = clean(input.recipientIdDoc);
  if (opts.idDoc === 'keep') {
    // nothing to check
  } else if (idRaw === null)
    errors.push({ field: 'recipientIdDoc', code: 'REQUIRED' });
  else {
    const d = canonicalRecipientIdDoc(idRaw);
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
