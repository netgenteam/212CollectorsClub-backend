import { BadRequestException } from '@nestjs/common';
import { ParseIdOrSlugPipe } from './parse-id-or-slug.pipe.js';

describe('ParseIdOrSlugPipe (Story 21.1, AD-104)', () => {
  const pipe = new ParseIdOrSlugPipe();
  const uuid = 'f65915f5-2931-4e50-af95-630b1fd7b950';

  it.each([
    [uuid, { kind: 'id', value: uuid }],
    [uuid.toUpperCase(), { kind: 'id', value: uuid.toUpperCase() }],
    ['charizard-vmax', { kind: 'slug', value: 'charizard-vmax' }],
    ['a', { kind: 'slug', value: 'a' }],
    ['0151', { kind: 'slug', value: '0151' }],
    ['a'.repeat(200), { kind: 'slug', value: 'a'.repeat(200) }],
  ])('accepts %s', (input, expected) => {
    expect(pipe.transform(input)).toEqual(expected);
  });

  it('never reads a UUID as a slug', () => {
    expect(pipe.transform(uuid).kind).toBe('id');
  });

  it.each([
    'Foo_Bar!',
    'UPPER',
    'a--b',
    '-a',
    'a-',
    'a'.repeat(201),
    '%00',
    '\u0000',
    'a b',
    'café',
    'a/b',
  ])('rejects %j with the exact ParseUUIDPipe 400', (input) => {
    let error: unknown;
    try {
      pipe.transform(input);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toEqual({
      message: 'Validation failed (uuid is expected)',
      error: 'Bad Request',
      statusCode: 400,
    });
  });
});
