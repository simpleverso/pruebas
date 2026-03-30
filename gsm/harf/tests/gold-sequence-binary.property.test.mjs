/**
 * Property 9: GoldSequence Output is Binary
 *
 * For any seed value and requested length L, GoldSequence.generate(L) shall return
 * an array of exactly L values, where each value is either 0 or 1.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 9: GoldSequence Output is Binary
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

const { GoldSequence } = await import('../js/dsp.js');

// Arbitrary for seed: positive integers in range [1, 0x3FFFFFFF]
const seedArb = fc.integer({ min: 1, max: 0x3FFFFFFF });

// Arbitrary for length: integers in range [1, 1000]
const lengthArb = fc.integer({ min: 1, max: 1000 });

describe('Property 9: GoldSequence Output is Binary', () => {
  it('output array length equals requested length', () => {
    fc.assert(
      fc.property(seedArb, lengthArb, (seed, length) => {
        const gs = new GoldSequence(seed);
        const result = gs.generate(length);

        assert.strictEqual(result.length, length,
          `expected length ${length}, got ${result.length} (seed=0x${seed.toString(16)})`);
      }),
      { numRuns: 100 }
    );
  });

  it('each value in the output is either 0 or 1', () => {
    fc.assert(
      fc.property(seedArb, lengthArb, (seed, length) => {
        const gs = new GoldSequence(seed);
        const result = gs.generate(length);

        for (let i = 0; i < result.length; i++) {
          assert.ok(result[i] === 0 || result[i] === 1,
            `value at index ${i} is ${result[i]}, expected 0 or 1 (seed=0x${seed.toString(16)}, length=${length})`);
        }
      }),
      { numRuns: 100 }
    );
  });
});
