import { ProductLanguage } from '../generated/prisma/enums.js';
import { LANGUAGE_NAMES, LANGUAGE_ORDER } from './language-names.js';

describe('LANGUAGE_NAMES (Story 13.7, AC10)', () => {
  it('has a non-empty name for every ProductLanguage value', () => {
    for (const code of Object.values(ProductLanguage)) {
      expect(LANGUAGE_NAMES[code]).toBeTruthy();
    }
    expect(Object.keys(LANGUAGE_NAMES).sort()).toEqual(
      Object.values(ProductLanguage).sort(),
    );
  });

  it('orders ES, EN, JP, CN, OTHER with Spanish names', () => {
    expect(LANGUAGE_ORDER).toEqual(['ES', 'EN', 'JP', 'CN', 'OTHER']);
    expect(LANGUAGE_ORDER.map((c) => LANGUAGE_NAMES[c])).toEqual([
      'Español',
      'Inglés',
      'Japonés',
      'Chino',
      'Otro',
    ]);
  });
});
