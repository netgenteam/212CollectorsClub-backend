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

  describe('upsertDrop212', () => {
    it('upserts a "date"-typed row for "targetDate" when the value is a real ISO-8601 date/time', async () => {
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'drop212',
        key: 'targetDate',
        valueType: 'date',
        value: '2026-12-25T00:00:00.000Z',
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertDrop212(
        'targetDate',
        { value: '2026-12-25T00:00:00.000Z' },
        ADMIN_ID,
      );

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith({
        where: { section_key: { section: 'drop212', key: 'targetDate' } },
        create: {
          section: 'drop212',
          key: 'targetDate',
          valueType: 'date',
          value: '2026-12-25T00:00:00.000Z',
          updatedById: ADMIN_ID,
        },
        update: {
          valueType: 'date',
          value: '2026-12-25T00:00:00.000Z',
          updatedById: ADMIN_ID,
        },
        select: expect.any(Object) as unknown,
      });
    });

    it('upserts a "text"-typed row for "displayText", no ISO-8601 check applied (free text, empty string legal)', async () => {
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'drop212',
        key: 'displayText',
        valueType: 'text',
        value: '',
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertDrop212('displayText', { value: '' }, ADMIN_ID);

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith({
        where: { section_key: { section: 'drop212', key: 'displayText' } },
        create: {
          section: 'drop212',
          key: 'displayText',
          valueType: 'text',
          value: '',
          updatedById: ADMIN_ID,
        },
        update: {
          valueType: 'text',
          value: '',
          updatedById: ADMIN_ID,
        },
        select: expect.any(Object) as unknown,
      });
    });

    it('rejects a key outside the fixed "drop212" set with 400 LANDING_KEY_NOT_EDITABLE, and never calls Prisma', async () => {
      const thrown: unknown = await service
        .upsertDrop212('someArbitraryField', { value: 'x' }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_NOT_EDITABLE' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it.each(['mañana', '2026-13-45', '2026-02-30', 'not-a-date', ''])(
      'rejects "targetDate" = %j with 400 LANDING_INVALID_ISO8601_DATE, and never calls Prisma',
      async (badValue) => {
        const thrown: unknown = await service
          .upsertDrop212('targetDate', { value: badValue }, ADMIN_ID)
          .catch((err: unknown) => err);

        expect(thrown).toMatchObject({
          status: 400,
          response: { errorCode: 'LANDING_INVALID_ISO8601_DATE' },
        });
        expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
      },
    );
  });

  describe('upsertPackSimulator', () => {
    it('upserts a "json"-typed row for a flat object value, for ANY key (no fixed set)', async () => {
      const value = { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 };
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'pack_simulator',
        key: 'rarityOdds',
        valueType: 'json',
        value,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertPackSimulator('rarityOdds', { value }, ADMIN_ID);

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith({
        where: {
          section_key: { section: 'pack_simulator', key: 'rarityOdds' },
        },
        create: {
          section: 'pack_simulator',
          key: 'rarityOdds',
          valueType: 'json',
          value,
          updatedById: ADMIN_ID,
        },
        update: {
          valueType: 'json',
          value,
          updatedById: ADMIN_ID,
        },
        select: expect.any(Object) as unknown,
      });
    });

    it("accepts a key completely absent from any other section's fixed set (the whole point of this section)", async () => {
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'pack_simulator',
        key: 'featuredSetPityTimerThreshold',
        valueType: 'json',
        value: 42,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await expect(
        service.upsertPackSimulator(
          'featuredSetPityTimerThreshold',
          { value: 42 },
          ADMIN_ID,
        ),
      ).resolves.toMatchObject({ key: 'featuredSetPityTimerThreshold' });
      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalled();
    });

    it('accepts a nested (multi-level) value, preserving its exact shape', async () => {
      const nested = {
        'base-set': { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 },
        'promo-set': { COMMON: 0.5, RARE: 0.35, ULTRA_RARE: 0.15 },
      };
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'pack_simulator',
        key: 'perSetRarityOdds',
        valueType: 'json',
        value: nested,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await service.upsertPackSimulator(
        'perSetRarityOdds',
        { value: nested },
        ADMIN_ID,
      );

      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ value: nested }) as unknown,
        }),
      );
    });

    it('rejects a malformed key (invalid format) with 400 LANDING_KEY_INVALID_FORMAT, and never calls Prisma', async () => {
      const thrown: unknown = await service
        .upsertPackSimulator('not a valid key!', { value: 1 }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_INVALID_FORMAT' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it('rejects an empty-string key with 400 LANDING_KEY_INVALID_FORMAT, and never calls Prisma', async () => {
      const thrown: unknown = await service
        .upsertPackSimulator('', { value: 1 }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_KEY_INVALID_FORMAT' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it('rejects a value nested past the max depth with 400 LANDING_VALUE_TOO_DEEP, and never calls Prisma', async () => {
      // Build a value nested 8 levels deep (limit is 6).
      let deep: unknown = 1;
      for (let i = 0; i < 8; i++) {
        deep = { nested: deep };
      }

      const thrown: unknown = await service
        .upsertPackSimulator('tooDeep', { value: deep }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_VALUE_TOO_DEEP' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it('accepts a value at exactly the max depth (6 levels), the boundary is inclusive', async () => {
      let atLimit: unknown = 1;
      for (let i = 0; i < 6; i++) {
        atLimit = { nested: atLimit };
      }
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'pack_simulator',
        key: 'atLimitDepth',
        valueType: 'json',
        value: atLimit,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await expect(
        service.upsertPackSimulator(
          'atLimitDepth',
          { value: atLimit },
          ADMIN_ID,
        ),
      ).resolves.toBeDefined();
      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalled();
    });

    it('rejects a value whose serialized size exceeds the max with 400 LANDING_VALUE_TOO_LARGE, and never calls Prisma', async () => {
      // A flat (depth-1) object well past the 10,000-byte limit.
      const huge = { blob: 'x'.repeat(20_000) };

      const thrown: unknown = await service
        .upsertPackSimulator('tooLarge', { value: huge }, ADMIN_ID)
        .catch((err: unknown) => err);

      expect(thrown).toMatchObject({
        status: 400,
        response: { errorCode: 'LANDING_VALUE_TOO_LARGE' },
      });
      expect(prisma.landingConfigEntry.upsert).not.toHaveBeenCalled();
    });

    it('never validates the business meaning of the value — e.g. odds that do not sum to 1 are accepted without complaint', async () => {
      // Deliberately invalid *odds* (sums to 1.5, not 1) — this story's
      // Technical Note is explicit that the backend must never hardcode
      // simulator business logic like an odds-sum check. Confirms no such
      // check exists.
      const notNormalizedOdds = { COMMON: 1.0, RARE: 0.5 };
      prisma.landingConfigEntry.upsert.mockResolvedValue({
        section: 'pack_simulator',
        key: 'rarityOdds',
        valueType: 'json',
        value: notNormalizedOdds,
        updatedAt: new Date('2026-01-01'),
        updatedById: ADMIN_ID,
      });

      await expect(
        service.upsertPackSimulator(
          'rarityOdds',
          { value: notNormalizedOdds },
          ADMIN_ID,
        ),
      ).resolves.toBeDefined();
      expect(prisma.landingConfigEntry.upsert).toHaveBeenCalled();
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

    it('groups a "pack_simulator" row alongside texts/banners/drop212, with no special-casing needed (Story 10.3)', async () => {
      const updatedAt = new Date('2026-01-01');
      const nestedOdds = {
        'base-set': { COMMON: 0.6, RARE: 0.3, ULTRA_RARE: 0.1 },
      };
      prisma.landingConfigEntry.findMany.mockResolvedValue([
        {
          section: 'texts',
          key: 'heroTitle',
          valueType: 'text',
          value: 'Hello',
          updatedAt,
        },
        {
          section: 'drop212',
          key: 'targetDate',
          valueType: 'date',
          value: '2026-12-25T00:00:00.000Z',
          updatedAt,
        },
        {
          section: 'pack_simulator',
          key: 'perSetRarityOdds',
          valueType: 'json',
          value: nestedOdds,
          updatedAt,
        },
      ]);

      const result = await service.getPublicContent();

      expect(result.pack_simulator).toEqual({
        perSetRarityOdds: { valueType: 'json', value: nestedOdds, updatedAt },
      });
      // The exact same shape submitted is the exact same shape read back —
      // no re-serialization/flattening anywhere in the grouping logic.
      expect(result.pack_simulator.perSetRarityOdds.value).toStrictEqual(
        nestedOdds,
      );
      expect(result.texts).toBeDefined();
      expect(result.drop212).toBeDefined();
    });
  });
});
