import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { createGlobalValidationPipe } from '../../common/global-validation-pipe.js';
import { isValidPriceUsd } from './price-usd.validator.js';
import { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/api-exception.js';
import { assertAuditSafeText } from './set-name.js';
import {
  CardsQueryDto,
  CreateManualCardDto,
  UpdateManualCardDto,
} from './manual-cards.dto.js';
import { ManualCardsService, toCardDto } from './manual-cards.service.js';

const check = <T extends object>(cls: new () => T, raw: object) => {
  const o = plainToInstance(cls, raw);
  return { o, errors: validateSync(o, { whitelist: true }) };
};
const ok = (raw: object) => check(CreateManualCardDto, raw);
const base = { name: 'Pikachu', rarityTier: 'RARE' };

describe('CreateManualCardDto / UpdateManualCardDto (AC2)', () => {
  it('trims name; 1..120', () => {
    expect(ok({ ...base, name: '  Pikachu  ' }).o.name).toBe('Pikachu');
    expect(ok({ ...base, name: '   ' }).errors).not.toHaveLength(0);
    expect(ok({ ...base, name: 'x'.repeat(121) }).errors).not.toHaveLength(0);
    expect(ok({ ...base, name: 'x'.repeat(120) }).errors).toHaveLength(0);
    expect(ok({ ...base, name: 'a\u0000b' }).errors).not.toHaveLength(0);
  });

  it('rarityTier must be one of the 8 upper-case tiers', () => {
    for (const bad of ['promo', 'rare', 'XX', 5, null])
      expect(ok({ ...base, rarityTier: bad }).errors).not.toHaveLength(0);
    expect(
      ok({ ...base, rarityTier: 'ILLUSTRATION_RARE' }).errors,
    ).toHaveLength(0);
  });

  it('number: blank becomes null, <=30 chars', () => {
    expect(ok({ ...base, number: '   ' }).o.number).toBeNull();
    expect(ok({ ...base, number: '' }).o.number).toBeNull();
    expect(ok({ ...base, number: ' 025/165 ' }).o.number).toBe('025/165');
    expect(ok({ ...base, number: '1'.repeat(31) }).errors).not.toHaveLength(0);
    expect(ok({ ...base, number: '1'.repeat(30) }).errors).toHaveLength(0);
    expect(ok({ ...base, number: 12 }).errors).not.toHaveLength(0);
  });

  it('marketPriceUsd: >=0, <=2 decimals, number only', () => {
    for (const bad of [-0.01, 1.234, 'abc', '1e3', '5', NaN, 1e9])
      expect(ok({ ...base, marketPriceUsd: bad }).errors).not.toHaveLength(0);
    for (const good of [0, 0.5, 12.34, 99999999.99, null])
      expect(ok({ ...base, marketPriceUsd: good }).errors).toHaveLength(0);
  });

  it('imageUrl reuses the shared validator', () => {
    expect(
      ok({ ...base, imageUrl: 'http://x.io/a.png' }).errors,
    ).not.toHaveLength(0);
    expect(ok({ ...base, imageUrl: 'https://x.io/a.png' }).errors).toHaveLength(
      0,
    );
    expect(
      ok({ ...base, imageUrl: '/uploads/public/simulator/a.png' }).errors,
    ).toHaveLength(0);
  });

  it('update: every field optional; null clears number/imageUrl/price but not name/tier', () => {
    const u = (raw: object) => check(UpdateManualCardDto, raw).errors;
    expect(u({})).toHaveLength(0);
    expect(
      u({ number: null, imageUrl: null, marketPriceUsd: null }),
    ).toHaveLength(0);
    expect(u({ name: null })).not.toHaveLength(0);
    expect(u({ rarityTier: null })).not.toHaveLength(0);
    expect(u({ rarityTier: 'promo' })).not.toHaveLength(0);
  });

  it('query: tier enum, limit<=100', () => {
    const q = (raw: object) => check(CardsQueryDto, raw).errors;
    expect(q({ tier: 'RARE', limit: '100' })).toHaveLength(0);
    expect(q({ tier: 'XX' })).not.toHaveLength(0);
    expect(q({ limit: '101' })).not.toHaveLength(0);
  });
});

describe('real TCG card numbers pass the audit PII guard (QA 22.4 lesson)', () => {
  it.each(['025/165', 'SV-P 001', 'TG12/TG30', 'GG01', '001', 'H12/H32'])(
    '%s accepted',
    (n) => expect(() => assertAuditSafeText('number', n)).not.toThrow(),
  );
  it.each(['V-12345678', 'a@b.co', '4111111111111111'])('%s rejected', (n) =>
    expect(() => assertAuditSafeText('number', n)).toThrow(),
  );
});

describe('toCardDto', () => {
  it('serializes the Decimal price as a number, null stays null', () => {
    const r = {
      id: 'i',
      setId: 's',
      name: 'n',
      rarityTier: 'RARE',
      number: null,
      imageUrl: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(
      toCardDto({ ...r, marketPriceUsd: new Prisma.Decimal('12.30') } as never)
        .marketPriceUsd,
    ).toBe(12.3);
    expect(
      toCardDto({ ...r, marketPriceUsd: null } as never).marketPriceUsd,
    ).toBeNull();
  });
});

/** Fake audited tx: runs the callback with a scripted tx. */
function harness(opts: {
  isActive: boolean;
  card?: object | null;
  count?: number;
}) {
  const events: unknown[] = [];
  const assertReady = vi.fn();
  const tx = {
    $executeRaw: vi.fn().mockResolvedValue(0),
    $queryRaw: vi.fn((strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FOR UPDATE'))
        return [{ id: 's', isActive: opts.isActive }];
      assertReady(sql);
      // assertReadyIfActive: set row, then counts
      if (sql.includes('"isActive", "template"'))
        return [
          {
            isActive: opts.isActive,
            template: { slots: [{ kind: 'fixed', tier: 'COMMON', count: 4 }] },
          },
        ];
      return [{ setId: 's', rarityTier: 'COMMON', n: 3 }];
    }),
    simulatorCard: {
      findFirst: vi.fn().mockResolvedValue(opts.card ?? null),
      count: vi.fn().mockResolvedValue(opts.count ?? 0),
      delete: vi.fn().mockResolvedValue({}),
      update: vi.fn(({ data }: { data: object }) => ({
        ...opts.card,
        ...data,
      })),
      create: vi.fn(),
    },
    simulatorSet: { update: vi.fn().mockResolvedValue({ id: 's' }) },
  };
  const audit = {
    transaction: vi.fn((fn: (t: unknown, a: unknown) => unknown) =>
      fn(tx, { add: (e: unknown) => events.push(e) }),
    ),
  };
  const cache = { clear: vi.fn() };
  const svc = new ManualCardsService(
    {} as never,
    audit as never,
    cache as never,
  );
  return { svc, tx, events, cache };
}
const CARD = {
  id: 'c',
  setId: 's',
  name: 'Pika',
  rarityTier: 'COMMON',
  number: '1',
  imageUrl: null,
  marketPriceUsd: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ManualCardsService invariants (AC5-AC8, mocked tx)', () => {
  it('delete on an ACTIVE set below sufficiency: 422, no event, cache untouched', async () => {
    const h = harness({ isActive: true, card: CARD });
    const err = await h.svc
      .remove('s', 'c', undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiException);
    expect(h.events).toHaveLength(0);
    expect(h.cache.clear).not.toHaveBeenCalled();
  });

  it('delete on an INACTIVE set: no readiness check, event without the name', async () => {
    const h = harness({ isActive: false, card: CARD });
    await h.svc.remove('s', 'c', undefined);
    expect(h.events).toHaveLength(1);
    expect(h.events[0]).toMatchObject({ action: 'SIMULATOR_CARD_DELETED' });
    expect(JSON.stringify(h.events[0])).not.toContain('Pika');
    expect(h.cache.clear).toHaveBeenCalled();
  });

  it('patch of a non-tier field on an active set does not evaluate sufficiency', async () => {
    const h = harness({ isActive: true, card: CARD });
    await h.svc.update('s', 'c', { name: 'Raichu' }, undefined);
    expect(h.tx.$queryRaw).toHaveBeenCalledTimes(1); // only the FOR UPDATE
    expect(h.tx.simulatorSet.update).toHaveBeenCalledTimes(1); // version bump
  });

  it('patch with no effective change: no write, no event, no version bump', async () => {
    const h = harness({ isActive: true, card: CARD });
    await h.svc.update(
      's',
      'c',
      { name: 'Pika', number: '1', marketPriceUsd: null },
      undefined,
    );
    expect(h.tx.simulatorCard.update).not.toHaveBeenCalled();
    expect(h.tx.simulatorSet.update).not.toHaveBeenCalled();
    expect(h.events).toHaveLength(0);
    expect(h.cache.clear).not.toHaveBeenCalled();
  });

  it('create at the cap: 422 SIMULATOR_SET_CARD_LIMIT with details', async () => {
    process.env.SIMULATOR_MAX_CARDS_PER_SET = '5';
    try {
      const h = harness({ isActive: false, count: 5 });
      const err = (await h.svc
        .create('s', { name: 'x', rarityTier: 'COMMON' }, undefined)
        .catch((e: unknown) => e)) as ApiException;
      expect(err.getResponse()).toMatchObject({
        errorCode: 'SIMULATOR_SET_CARD_LIMIT',
        details: { max: 5, current: 5, incoming: 1 },
      });
    } finally {
      delete process.env.SIMULATOR_MAX_CARDS_PER_SET;
    }
  });

  it('PII-looking number/imageUrl => 400 before any transaction', async () => {
    const h = harness({ isActive: false });
    await expect(
      h.svc.create(
        's',
        { name: 'x', rarityTier: 'COMMON', number: 'V-12345678' },
        undefined,
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('a card name like V-12345678 is accepted and not audited', async () => {
    const h = harness({ isActive: false, count: 0 });
    h.tx.simulatorCard.create.mockResolvedValue({
      ...CARD,
      name: 'V-12345678',
    });
    await h.svc.create(
      's',
      { name: 'V-12345678', rarityTier: 'COMMON' },
      undefined,
    );
    expect(JSON.stringify(h.events)).not.toContain('12345678');
  });
});

describe('marketPriceUsd exponent forms never reach a 500 (QA 22.5 B1), real global pipe', () => {
  const pipe = createGlobalValidationPipe();
  const meta = (type: 'body', metatype: unknown) =>
    ({ type, metatype }) as never;
  const bad = [1e-7, 1e-10, 1.5e-7, 1e21, -1e-7, 1.234, 1e9, Infinity];
  it.each(bad)(
    'Create/Update DTO reject %s with 400 (not TypeError)',
    async (v) => {
      for (const cls of [CreateManualCardDto, UpdateManualCardDto])
        await expect(
          pipe.transform(
            { name: 'x', rarityTier: 'COMMON', marketPriceUsd: v },
            meta('body', cls),
          ),
        ).rejects.toMatchObject({ status: 400 });
    },
  );
  it('valid prices still pass through the pipe', async () => {
    for (const v of [0, 0.1, 0.29, 1.005 * 0 + 12.34, 99999999.99])
      await expect(
        pipe.transform(
          { name: 'x', rarityTier: 'COMMON', marketPriceUsd: v },
          meta('body', CreateManualCardDto),
        ),
      ).resolves.toBeDefined();
    expect(isValidPriceUsd('5')).toBe(false);
  });
});
