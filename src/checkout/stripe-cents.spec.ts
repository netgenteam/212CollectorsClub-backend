import { Prisma } from '../generated/prisma/client.js';
import { usdToCents } from './checkout.service.js';

describe('usdToCents (Story 14.4, integer math, no floats)', () => {
  it.each([
    ['89.99', 8999],
    ['0.10', 10],
    ['0.01', 1],
    ['1234567.89', 123456789],
    ['10', 1000],
    ['19.9', 1990],
  ])('%s -> %i', (input, expected) => {
    expect(usdToCents(new Prisma.Decimal(input))).toBe(expected);
  });
});
