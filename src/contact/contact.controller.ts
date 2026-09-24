import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { ContactService } from './contact.service.js';
import { SubmitContactInquiryDto } from './dto/submit-contact-inquiry.dto.js';
import { ContactInquiryResponseDto } from './dto/contact-inquiry-response.dto.js';

const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;

@ApiTags('contact')
@Controller('contact')
// Story 6.1 (FR-19, NFR-2): rate limiting applied ONLY to this controller
// via a route-scoped guard — ThrottlerModule is imported by ContactModule
// alone (not registered as a global APP_GUARD), so no other endpoint in
// the app is affected by this limit, and a different IP's own budget is
// entirely independent (ThrottlerGuard keys its counters per-tracker,
// i.e. per client IP — see MailerModule-adjacent ContactModule doc for how
// that IP is derived behind the app's reverse proxy).
@UseGuards(ThrottlerGuard)
@Throttle({
  default: { limit: RATE_LIMIT_MAX_REQUESTS, ttl: RATE_LIMIT_WINDOW_MS },
})
export class ContactController {
  constructor(private readonly contactService: ContactService) {}

  /**
   * Story 6.1 (FR-18, FR-19): persists the ContactInquiry first, then
   * best-effort emails the store's admin address (ADMIN_CONTACT_EMAIL) —
   * see ContactService.submitInquiry for the full correctness reasoning.
   * Always 201 once validation passes and the row is written, regardless
   * of whether the email send itself succeeded.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Submit a contact inquiry',
    description:
      "Persists a Contact Inquiry (name, email, message, optional productId) and best-effort emails the store's administrative address. The row is always persisted once name/email/message pass validation, independent of whether the admin-notification email send succeeds — an SMTP outage is caught/logged, never a rejected request or a lost inquiry. Rate-limited to 5 submissions per IP per 10 minutes.",
  })
  @ApiResponse({
    status: HttpStatus.CREATED,
    description:
      'The inquiry was persisted (the admin-notification email may or may not have been delivered — that never affects this response).',
    type: ContactInquiryResponseDto,
  })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'Field-level validation error — a required field is missing, or email is not a valid address.',
  })
  @ApiResponse({
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'More than 5 submissions from this IP within the last 10 minutes.',
  })
  async submit(
    @Body() dto: SubmitContactInquiryDto,
  ): Promise<ContactInquiryResponseDto> {
    return this.contactService.submitInquiry(dto);
  }
}
