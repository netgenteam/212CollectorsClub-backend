import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto.js';
import { UpdateProductDto } from './update-product.dto.js';

const BASE_CREATE = {
  name: 'Charizard',
  slug: 'charizard',
  description: 'desc',
  franchise: 'POKEMON',
  productType: 'SINGLE_CARD',
  rarity: 'RARE',
  priceUsd: '10.50',
  stock: '3',
  categoryId: 'dd848f24-aac0-4346-ae25-b672bb0d7e14',
};

async function errorsFor(
  cls: typeof CreateProductDto | typeof UpdateProductDto,
  extra: Record<string, unknown>,
  base: Record<string, unknown> = {},
): Promise<string[]> {
  const dto = plainToInstance(cls, { ...base, ...extra });
  const errors = await validate(dto);
  return errors.map((e) => e.property);
}

describe.each([
  ['CreateProductDto', CreateProductDto, BASE_CREATE],
  ['UpdateProductDto', UpdateProductDto, {}],
] as const)('%s collectibles fields (Story 11.1)', (_name, cls, base) => {
  it('accepts a graded slab and a preorder (multipart-style strings)', async () => {
    expect(
      await errorsFor(
        cls,
        {
          gradingCompany: 'PSA',
          gradeValue: '10',
          certNumber: 'AB12345678',
          isPreorder: 'true',
          releaseDate: '2027-01-15T00:00:00.000Z',
        },
        base,
      ),
    ).toEqual([]);
  });

  it('accepts RAW without cert/grade', async () => {
    expect(await errorsFor(cls, { gradingCompany: 'RAW' }, base)).toEqual([]);
  });

  // Cross-field rule: body-only on create; on PATCH the service validates
  // against the stored company (covered by e2e + service specs).
  if (cls === CreateProductDto) {
    it.each([
      [
        'certNumber without gradingCompany',
        { certNumber: '123' },
        'certNumber',
      ],
      ['gradeValue without gradingCompany', { gradeValue: '9' }, 'gradeValue'],
      [
        'certNumber with RAW',
        { gradingCompany: 'RAW', certNumber: '123' },
        'certNumber',
      ],
      [
        'gradeValue with RAW',
        { gradingCompany: 'RAW', gradeValue: '9' },
        'gradeValue',
      ],
    ])('rejects %s', async (_label, extra, property) => {
      expect(await errorsFor(cls, extra, base)).toContain(property);
    });
  }

  it('accepts null to clear releaseDate/gradingCompany on PATCH', async () => {
    if (cls !== UpdateProductDto) return;
    expect(
      await errorsFor(cls, { releaseDate: null, gradingCompany: null }, base),
    ).toEqual([]);
  });

  it.each([
    [
      'non-alphanumeric certNumber',
      { gradingCompany: 'PSA', certNumber: '12-34' },
      'certNumber',
    ],
    ['unknown gradingCompany', { gradingCompany: 'XYZ' }, 'gradingCompany'],
    ['invalid releaseDate', { releaseDate: 'soon' }, 'releaseDate'],
  ])('rejects %s', async (_label, extra, property) => {
    expect(await errorsFor(cls, extra, base)).toContain(property);
  });
});

describe.each([
  ['CreateProductDto', CreateProductDto, BASE_CREATE],
  ['UpdateProductDto', UpdateProductDto, {}],
] as const)('%s marketReferences (Story 11.4)', (_name, cls, base) => {
  const ok = {
    provider: 'CARDMARKET',
    label: 'CM',
    url: 'https://www.cardmarket.com/x',
    suggestedPriceEur: 10,
  };

  it('accepts a valid array, [] and a JSON-encoded string (multipart)', async () => {
    expect(await errorsFor(cls, { marketReferences: [ok] }, base)).toEqual([]);
    expect(await errorsFor(cls, { marketReferences: [] }, base)).toEqual([]);
    expect(
      await errorsFor(cls, { marketReferences: JSON.stringify([ok]) }, base),
    ).toEqual([]);
  });

  it.each([
    ['javascript: url', { ...ok, url: 'javascript:alert(1)' }],
    ['data: url', { ...ok, url: 'data:text/html,x' }],
    ['ftp url', { ...ok, url: 'ftp://x.test/a' }],
    ['relative url', { ...ok, url: '/cert/1' }],
    ['unknown provider', { ...ok, provider: 'EBAY' }],
    ['negative price', { ...ok, suggestedPriceEur: -1 }],
    ['empty label', { ...ok, label: '' }],
  ])('rejects %s', async (_label, ref) => {
    expect(await errorsFor(cls, { marketReferences: [ref] }, base)).toContain(
      'marketReferences',
    );
  });

  it('accepts http and suggestedPriceEur = 0', async () => {
    expect(
      await errorsFor(
        cls,
        {
          marketReferences: [
            { ...ok, url: 'http://x.test/a', suggestedPriceEur: 0 },
          ],
        },
        base,
      ),
    ).toEqual([]);
  });

  it('rejects non-array / unparseable JSON', async () => {
    expect(
      await errorsFor(cls, { marketReferences: 'not json' }, base),
    ).toContain('marketReferences');
    expect(
      await errorsFor(cls, { marketReferences: { a: 1 } }, base),
    ).toContain('marketReferences');
  });
});
