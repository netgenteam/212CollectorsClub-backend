import { buildPageMeta } from './pagination.js';

describe('buildPageMeta (Story 15.2, FR-64)', () => {
  it('first page of several', () => {
    expect(buildPageMeta(1, 10, 25)).toEqual({
      page: 1,
      limit: 10,
      total: 25,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: false,
    });
  });

  it('middle page', () => {
    const m = buildPageMeta(2, 10, 25);
    expect([m.hasNextPage, m.hasPreviousPage]).toEqual([true, true]);
  });

  it('last page', () => {
    const m = buildPageMeta(3, 10, 25);
    expect([m.hasNextPage, m.hasPreviousPage]).toEqual([false, true]);
  });

  it('zero results', () => {
    expect(buildPageMeta(1, 10, 0)).toEqual({
      page: 1,
      limit: 10,
      total: 0,
      totalPages: 0,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  });

  it('page beyond totalPages', () => {
    const m = buildPageMeta(9, 10, 25);
    expect([m.totalPages, m.hasNextPage, m.hasPreviousPage]).toEqual([
      3,
      false,
      true,
    ]);
  });

  it('exact multiple of limit has no extra page', () => {
    const m = buildPageMeta(2, 10, 20);
    expect([m.totalPages, m.hasNextPage]).toEqual([2, false]);
  });
});
