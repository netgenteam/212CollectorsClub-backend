import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LandingContentService } from './landing-content.service.js';

/**
 * Story 10.1 (FR-29, NFR-2; AD-9, AD-10). Public, unauthenticated read of
 * every `LandingConfigEntry` row, grouped by `section` — the storefront
 * frontend's single source of truth for homepage copy/banners (and, once
 * Stories 10.2/10.3 land, Drop 212/Pack Simulator variables too, with no
 * new endpoint needed).
 *
 * No `@UseGuards(...)` anywhere on this controller — deliberately open,
 * per the story's own AC ("any client (unauthenticated)"). Always 200,
 * even against an empty/un-seeded table (an empty `{}` is a legal
 * response, never an error) — same "never error on an empty result"
 * convention `CatalogController.listCategories` already established.
 *
 * No caching layer (AD-10): this reads straight from Postgres on every
 * call, so an admin's `PUT` via `AdminLandingContentController` is visible
 * on the very next call here, ~0s propagation delay, by construction.
 */
@ApiTags('landing-content')
@Controller('landing-content')
export class LandingContentController {
  constructor(private readonly landingContentService: LandingContentService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read all landing-page content, grouped by section',
    description:
      "Returns every LandingConfigEntry grouped as { [section]: { [key]: { valueType, value, updatedAt } } }. No authentication required. Reflects the admin's latest edit immediately (no caching layer, AD-10). Returns {} (never an error) when nothing has been seeded/edited yet.",
  })
  @ApiOkResponse({
    description: 'Landing content grouped by section.',
    schema: {
      example: {
        texts: {
          heroTitle: {
            valueType: 'text',
            value: 'Bienvenido a 212 Collectors Club',
            updatedAt: '2026-09-24T23:00:00.000Z',
          },
        },
        banners: {
          banner1: {
            valueType: 'json',
            value: {
              imageUrl: '/uploads/public/landing/banner-1.jpg',
              title: 'Nuevo Drop 212 cada mes',
              linkUrl: '/productos?tag=nuevo',
            },
            updatedAt: '2026-09-24T23:00:00.000Z',
          },
        },
      },
    },
  })
  getPublicContent(): Promise<
    Record<
      string,
      Record<string, { valueType: string; value: unknown; updatedAt: Date }>
    >
  > {
    return this.landingContentService.getPublicContent();
  }
}
