import { buildMarketReferences } from './market-references.js';

const PSA = { gradingCompany: 'PSA', certNumber: '82451937' };

describe('buildMarketReferences (Story 11.4, AD-21)', () => {
  it('returns [] with no stored refs and no PSA slab', () => {
    expect(
      buildMarketReferences({ gradingCompany: null, certNumber: null }, []),
    ).toEqual([]);
  });

  it('keeps stored order and maps suggestedPriceEur to number, omitting null', () => {
    const out = buildMarketReferences(
      { gradingCompany: null, certNumber: null },
      [
        {
          provider: 'CARDMARKET',
          label: 'CM',
          url: 'https://a.test',
          suggestedPriceEur: '12.50',
        },
        {
          provider: 'TCGPLAYER',
          label: 'TP',
          url: 'https://b.test',
          suggestedPriceEur: null,
        },
      ],
    );
    expect(out).toEqual([
      {
        provider: 'CARDMARKET',
        label: 'CM',
        url: 'https://a.test',
        suggestedPriceEur: 12.5,
      },
      { provider: 'TCGPLAYER', label: 'TP', url: 'https://b.test' },
    ]);
    expect('suggestedPriceEur' in out[1]).toBe(false);
  });

  it('appends the calculated PSA_CERT link after stored refs', () => {
    const out = buildMarketReferences(PSA, [
      {
        provider: 'CARDMARKET',
        label: 'CM',
        url: 'https://a.test',
        suggestedPriceEur: null,
      },
    ]);
    expect(out.map((r) => r.provider)).toEqual(['CARDMARKET', 'PSA_CERT']);
    expect(out[1].url).toBe('https://www.psacard.com/cert/82451937');
  });

  it('does not duplicate when a PSA_CERT is already stored', () => {
    const out = buildMarketReferences(PSA, [
      {
        provider: 'PSA_CERT',
        label: 'x',
        url: 'https://www.psacard.com/cert/1',
        suggestedPriceEur: null,
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe('https://www.psacard.com/cert/1');
  });

  it.each([
    [{ gradingCompany: 'BGS', certNumber: '123' }],
    [{ gradingCompany: 'CGC', certNumber: '123' }],
    [{ gradingCompany: 'RAW', certNumber: '123' }],
    [{ gradingCompany: 'PSA', certNumber: null }],
    [{ gradingCompany: 'PSA', certNumber: '' }],
    [{ gradingCompany: 'PSA', certNumber: 'bad/cert' }],
    [{ gradingCompany: null, certNumber: '123' }],
  ])('produces no calculated link for %j', (product) => {
    expect(buildMarketReferences(product, [])).toEqual([]);
  });
});
