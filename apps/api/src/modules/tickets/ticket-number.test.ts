import { describe, expect, it } from 'vitest';

import { generateTicketNumber } from './ticket-number.js';

describe('generateTicketNumber', () => {
  it('produces a dashed 4-4-4 code using only the unambiguous alphabet', () => {
    const number = generateTicketNumber();
    expect(number).toMatch(/^[0-9A-HJ-NPR-Z]{4}-[0-9A-HJ-NPR-Z]{4}-[0-9A-HJ-NPR-Z]{4}$/);
  });

  it('never produces I, L, O, or Q -- the characters this alphabet was built to exclude', () => {
    // Generate many codes rather than relying on one sample: the whole
    // point of this test is proving the EXCLUSION holds across the
    // alphabet's actual character space, not just that one lucky/unlucky
    // draw happened to avoid them.
    for (let i = 0; i < 500; i += 1) {
      expect(generateTicketNumber()).not.toMatch(/[ILOQ]/);
    }
  });

  it('generates different codes across calls (not a fixed/predictable value)', () => {
    const codes = new Set(Array.from({ length: 50 }, () => generateTicketNumber()));
    expect(codes.size).toBe(50);
  });
});
