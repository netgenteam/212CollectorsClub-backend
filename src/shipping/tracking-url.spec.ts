import { isValidTrackingTemplate } from './tracking-url.js';

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
