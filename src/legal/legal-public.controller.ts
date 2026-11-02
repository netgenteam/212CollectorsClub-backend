import {
  Controller,
  Get,
  HttpStatus,
  Param,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import {
  LegalCurrentVersionsResponseDto,
  LegalDocumentResponseDto,
  LegalIdentityDto,
  LegalListItemDto,
  LegalVersionResponseDto,
  LegalVersionsResponseDto,
} from './dto/legal-public.dto.js';
import { LegalCacheInterceptor } from './legal-cache.interceptor.js';
import { LegalDocumentsService } from './legal-documents.service.js';
import { LegalSlugPipe, parseVersionNumber } from './legal-slug.pipe.js';

const NOT_FOUND_DOC = {
  status: HttpStatus.NOT_FOUND,
  description:
    'LEGAL_DOCUMENT_NOT_FOUND: the slug is not one of the six documents.',
};
const SLUG_PARAM = {
  name: 'slug',
  enum: [
    'terminos',
    'privacidad',
    'cookies',
    'envios',
    'devoluciones',
    'aviso-legal',
  ],
};

/**
 * Story 19.1 (AD-91 "Público", FR-102/103). Static routes are declared BEFORE
 * `:slug`. Nothing here reads the drafts table. Errors are never cached.
 */
@ApiTags('legal')
@UseInterceptors(LegalCacheInterceptor)
@Controller('legal')
export class LegalPublicController {
  constructor(private readonly docs: LegalDocumentsService) {}

  @Get()
  @ApiOperation({
    summary: 'The six legal documents with their current version',
    description:
      'Public, Cache-Control: public, max-age=60. status IN_PREPARATION when there is no version in force yet.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: [LegalListItemDto] })
  list(): Promise<LegalListItemDto[]> {
    return this.docs.list();
  }

  @Get('current-versions')
  @ApiOperation({
    summary: 'Versions in force (single source for consent and cookie banner)',
    description:
      'Only documents with a version in force. effectiveFrom <= database now().',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    type: LegalCurrentVersionsResponseDto,
  })
  currentVersions(): Promise<LegalCurrentVersionsResponseDto> {
    return this.docs.currentVersions();
  }

  @Get('identity')
  @ApiOperation({
    summary: 'Seller identity (footer, Aviso Legal header)',
    description: 'All fields are null when not configured yet; never an error.',
  })
  @ApiResponse({ status: HttpStatus.OK, type: LegalIdentityDto })
  identity(): Promise<LegalIdentityDto> {
    return this.docs.identity();
  }

  @Get(':slug')
  @ApiOperation({
    summary: 'Document in force',
    description:
      '200 with status IN_PREPARATION and no body when no version is in force. A future version appears as `upcoming` (no body). Drafts are never exposed.',
  })
  @ApiParam(SLUG_PARAM)
  @ApiResponse({ status: HttpStatus.OK, type: LegalDocumentResponseDto })
  @ApiResponse(NOT_FOUND_DOC)
  get(
    @Param('slug', LegalSlugPipe) slug: string,
  ): Promise<LegalDocumentResponseDto> {
    return this.docs.getDocument(slug);
  }

  @Get(':slug/versions')
  @ApiOperation({
    summary: 'Published versions (in force or superseded), newest first',
  })
  @ApiParam(SLUG_PARAM)
  @ApiResponse({ status: HttpStatus.OK, type: LegalVersionsResponseDto })
  @ApiResponse(NOT_FOUND_DOC)
  versions(
    @Param('slug', LegalSlugPipe) slug: string,
  ): Promise<LegalVersionsResponseDto> {
    return this.docs.listVersions(slug);
  }

  @Get(':slug/versions/:n')
  @ApiOperation({ summary: 'One published version with its body and toc' })
  @ApiParam(SLUG_PARAM)
  @ApiParam({ name: 'n', type: Number, example: 1 })
  @ApiResponse({ status: HttpStatus.OK, type: LegalVersionResponseDto })
  @ApiResponse({
    status: HttpStatus.BAD_REQUEST,
    description: 'LEGAL_VERSION_INVALID: `n` is not a positive integer.',
  })
  @ApiResponse({
    status: HttpStatus.NOT_FOUND,
    description:
      'LEGAL_DOCUMENT_NOT_FOUND (slug) or LEGAL_VERSION_NOT_FOUND (no such published version).',
  })
  version(
    @Param('slug', LegalSlugPipe) slug: string,
    // Typed `string` on purpose: the global ValidationPipe would coerce a
    // `number` param ('1e3' -> 1000) before our strict parser sees it.
    @Param('n') n: string,
  ): Promise<LegalVersionResponseDto> {
    return this.docs.getVersion(slug, parseVersionNumber(n));
  }
}
