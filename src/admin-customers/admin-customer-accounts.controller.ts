import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { ApiException } from '../common/api-exception.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { assertNoIdDocInQuery } from '../common/id-doc-not-in-url.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { CustomerAnonymizationService } from './customer-anonymization.service.js';
import { CustomerDirectoryService } from './customer-directory.service.js';
import {
  AnonymizeCustomerDto,
  AnonymizeCustomerResponseDto,
} from './dto/anonymize-customer.dto.js';
import {
  AdminCustomerDetailDto,
  AdminCustomerListResponseDto,
} from './dto/admin-customer-response.dto.js';
import { SearchCustomersDto } from './dto/search-customers.dto.js';

const SEARCH_PATH = 'POST /admin/customers/search';

/**
 * Story 20.6 (AD-97, AD-98, FR-119..122, FR-124). The customer accounts for the admin: list, search
 * (the email fragment and the cedula go in the BODY of a POST, never in a URL), detail and the
 * irreversible anonymization. Separate from `AdminCustomersController` (13.1, behind a feature
 * flag guard that answers 404 to everything under its class). Static routes first.
 */
@ApiTags('admin-customers')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/customers')
export class AdminCustomerAccountsController {
  constructor(
    private readonly directory: CustomerDirectoryService,
    private readonly anonymization: CustomerAnonymizationService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiOperation({
    summary: 'List customer accounts, newest first (admin)',
    description:
      'Cursor pagination (`meta.nextCursor`), 50 per page. The ONLY accepted query parameter is `cursor`: to search, use POST /admin/customers/search (an email fragment or a cedula in a URL ends up in proxy logs). A query that carries an ID document (a key such as `idDoc`, `id-doc`, `rif`, `ci`, `documento`..., or a value shaped like a cedula) is 400 ID_DOC_IN_URL_NOT_ALLOWED, without being echoed and without querying anything.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminCustomerListResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode ID_DOC_IN_URL_NOT_ALLOWED; QUERY_PARAM_NOT_ALLOWED (any parameter but `cursor`); CURSOR_INVALID.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  list(
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminCustomerListResponseDto> {
    // First thing: before anything else looks at the query (or queries).
    assertNoIdDocInQuery(request.query, SEARCH_PATH);
    const keys = Object.keys(request.query);
    const cursor = request.query.cursor;
    if (
      keys.some((k) => k !== 'cursor') ||
      (cursor !== undefined && typeof cursor !== 'string')
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'QUERY_PARAM_NOT_ALLOWED',
        'Only `cursor` is accepted in the URL. To search use POST /admin/customers/search.',
      );
    }
    res.setHeader('Cache-Control', 'no-store');
    return this.directory.list(cursor);
  }

  @Post('search')
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: SearchCustomersDto })
  @ApiOperation({
    summary: 'Search customer accounts (admin)',
    description:
      'Partial email/name (`q`) and EXACT ID document (`idDoc`, by blind index: the customers with a saved address or an order carrying it) in the BODY, combinable (AND), with a cursor (50 per page). Never errors on no matches (empty page, 200). The URL must carry no ID document (400 ID_DOC_IN_URL_NOT_ALLOWED, also for `POST ...?idDoc=`).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminCustomerListResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'errorCode ID_DOC_FILTER_INVALID (`idDoc` is not a complete valid ID document; never echoed); CURSOR_INVALID; ID_DOC_IN_URL_NOT_ALLOWED; or a malformed body field (unknown property, q shorter than 2).',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  search(
    @Body(strictBody(SearchCustomersDto)) dto: Readonly<SearchCustomersDto>,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminCustomerListResponseDto> {
    assertNoIdDocInQuery(request.query, SEARCH_PATH);
    res.setHeader('Cache-Control', 'no-store');
    return this.directory.search(dto);
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Customer detail with the anonymization preview (admin)',
    description:
      'Data of the account, its addresses (ID document ALWAYS masked), the 10 latest orders, `anonymizedAt`, and `anonymization`: the REAL numbers the warning of the "delete account" dialog shows (active orders that block it, how many orders are kept, what is deleted, the warning codes).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AdminCustomerDetailDto })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode CUSTOMER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  detail(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() request: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AdminCustomerDetailDto> {
    assertNoIdDocInQuery(request.query, SEARCH_PATH);
    res.setHeader('Cache-Control', 'no-store');
    return this.directory.detail(id);
  }

  @Post(':id/anonymize')
  @HttpCode(HttpStatus.OK)
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiBody({ type: AnonymizeCustomerDto })
  @ApiOperation({
    summary: 'Anonymize ("delete") a customer account (admin, IRREVERSIBLE)',
    description:
      'NOT RECOMMENDED. Only when the OWNER of the account asked for it explicitly. In ONE transaction: the account keeps its row (orders, payments, proofs of payment, the encrypted cedula of every order and the consent records are NOT touched) but its email becomes `deleted+<uuid>@anonymized.invalid`, name "Cuenta eliminada", phone and image are cleared, and the credentials, sessions (every device is logged out at once), address book, cart, wishlist, pending tokens and the usage log of the account (IP, user agent, routes: 7 days) are deleted; contact messages are KEPT (their own retention applies). The original email is free again: a new registration with it creates an unrelated account. Idempotent: an already anonymized account answers 200 `alreadyAnonymized: true` with no effect and no audit event. The audit event `CUSTOMER_ANONYMIZED` stores the admin, the reason and a keyed hash of the email, never the email. The address book kept in the shopper\'s own browser (`localStorage`) cannot be erased from the server (see `notices`).',
  })
  @ApiResponse({ status: HttpStatus.OK, type: AnonymizeCustomerResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      "errorCode ANONYMIZE_CONFIRMATION_MISMATCH (the email typed is not the account's; the answer never reveals it); ANONYMIZE_REASON_REQUIRED (10-500 characters); REASON_CONTAINS_ID_DOC; REASON_CONTAINS_PERSONAL_DATA (email, phone, secret).",
  })
  @ApiResponse({
    status: HttpStatus.UNAUTHORIZED,
    description: 'errorCode INVALID_ADMIN_TOKEN.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'errorCode CUSTOMER_NOT_FOUND.',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'errorCode ACCOUNT_HAS_ACTIVE_ORDERS (`details.total`, `details.orders[{id,status,createdAt}]` up to 20; nothing is cancelled or completed automatically; resolve them first); ANONYMIZE_BUSY (another operation holds the account, nothing changed, retry).',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description:
      'errorCode AUDIT_UNAVAILABLE: the audit event could not be written, so nothing was done.',
  })
  anonymize(
    @Req() req: RequestWithAdminUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(strictBody(AnonymizeCustomerDto))
    dto: Readonly<AnonymizeCustomerDto>,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AnonymizeCustomerResponseDto> {
    res.setHeader('Cache-Control', 'no-store');
    return this.anonymization.anonymize(req.user.id, id, dto);
  }
}
