import { HttpStatus } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import type { ShippingFieldError } from './shipping-validators.js';

/**
 * 400 SHIPPING_INVALID. Story 20.4: besides `errors[]` it carries the FIRST error as
 * `details.field` / `details.reason` so the storefront can show a concrete message (e.g. about
 * the recipient cedula) without parsing the list. Names and codes only, never values (NFR-20.5).
 */
export function shippingInvalidException(
  errors: ShippingFieldError[],
): ApiException {
  const first = errors[0];
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'SHIPPING_INVALID',
    'The shipping data is invalid.',
    {
      ...(first ? { field: first.field, reason: first.code } : {}),
      errors,
    },
  );
}
