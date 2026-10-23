import { ApiException } from '../common/api-exception.js';
import { LANDING_BLOCKS } from './landing-blocks.constants.js';
import { validBlock } from './landing-blocks.fixtures.js';
import { validateLandingBlock } from './landing-blocks.validation.js';

type Errors = { path: string; messages: string[] }[];

async function errorsOf(block: (typeof LANDING_BLOCKS)[number], body: unknown) {
  try {
    await validateLandingBlock(block, body);
  } catch (e) {
    expect(e).toBeInstanceOf(ApiException);
    const res = (e as ApiException).getResponse() as {
      errorCode: string;
      details: { errors: Errors };
    };
    expect(res.errorCode).toBe('LANDING_BLOCK_INVALID');
    return res.details.errors;
  }
  throw new Error('expected validation to fail');
}

/** Story 16.1 (AD-60): block DTO shapes and limits. */
describe('validateLandingBlock', () => {
  it.each(LANDING_BLOCKS)('accepts a valid %s', async (block) => {
    await expect(
      validateLandingBlock(block, validBlock(block)),
    ).resolves.toBeDefined();
  });

  it.each(LANDING_BLOCKS)('rejects an unknown field in %s', async (block) => {
    const errors = await errorsOf(block, { ...validBlock(block), evil: 1 });
    expect(errors.some((e) => e.path === 'evil')).toBe(true);
  });

  it('rejects non-object bodies', async () => {
    expect(await errorsOf('ticker', [])).toHaveLength(1);
    expect(await errorsOf('ticker', null)).toHaveLength(1);
  });

  it('rejects more than 12 ticker items and an empty list', async () => {
    const item = { text: 'x' };
    await errorsOf('ticker', { items: Array(13).fill(item) });
    await errorsOf('ticker', { items: [] });
  });

  it('requires exactly 3 hero panels and reports nested title-line paths', async () => {
    const ok = validBlock('hero') as { panels: Record<string, unknown>[] };
    await errorsOf('hero', { panels: ok.panels.slice(0, 2) });

    const bad = structuredClone(ok);
    (bad.panels[0].titleLines as unknown[][])[1] = [
      { text: '', style: 'solid' },
    ];
    const errors = await errorsOf('hero', bad);
    expect(errors.map((e) => e.path)).toContain('panels.0.titleLines.1.0.text');
  });

  it('rejects bad segment style, too many lines and too many segments', async () => {
    const seg = { text: 'a', style: 'solid' };
    const base = validBlock('simulator');
    let errors = await errorsOf('simulator', {
      ...base,
      titleLines: [[{ text: 'a', style: 'rainbow' }]],
    });
    expect(errors[0].path).toBe('titleLines.0.0.style');
    errors = await errorsOf('simulator', {
      ...base,
      titleLines: Array(5).fill([seg]),
    });
    expect(errors[0].path).toBe('titleLines');
    errors = await errorsOf('simulator', {
      ...base,
      titleLines: [Array(5).fill(seg)],
    });
    expect(errors[0].path).toBe('titleLines.0');
  });

  it.each([
    'javascript:alert(1)',
    '//evil.com',
    '/\\evil.com',
    'http://x.com',
    'catalogo',
  ])('rejects href %s', async (href) => {
    const hero = validBlock('hero') as { panels: Record<string, unknown>[] };
    hero.panels[1].ctas = [{ label: 'x', href }];
    const errors = await errorsOf('hero', hero);
    expect(errors[0].path).toBe('panels.1.ctas.0.href');
  });

  it.each(['/', '/catalogo?x=1', '#sec-1', 'https://example.com/a'])(
    'accepts href %s',
    async (href) => {
      const hero = validBlock('hero') as { panels: Record<string, unknown>[] };
      hero.panels[1].ctas = [{ label: 'x', href }];
      await expect(validateLandingBlock('hero', hero)).resolves.toBeDefined();
    },
  );

  it('rejects vitrina duplicates, more than 12 and non-uuid ids', async () => {
    const id = '0b5d6a3e-1c1e-4b57-9d0a-2a8f2c7e9a10';
    await errorsOf('vitrina', validBlock('vitrina', [id, id]));
    const many = Array.from(
      { length: 13 },
      (_, i) =>
        `0b5d6a3e-1c1e-4b57-9d0a-2a8f2c7e9a${String(i).padStart(2, '0')}`,
    );
    await errorsOf('vitrina', validBlock('vitrina', many));
    await errorsOf('vitrina', validBlock('vitrina', ['nope']));
  });

  it('validates drop212 date, null date, duplicate tier ids and tier limit', async () => {
    const base = validBlock('drop212') as { tiers: Record<string, unknown>[] };
    await errorsOf('drop212', { ...base, targetDate: 'mañana' });
    await errorsOf('drop212', { ...base, targetDate: '2026-02-30T00:00:00Z' });
    await expect(
      validateLandingBlock('drop212', { ...base, targetDate: null }),
    ).resolves.toBeDefined();
    await expect(
      validateLandingBlock('drop212', { ...base, targetDate: undefined }),
    ).resolves.toBeDefined();
    await errorsOf('drop212', {
      ...base,
      tiers: [base.tiers[0], base.tiers[0]],
    });
    const six = Array.from({ length: 7 }, (_, i) => ({
      ...base.tiers[0],
      id: `t-${i}`,
    }));
    await errorsOf('drop212', { ...base, tiers: six });
  });

  it('rejects heroScene urls outside the allowed shapes', async () => {
    const base = validBlock('heroScene') as { cardImageUrls: string[] };
    const errors = await errorsOf('heroScene', {
      ...base,
      packImageUrl: 'https://evil.com/x.png',
      cardImageUrls: ['/img/a.webp', '/etc/passwd', '/img/c.gif'],
    });
    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining(['packImageUrl', 'cardImageUrls']),
    );
  });

  it('rejects payloads over 20 KB', async () => {
    const errors = await errorsOf('ticker', {
      items: [{ text: 'x'.repeat(25_000) }],
    });
    expect(errors[0].messages[0]).toMatch(/maximum/);
  });
});
