import { Test, TestingModule } from '@nestjs/testing';
import { LandingContentService } from './landing-content.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const ADMIN_ID = 'dd848f24-aac0-4346-ae25-b672bb0d7e14';

/**
 * Story 10.1. Unit-level coverage of `LandingContentService`'s actual point
 * — the fixed-key-set enforcement (never even reaching Prisma for an
 * unrecognized key) and the section->key grouping shape of the public read.
 * Full-stack (real guard + real Postgres, real "immediately visible")
 * coverage lives in `test/landing-content.e2e-spec.ts`.
 */
describe('LandingContentService', () => {
  let service: LandingContentService;
  let prisma: {
    landingConfigEntry: {
      upsert: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(async () => {
    prisma = {
      landingConfigEntry: {
        upsert: vi.fn(),
        findMany: vi.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LandingContentService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<LandingContentService>(LandingContentService);
  });

  describe('upsertText', () => {
    it('upserts a row for a key in the fixed "texts" set', async () => {
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'texts',
        key: 'heroTitle',
        valueType: 'text',
        value: 'Hello',
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertText('heroTitle', { value: 'Hello' }, ADMIN_ID);

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith({
        where: { section_key: { section: 'texts', key: 'heroTitle' } },
        create: {
          section: 'texts',
          key: 'heroTitle',
          valueType: 'text',
          value: 'Hello',
          updatedById: ADMIN_ID,
        },
        update: {
          valueType: 'text',
          value: 'Hello',
          updatedById: ADMIN_ID,
        },
        select: expect.any(Object) as unknown,
      });
    });

    it('rejects a key outside the fixed "texts" set with 400 LANDING_KEY_NOT_EDITABLE, and never calls Prisma', async () => {
      const thrown: unknown = await service
        .upsertText('someArbitraryField', { value: 'x' }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_NOT_EDITABLE' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });
  });

  describe('upsertBanner', () => {
    it('upserts a JSON-object row for a key in the fixed "banners" set', async () => {
      const dto = {
        imageUrl: '/uploads/public/landing/b1.jpg',
        title: 'Banner 1',
        linkUrl: '/productos',
      };
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'banners',
        key: 'banner1',
        valueType: 'json',
        value: dto,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertBanner('banner1', dto, ADMIN_ID);

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith({
        where: { section_key: { section: 'banners', key: 'banner1' } },
        create: {
          section: 'banners',
          key: 'banner1',
          valueType: 'json',
          value: dto,
          updatedById: ADMIN_ID,
        },
        update: {
          valueType: 'json',
          value: dto,
          updatedById: ADMIN_ID,
        },
        select: expect.any(Object) as unknown,
      });
    });

    it('rejects a key outside the fixed "banners" set with 400 LANDING_KEY_NOT_EDITABLE, and never calls Prisma', async () => {
      const thrown: unknown = await service
        .upsertBanner(
          'banner99',
          { imageUrl: 'x', title: 'x', linkUrl: 'x' },
          ADMIN_ID,
        )
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_NOT_EDITABLE' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it('rejects a "texts" key submitted to the banners endpoint (sections are not interchangeable)', async () => {
      const thrown: unknown = await service
        .upsertBanner(
          'heroTitle',
          { imageUrl: 'x', title: 'x', linkUrl: 'x' },
          ADMIN_ID,
        )
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_NOT_EDITABLE' },
      });
    });
  });

  describe('getPublicContent', () => {
    it('groups rows by section into { [section]: { [key]: { valueType, value, updatedAt } } }', async () => {
      const updatedAt = new Date('2026-01-01');
      prisma.landingConfigEntry.findMany.mockResolvedValue([
        {
          section: 'texts',
          key: 'heroTitle',
          valueType: 'text',
          value: 'Hello',
          updatedAt,
        },
        {
          section: 'banners',
          key: 'banner1',
          valueType: 'json',
          value: { imageUrl: 'x', title: 'y', linkUrl: 'z' },
          updatedAt,
        },
      ]);

      const result = await service.getPublicContent();

      expect(result).toEqual({
        texts: {
          heroTitle: { valueType: 'text', value: 'Hello', updatedAt },
        },
        banners: {
          banner1: {
            valueType: 'json',
            value: { imageUrl: 'x', title: 'y', linkUrl: 'z' },
            updatedAt,
          },
        },
      });
    });

    it('returns {} (never throws) when no rows exist', async () => {
      prisma.landingConfigEntry.findMany.mockResolvedValue([]);

      await expect(service.getPublicContent()).resolves.toEqual({});
    });
  });
});
