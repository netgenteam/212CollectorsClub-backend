import { registerDecorator, type ValidationOptions } from 'class-validator';

/** Decimal(10,2) ceiling of `Simulator_Cards.marketPriceUsd`. */
export const PRICE_USD_MAX = 99_999_999.99;

/**
 * Safe USD price check (22.5, reused by 22.7 CSV): a finite JSON number, 0..PRICE_USD_MAX, at most
 * 2 decimals. Does NOT use `toString()` (class-validator's `maxDecimalPlaces` throws a TypeError, a
 * 500, on exponent forms such as `1e-7`).
 */
export function isValidPriceUsd(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (v < 0 || v > PRICE_USD_MAX) return false;
  // exact round trip through cents: 0.29 passes, 1.005 / 1e-7 / 1e-10 do not
  return Math.round(v * 100) / 100 === v;
}

export function IsPriceUsd(options?: ValidationOptions) {
  return (target: object, propertyName: string): void =>
    registerDecorator({
      name: 'isPriceUsd',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be a number between 0 and ${PRICE_USD_MAX} with at most 2 decimals`,
        ...options,
      },
      validator: { validate: (value: unknown) => isValidPriceUsd(value) },
    });
}
