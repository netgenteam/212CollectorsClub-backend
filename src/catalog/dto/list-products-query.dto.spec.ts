import { plainToInstance } from 'class-transformer';
import {
  mergeCategoryIdAlias,
  ListProductsQueryDto,
} from './list-products-query.dto.js';

describe('categoryId[] alias (Story 15.2, AD-52)', () => {
  it('merge helper dedupes both forms and handles scalars', () => {
    expect(
      mergeCategoryIdAlias({
        value: ['a', 'b'],
        obj: { 'categoryId[]': ['b', 'c'] },
      }),
    ).toEqual(['a', 'b', 'c']);
    expect(
      mergeCategoryIdAlias({ value: 'a', obj: { 'categoryId[]': 'b' } }),
    ).toEqual(['a', 'b']);
  });

  it('without the bracket key behaves like the plain form', () => {
    expect(mergeCategoryIdAlias({ value: 'a', obj: {} })).toEqual(['a']);
    expect(mergeCategoryIdAlias({ value: undefined, obj: {} })).toBeUndefined();
  });

  it('plainToInstance maps a bracket-only query into categoryId', () => {
    const dto = plainToInstance(ListProductsQueryDto, {
      'categoryId[]': ['x', 'y'],
    });
    expect(dto.categoryId).toEqual(['x', 'y']);
  });
});
