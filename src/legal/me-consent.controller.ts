import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CustomerAuthGuard,
  type RequestWithCustomer,
} from '../common/customer-auth.guard.js';
import {
  requireObjectBody,
  strictBody,
} from '../customer-auth/strict-body.pipe.js';
import { ConsentService } from './consent.service.js';
import {
  ConsentStatusResponseDto,
  ReacceptConsentDto,
} from './dto/consent.dto.js';

/**
 * Story 19.4 (AD-92, FR-115): the customer's own consent state. Customer
 * session only (an admin Bearer never authenticates here).
 */
@ApiTags('customer-auth')
@Controller('me')
@UseGuards(CustomerAuthGuard)
@ApiCookieAuth('customer-session')
export class MeConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Get('consent-status')
  @ApiOperation({
    summary: 'Which legal documents the customer still has to accept',
    description:
      'Only `terminos` and `privacidad`, and only when they have a version in force: pending if never accepted (an acceptance made in an account checkout counts) or older than the last substantial version; a non-substantial change is not pending. Plus `ageDeclarationPending`. Never blocks browsing or the order history.',
  })
  @ApiResponse({ status: 200, type: ConsentStatusResponseDto })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  status(@Req() req: RequestWithCustomer): Promise<ConsentStatusResponseDto> {
    return this.consent.status((req.customer as { id: string }).id);
  }

  @Post('consent')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-accept the current Terms and Privacy Policy',
    description:
      'Requires the version (read from the DB as the one in force) of each document PENDING for this account (see consent-status) and records a RE_ACCEPT row for exactly those; a version of a non-pending document is optional (omitted and `null` are the same): if sent it must be the one in force (else 409) and nothing is recorded for it. Nothing is ever recorded beyond what is pending and sent (plus AGE_DECLARATION if the customer has none; `ageDeclared: true` is then required). Repeating it is a no-op. Returns the new consent status.',
  })
  @ApiBody({ type: ReacceptConsentDto })
  @ApiResponse({ status: 200, type: ConsentStatusResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'errorCode CONSENT_REQUIRED (details.missing[]: the pending document(s) whose version was not sent: acceptedTermsVersion / acceptedPrivacyVersion, and ageDeclared when the age declaration is pending; nothing is recorded) or invalid/unknown field, or a body that is not a JSON object (an array, for instance; an empty body counts as `{}`).',
  })
  @ApiResponse({
    status: 401,
    description: 'errorCode INVALID_CUSTOMER_TOKEN.',
  })
  @ApiResponse({
    status: 409,
    description:
      'errorCode CONSENT_VERSION_STALE (details.current{slug: versionNumber}, details.stale[]).',
  })
  @ApiResponse({
    status: 503,
    description:
      'errorCode LEGAL_NOT_PUBLISHED (LEGAL_REQUIRE_PUBLISHED=true and a document has no version in force), CONSENT_BUSY (another request for this account holds the lock for > 3 s) or AUDIT_UNAVAILABLE (the CONSENT_RECORDED event could not be written to the immutable audit log: fail-closed, nothing was recorded, retry).',
  })
  reaccept(
    @Req() req: RequestWithCustomer,
    @Body(requireObjectBody, strictBody(ReacceptConsentDto))
    dto: Readonly<ReacceptConsentDto>,
  ): Promise<ConsentStatusResponseDto> {
    return this.consent.reaccept((req.customer as { id: string }).id, {
      terms: dto.acceptedTermsVersion,
      privacy: dto.acceptedPrivacyVersion,
      ageDeclared: dto.ageDeclared,
    });
  }
}
