/**
 * Story 4.1: placeholder Pago Móvil receiving-account details returned to
 * the buyer in every successful checkout response. The Dev brief explicitly
 * calls out that the client's REAL store account (bank, phone, RIF/cédula)
 * is a separate, still-unresolved business gap — not something this story
 * can obtain — so these are deliberately fake/placeholder values, clearly
 * documented as such. **Before any real launch, replace these constants
 * with the client's actual Pago Móvil account.**
 *
 * `reference` is generated per-order (the Order id) by CheckoutService, not
 * hardcoded here — see `PagoMovilInstructionsDto`.
 */
export const PAGO_MOVIL_PLACEHOLDER_ACCOUNT = {
  bankName: 'Banco Mercantil (0105) — PLACEHOLDER, not a real account',
  idNumber: 'J-00000000-0',
  phone: '0412-0000000',
} as const;
