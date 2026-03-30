/**
 * Property 8: ZadoffChu Sequence Length
 *
 * For any root index and sequence length L, ZadoffChu.generate(root, L) shall return
 * an array of exactly L Complex numbers, and each element shall have magnitude
 * approximately equal to 1.0 (unit magnitude property of ZC sequences).
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 8: ZadoffChu Sequence Length
 * Validates: Requirements 6.3
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// Stub logger dependency so dsp.js can import without DOM
globalThis.document = {
  getElementById() { return null; },
  createElement() { return { className: '', textContent: '' }; },
};

const { ZadoffChu } = await import('../js/dsp.js');

// Arbitraries for root index and sequence length
const rootArb = fc.integer({ min: 1, max: 1000 });
const lengthArb = fc.integer({ min: 1, max: 512 });

describe('Property 8: ZadoffChu Sequence Length', () => {
  it('output array length equals requested length', () => {
    fc.assert(
      fc.property(rootArb, lengthArb, (root, length) => {
        const sequence = ZadoffChu.generate(root, length);
        assert.strictEqual(sequence.length, length,
          `Expected length ${length}, got ${sequence.length} for root=${root}`);
      }),
      { numRuns: 100 }
    );
  });

  it('each element has unit magnitude (≈1.0)', () => {
    fc.assert(
      fc.property(rootArb, lengthArb, (root, length) => {
        const sequence = ZadoffChu.generate(root, length);
        const tolerance = 1e-10;

        for (let i = 0; i < sequence.length; i++) {
          const mag = sequence[i].magnitude();
          assert.ok(
            Math.abs(mag - 1.0) < tolerance,
            `Element ${i} magnitude=${mag}, expected ≈1.0 (root=${root}, length=${length})`
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});
