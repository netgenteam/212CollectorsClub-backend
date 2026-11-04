/**
 * Story 20.3 (AD-96): the ID document columns the migration scripts know about. Table and column
 * names are CONSTANTS here and are the only identifiers ever interpolated into the scripts' SQL
 * (everything else is a bound parameter).
 *
 * Privacy rule (AC8, FR-129, A86): the cedula of an ORDER is kept encrypted for the whole fiscal
 * term. No script nulls, deletes or masks `Orders.recipientIdDoc*` / `buyerIdDoc*` irreversibly:
 * `SCRUB_SETS` (the only place that may null a plain column) lists the address book alone.
 */
export interface IdDocColumnSet {
  /** Human label used in metrics. */
  label: string;
  table: 'Orders' | 'Customer_Addresses';
  /** The legacy plain column (phase 1 fallback), or null when the set never had one. */
  plain: 'recipientIdDoc' | null;
  enc: 'recipientIdDocEnc' | 'buyerIdDocEnc';
  blind: 'recipientIdDocBlind' | 'buyerIdDocBlind';
}

export const ORDER_RECIPIENT: IdDocColumnSet = {
  label: 'orders.recipient',
  table: 'Orders',
  plain: 'recipientIdDoc',
  enc: 'recipientIdDocEnc',
  blind: 'recipientIdDocBlind',
};
export const ORDER_BUYER: IdDocColumnSet = {
  label: 'orders.buyer',
  table: 'Orders',
  plain: null,
  enc: 'buyerIdDocEnc',
  blind: 'buyerIdDocBlind',
};
export const ADDRESS_RECIPIENT: IdDocColumnSet = {
  label: 'addresses.recipient',
  table: 'Customer_Addresses',
  plain: 'recipientIdDoc',
  enc: 'recipientIdDocEnc',
  blind: 'recipientIdDocBlind',
};

/** Every encrypted column (verify, report, reencrypt, key preflight). */
export const ALL_SETS: readonly IdDocColumnSet[] = [
  ORDER_RECIPIENT,
  ORDER_BUYER,
  ADDRESS_RECIPIENT,
];
/** Sets that still have a plain column to encrypt (backfill, check). */
export const BACKFILL_SETS: readonly IdDocColumnSet[] = ALL_SETS.filter(
  (s) => s.plain !== null,
);
/** The ONLY sets whose plain column a script may null (optional, after a real verify). Never Orders. */
export const SCRUB_SETS: readonly IdDocColumnSet[] = [ADDRESS_RECIPIENT];

/** Shape of a stored ciphertext, as SQL (same as `ENC_SHAPE` in the crypto service). */
export const ENC_SHAPE_SQL =
  '^v[0-9]{1,4}:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$';
/** A plain value with something other than whitespace/invisible characters in it (blank values have nothing to protect). */
export const NOT_BLANK_SQL = '[^[:space:]​-‍⁠﻿]';

/**
 * Columns whose TEXT may carry a cedula inside a person's name (the legacy storefront sent
 * `"Ana (V-70123456)"` in `recipientName`). The name is extracted into the set's `Enc/Blind` and
 * cleaned only after the ciphertext is verified by decryption (see `cleanNames`). This is NOT a
 * purge: the cedula stays recoverable in `Enc`.
 */
export interface NameColumnSet {
  set: IdDocColumnSet;
  /** Always a constant: the only column name ever interpolated for the name phase. */
  nameCol: 'recipientName';
}
export const NAME_SETS: readonly NameColumnSet[] = [
  { set: ORDER_RECIPIENT, nameCol: 'recipientName' },
  { set: ADDRESS_RECIPIENT, nameCol: 'recipientName' },
];
/** Loose SQL prefilter for the name scan: a name without any digit cannot hold a cedula. */
export const NAME_GATE_SQL = '[[:digit:]０-９]';
