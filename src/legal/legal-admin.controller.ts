import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
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
import { ApiException } from '../common/api-exception.js';
import { AdminAuthGuard } from '../common/admin-auth.guard.js';
import type { RequestWithAdminUser } from '../common/admin-auth.guard.js';
import { strictBody } from '../customer-auth/strict-body.pipe.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  AdminLegalListItemDto,
  AuditResponseDto,
  DiffResponseDto,
  HistoryResponseDto,
  IdentityResponseDto,
  LEGAL_AUDIT_DEFAULT_LIMIT,
  LEGAL_AUDIT_MAX_LIMIT,
  LegalDraftResponseDto,
  PublishDto,
  PublishedVersionDto,
  PutDraftDto,
  RestoreDto,
  UpdateIdentityDto,
} from './dto/legal-admin.dto.js';
import { AdminConsentsResponseDto } from './dto/consent.dto.js';
import { ADMIN_CONSENTS_LIMIT, ConsentService } from './consent.service.js';
import { findLegalDoc } from './legal-admin.common.js';
import { LegalDiffService } from './legal-diff.service.js';
import { LegalDraftService } from './legal-draft.service.js';
import { LegalPublishService } from './legal-publish.service.js';
import { LegalSlugPipe, parseVersionNumber } from './legal-slug.pipe.js';
import { SellerIdentityService } from './seller-identity.service.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const UNAUTH = {
  status: HttpStatus.UNAUTHORIZED,
  description: 'INVALID_ADMIN_TOKEN',
} as const;
const NOT_FOUND_DOC = {
  status: HttpStatus.NOT_FOUND,
  description: 'LEGAL_DOCUMENT_NOT_FOUND',
} as const;
const BUSY = {
  status: HttpStatus.CONFLICT,
  description:
    'LEGAL_DOCUMENT_BUSY (a lock stayed taken for 10 s) | LEGAL_VERSION_CONFLICT (a concurrent publication took the number; retry)',
} as const;
const SLUG = {
  name: 'slug',
  description:
    'terminos | privacidad | cookies | envios | devoluciones | aviso-legal',
} as const;

/**
 * Story 19.2 (AD-89..91, FR-105..108, FR-111): admin API of the legal
 * documents. Every route is behind `AdminAuthGuard`; bodies go through
 * `strictBody` (unknown properties are a 400). The business rules live in the
 * services; the audit rows are written inside each action's transaction.
 */
@ApiTags('admin-legal')
@ApiBearerAuth('admin-jwt')
@UseGuards(AdminAuthGuard)
@Controller('admin/legal')
export class LegalAdminController {
  constructor(
    private readonly drafts: LegalDraftService,
    private readonly publisher: LegalPublishService,
    private readonly diffs: LegalDiffService,
    private readonly identity: SellerIdentityService,
    private readonly prisma: PrismaService,
    private readonly consent: ConsentService,
  ) {}

  private actor(req: RequestWithAdminUser) {
    return { id: req.user.id, email: req.user.email };
  }

  @Get()
  @ApiOperation({
    summary:
      'The six documents: current version, pending draft and unresolved placeholders',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [AdminLegalListItemDto] })
  @ApiResponse(UNAUTH)
  list(): Promise<AdminLegalListItemDto[]> {
    return this.drafts.list();
  }

  @Get('consents')
  @ApiOperation({
    summary: 'Acceptance evidence of a customer or an order (Story 19.4)',
    description: `Lists the append-only Consent_Records (newest first, at most ${ADMIN_CONSENTS_LIMIT}): type, version, document version id, context, DB timestamp and the customer/order ids. No IP, no buyer data. An id that does not exist gives an empty list.`,
  })
  @ApiQuery({ name: 'customerId', required: false, description: 'uuid' })
  @ApiQuery({ name: 'orderId', required: false, description: 'uuid' })
  @ApiResponse({ status: HttpStatus.OK, type: AdminConsentsResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'CONSENT_FILTER_REQUIRED (neither customerId nor orderId) | CONSENT_FILTER_INVALID (not a uuid)',
  })
  @ApiResponse(UNAUTH)
  async consents(
    @Query('customerId') customerId?: string,
    @Query('orderId') orderId?: string,
  ): Promise<AdminConsentsResponseDto> {
    if (customerId === undefined && orderId === undefined) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'CONSENT_FILTER_REQUIRED',
        'Send customerId or orderId.',
      );
    }
    for (const v of [customerId, orderId]) {
      if (v !== undefined && !UUID_RE.test(v)) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'CONSENT_FILTER_INVALID',
          'customerId and orderId must be UUIDs.',
        );
      }
    }
    return {
      consents: await this.consent.listForAdmin({ customerId, orderId }),
    };
  }

  @Get('audit')
  @ApiOperation({ summary: 'Append-only audit log, newest first' })
  @ApiQuery({ name: 'slug', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: `1..${LEGAL_AUDIT_MAX_LIMIT}, default ${LEGAL_AUDIT_DEFAULT_LIMIT}`,
  })
  @ApiResponse({ status: HttpStatus.OK, type: AuditResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'LEGAL_AUDIT_LIMIT_INVALID (not an integer 1..200)',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse(NOT_FOUND_DOC)
  async audit(
    @Query('slug') slug?: string,
    @Query('limit') limit?: string,
  ): Promise<AuditResponseDto> {
    let n = LEGAL_AUDIT_DEFAULT_LIMIT;
    if (limit !== undefined) {
      if (
        !/^\d{1,4}$/.test(limit) ||
        +limit < 1 ||
        +limit > LEGAL_AUDIT_MAX_LIMIT
      ) {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'LEGAL_AUDIT_LIMIT_INVALID',
          `limit must be an integer between 1 and ${LEGAL_AUDIT_MAX_LIMIT}.`,
        );
      }
      n = +limit;
    }
    let documentId: string | null = null;
    if (slug !== undefined) {
      new LegalSlugPipe().transform(slug);
      documentId = (await findLegalDoc(this.prisma, slug)).id;
    }
    const rows = await this.prisma.$queryRaw<
      {
        id: string;
        slug: string | null;
        action: string;
        adminUserId: string | null;
        adminEmail: string | null;
        versionNumber: number | null;
        meta: Record<string, unknown>;
        createdAt: Date;
      }[]
    >`
      SELECT a."id", d."slug", a."action"::text AS "action", a."adminUserId", a."adminEmail",
             a."versionNumber", a."meta", a."createdAt"
      FROM "Legal_Audit_Logs" a LEFT JOIN "Legal_Documents" d ON d."id" = a."documentId"
      WHERE (${documentId}::uuid IS NULL OR a."documentId" = ${documentId}::uuid)
      ORDER BY a."createdAt" DESC, a."id" DESC
      LIMIT ${n}`;
    return {
      items: rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })),
    };
  }

  @Get('identity')
  @ApiOperation({ summary: 'Seller identity (footer and Aviso Legal header)' })
  @ApiResponse({ status: HttpStatus.OK, type: IdentityResponseDto })
  @ApiResponse(UNAUTH)
  getIdentity(): Promise<IdentityResponseDto> {
    return this.identity.get();
  }

  @Put('identity')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @ApiOperation({
    summary: 'Update the seller identity',
    description:
      'Only the fields present change (null or blank clears one). Audits IDENTITY_UPDATED, with the names of the changed fields, in the same transaction.',
  })
  @ApiBody({ type: UpdateIdentityDto })
  @ApiResponse({ status: HttpStatus.OK, type: IdentityResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'validation (RIF, email, lengths, unknown properties)',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse(BUSY)
  updateIdentity(
    @Body(strictBody(UpdateIdentityDto)) dto: Readonly<UpdateIdentityDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<IdentityResponseDto> {
    return this.identity.update(dto, this.actor(req));
  }

  @Get(':slug/draft')
  @ApiOperation({ summary: 'The pending draft of a document' })
  @ApiParam(SLUG)
  @ApiResponse({ status: HttpStatus.OK, type: LegalDraftResponseDto })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'LEGAL_DRAFT_NOT_FOUND | LEGAL_DOCUMENT_NOT_FOUND',
  })
  getDraft(
    @Param('slug', LegalSlugPipe) slug: string,
  ): Promise<LegalDraftResponseDto> {
    return this.drafts.get(slug);
  }

  @Put(':slug/draft')
  @ApiOperation({
    summary:
      'Create (baseRevision 0) or edit the draft with optimistic control',
  })
  @ApiParam(SLUG)
  @ApiBody({ type: PutDraftDto })
  @ApiResponse({ status: HttpStatus.OK, type: LegalDraftResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'LEGAL_MARKDOWN_INVALID (details.issues[{line,reason}], details.omitted, details.reason: TIMEOUT | TOO_COMPLEX | FORBIDDEN_CONSTRUCTS; TIMEOUT means the server could not analyze the text in time, not that the text is wrong) | validation',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'LEGAL_DOCUMENT_NOT_FOUND | LEGAL_DRAFT_NOT_FOUND (edit of a draft that no longer exists)',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'LEGAL_DRAFT_STALE (details.currentRevision) | LEGAL_DOCUMENT_BUSY',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'LEGAL_MARKDOWN_BUSY (the validator is saturated; retry)',
  })
  @HttpCode(HttpStatus.OK)
  putDraft(
    @Param('slug', LegalSlugPipe) slug: string,
    @Body(strictBody(PutDraftDto)) dto: Readonly<PutDraftDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<LegalDraftResponseDto> {
    return this.drafts.put(slug, dto, this.actor(req));
  }

  @Post(':slug/draft/discard')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete the draft (audited)' })
  @ApiParam(SLUG)
  @ApiResponse({ status: HttpStatus.NO_CONTENT })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'LEGAL_DRAFT_NOT_FOUND | LEGAL_DOCUMENT_NOT_FOUND',
  })
  @ApiResponse(BUSY)
  async discard(
    @Param('slug', LegalSlugPipe) slug: string,
    @Req() req: RequestWithAdminUser,
  ): Promise<void> {
    await this.drafts.discard(slug, this.actor(req));
  }

  @Post(':slug/publish')
  @ApiResponse({
    status: 503,
    description:
      'errorCode AUDIT_UNAVAILABLE: the action could not be written to the immutable audit log (fail-closed, Story 20.5); nothing was changed, retry in a few seconds.',
  })
  @ApiOperation({
    summary: 'Publish the draft as a new immutable version',
    description:
      'One transaction: lock, stale check, validation, numbering, INSERT, draft delete and audit. effectiveFrom must be >= greatest(database now(), effectiveFrom of the latest version) and at most 366 days ahead.',
  })
  @ApiParam(SLUG)
  @ApiBody({ type: PublishDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: PublishedVersionDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description:
      'LEGAL_EFFECTIVE_FROM_INVALID | LEGAL_MARKDOWN_INVALID (details.reason: TIMEOUT | TOO_COMPLEX | FORBIDDEN_CONSTRUCTS) | validation (changeSummary < 10 chars)',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'LEGAL_DRAFT_NOT_FOUND | LEGAL_DOCUMENT_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description:
      'LEGAL_DRAFT_STALE (details.currentRevision) | LEGAL_DOCUMENT_BUSY | LEGAL_VERSION_CONFLICT',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description: 'LEGAL_PLACEHOLDERS_PENDING (details.items[{token,line}])',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'LEGAL_MARKDOWN_BUSY (retry)',
  })
  publish(
    @Param('slug', LegalSlugPipe) slug: string,
    @Body(strictBody(PublishDto)) dto: Readonly<PublishDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<PublishedVersionDto> {
    return this.publisher.publish(slug, dto, this.actor(req));
  }

  @Post(':slug/restore')
  @ApiOperation({
    summary:
      'Create a draft from a published version (history is never touched)',
  })
  @ApiParam(SLUG)
  @ApiBody({ type: RestoreDto })
  @ApiResponse({ status: HttpStatus.CREATED, type: LegalDraftResponseDto })
  @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'validation' })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'LEGAL_VERSION_NOT_FOUND | LEGAL_DOCUMENT_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.CONFLICT,
    description: 'LEGAL_DRAFT_EXISTS | LEGAL_DOCUMENT_BUSY',
  })
  restore(
    @Param('slug', LegalSlugPipe) slug: string,
    @Body(strictBody(RestoreDto)) dto: Readonly<RestoreDto>,
    @Req() req: RequestWithAdminUser,
  ): Promise<LegalDraftResponseDto> {
    return this.drafts.restore(slug, dto.version, this.actor(req));
  }

  @Get(':slug/history')
  @ApiOperation({
    summary: 'All versions (including scheduled ones), newest first',
  })
  @ApiParam(SLUG)
  @ApiResponse({ status: HttpStatus.OK, type: HistoryResponseDto })
  @ApiResponse(UNAUTH)
  @ApiResponse(NOT_FOUND_DOC)
  history(
    @Param('slug', LegalSlugPipe) slug: string,
  ): Promise<HistoryResponseDto> {
    return this.diffs.history(slug);
  }

  @Get(':slug/diff')
  @ApiOperation({ summary: 'Line diff between two versions (read only)' })
  @ApiParam(SLUG)
  @ApiQuery({ name: 'from', description: 'version number' })
  @ApiQuery({ name: 'to', description: 'version number' })
  @ApiResponse({ status: HttpStatus.OK, type: DiffResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'LEGAL_VERSION_INVALID (missing or not a positive integer)',
  })
  @ApiResponse(UNAUTH)
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description: 'LEGAL_VERSION_NOT_FOUND | LEGAL_DOCUMENT_NOT_FOUND',
  })
  @ApiResponse({
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'LEGAL_DIFF_TOO_LARGE (the comparison exceeded its time limit or memory; it runs in a worker, never on the API thread)',
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'LEGAL_MARKDOWN_BUSY (worker pool saturated; retry)',
  })
  diff(
    @Param('slug', LegalSlugPipe) slug: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<DiffResponseDto> {
    return this.diffs.diff(
      slug,
      parseVersionNumber(String(from ?? '')),
      parseVersionNumber(String(to ?? '')),
    );
  }
}
