import { describe, expect, it } from 'vitest';
import { page } from '../test/page';
import { nextOffset, pageItems } from './paging';

describe('nextOffset', () => {
  it.each([
    ['nothing loaded yet', [], undefined],
    ['the first of three pages', [page([1, 2], 5)], 2],
    ['two pages', [page([1, 2], 5), page([3, 4], 5)], 4],
    ['every row', [page([1, 2], 5), page([3, 4], 5), page([5], 5)], undefined],
    ['an empty last page (rows were deleted meanwhile)', [page([1, 2], 5), page([], 5)], undefined],
    ['a list that shrank below what is loaded', [page([1, 2, 3], 2)], undefined],
  ])('after %s', (_case, pages, offset) => {
    expect(nextOffset(pages)).toBe(offset);
  });
});

describe('pageItems', () => {
  it('joins the loaded pages in order', () => {
    expect(pageItems({ pages: [page(['a', 'b'], 3), page(['c'], 3)], pageParams: [0, 2] })).toEqual(['a', 'b', 'c']);
    expect(pageItems(undefined)).toEqual([]);
  });
});
