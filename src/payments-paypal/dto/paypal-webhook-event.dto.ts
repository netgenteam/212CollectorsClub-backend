import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

/**
 * Story 4.3: body of `POST /api/v1/payments/paypal/webhook`.
 *
 * **Why only `paypalOrderId` (plus an informational `eventType`), not
 * PayPal's full real webhook envelope**: a real PayPal webhook body is a
 * much richer `{ id, event_type, resource: {...} }` shape, where the
 * PayPal Order id lives at different paths depending on the event
 * (`resource.id` for an order-level event like `CHECKOUT.ORDER.APPROVED`;
 * `resource.supplementary_data.related_ids.order_id` for a capture-level
 * event like `PAYMENT.CAPTURE.COMPLETED`). Extracting that id is a pure
 * parsing concern, orthogonal to this story's actual point — this DTO
 * models the one thing that matters to `PaypalPaymentsService` directly,
 * so the mock/real boundary here stays about "does the backend
 * independently re-verify with PayPal" (the part this codebase CAN fully
 * build and test without real credentials), not about the concrete JSON
 * shape of PayPal's real webhook envelope (which cannot be verified here
 * either way — see the Dev report). A real deployment would add a thin
 * adapter in front of this controller (or inside it) that maps PayPal's
 * real envelope onto this same `{ paypalOrderId, eventType }` shape before
 * calling `PaypalPaymentsService`.
 *
 * **`eventType` is never trusted for the paid/failed decision** — see
 * `PaypalPaymentsService.confirmPayment`'s own doc comment. It is carried
 * here purely for structured logging/observability.
 */
export class PaypalWebhookEventDto {
  @ApiProperty({
    example: 'FAKE-PP-ORDER-1-a1b2c3d4',
    description:
      'The PayPal Order id this event concerns. The backend looks up the matching local Order by this value (Order.paypalOrderId) and then independently re-verifies the outcome by calling PayPal itself — this field is only ever used to know WHICH order to ask about, never to decide paid/failed on its own.',
  })
  @IsString()
  @IsNotEmpty()
  paypalOrderId: string;

  @ApiPropertyOptional({
    example: 'PAYMENT.CAPTURE.COMPLETED',
    description:
      'Informational only (logging/observability) — NEVER used to decide paid vs. failed. That decision is always made from a fresh, independent call to the PayPal client (see PaypalPaymentsService).',
  })
  @IsOptional()
  @IsString()
  eventType?: string;
}
