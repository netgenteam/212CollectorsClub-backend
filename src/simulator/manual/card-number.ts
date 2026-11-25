/**
 * Case-insensitive identity of a card number inside a set (story 22.10, AD-106): `lower(number)`
 * (the number is already trimmed by the DTO / CSV parser). Stored in `numberKey`; never exposed.
 * `A 1` and `A1` stay different (inner spaces are not collapsed).
 */
export const numberKeyOf = (number: string): string => number.toLowerCase();
export const numberKeyOrNull = (
  number: string | null | undefined,
): string | null => (number ? numberKeyOf(number) : null);
