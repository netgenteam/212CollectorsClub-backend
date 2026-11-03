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
import { strictBody } from '../customer-auth/strict-body.pipe.js';
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
      'Validates against the versions in force (read from the DB) and records a RE_ACCEPT row per document not yet accepted at that version (plus AGE_DECLARATION if the customer has none; `ageDeclared: true` is then required). Repeating it is a no-op. Returns the new consent status.',
  })
  @ApiBody({ type: ReacceptConsentDto })
  @ApiResponse({ status: 200, type: ConsentStatusResponseDto })
  @ApiResponse({
    status: 400,
    description:
      'errorCode CONSENT_REQUIRED (details.missing[]: acceptedTermsVersion, acceptedPrivacyVersion, ageDeclared) or invalid/unknown field.',
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
      'errorCode LEGAL_NOT_PUBLISHED (LEGAL_REQUIRE_PUBLISHED=true and a document has no version in force) or CONSENT_BUSY (another request for this account holds the lock for > 3 s).',
  })
  reaccept(
    @Req() req: RequestWithCustomer,
    @Body(strictBody(ReacceptConsentDto)) dto: Readonly<ReacceptConsentDto>,
  ): Promise<ConsentStatusResponseDto> {
    return this.consent.reaccept((req.customer as { id: string }).id, {
      terms: dto.acceptedTermsVersion,
      privacy: dto.acceptedPrivacyVersion,
      ageDeclared: dto.ageDeclared,
    });
  }
}
