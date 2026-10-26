import { buildTrackingUrl, isValidTrackingTemplate } from './tracking-url.js';

describe('isValidTrackingTemplate', () => {
  it('accepts https with exactly one marker', () => {
    expect(
      isValidTrackingTemplate('https://x.test/track?n={trackingNumber}'),
    ).toBe(true);
    expect(isValidTrackingTemplate('https://x.test/{trackingNumber}/a')).toBe(
      true,
    );
  });

  it.each([
    'http://x.test/{trackingNumber}',
    'https://x.test/track',
    'https://x.test/{trackingNumber}/{trackingNumber}',
    '{trackingNumber}',
    '',
  ])('rejects %s', (t) => {
    expect(isValidTrackingTemplate(t)).toBe(false);
  });
});

describe('buildTrackingUrl', () => {
  const tpl = 'https://x.test/track?n={trackingNumber}';
  it('substitutes and URL-encodes the number', () => {
    expect(buildTrackingUrl(tpl, 'AB-12')).toBe('https://x.test/track?n=AB-12');
    expect(buildTrackingUrl(tpl, 'A/B.1')).toBe(
      'https://x.test/track?n=A%2FB.1',
    );
  });
  it('returns null when number, template or both are missing', () => {
    expect(buildTrackingUrl(tpl, null)).toBeNull();
    expect(buildTrackingUrl(tpl, '')).toBeNull();
    expect(buildTrackingUrl(null, 'AB-12')).toBeNull();
    expect(buildTrackingUrl(undefined, undefined)).toBeNull();
  });
});
