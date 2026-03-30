/**
 * Property 7: FFT Size Invariant
 *
 * For any valid power-of-2 FFT size N and any array of N Complex numbers,
 * FFT.forward() shall return an array of exactly N Complex numbers,
 * and the bit-reversed indices array shall have length N.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 7: FFT Size Invariant
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

const { Complex, FFT } = await import('../js/dsp.js');

// Arbitrary for finite doubles (avoid NaN/Infinity)
const finiteDouble = fc.double({ min: -1e6, max: 1e6, noNaN: true });

// Power-of-2 sizes kept small for test performance
const powerOf2Sizes = [2, 4, 8, 16, 32, 64];

// Arbitrary: pick a power-of-2 size, then generate that many Complex numbers
const fftInputArb = fc.constantFrom(...powerOf2Sizes).chain((size) =>
  fc.tuple(
    fc.constant(size),
    fc.array(fc.tuple(finiteDouble, finiteDouble), { minLength: size, maxLength: size })
  )
);

describe('Property 7: FFT Size Invariant', () => {
  it('FFT.forward() output length equals input length for any power-of-2 size', () => {
    fc.assert(
      fc.property(fftInputArb, ([size, pairs]) => {
        const input = pairs.map(([re, im]) => new Complex(re, im));
        const fft = new FFT(size);
        const output = fft.forward(input);

        assert.strictEqual(output.length, size,
          `FFT output length: expected ${size}, got ${output.length}`);
      }),
      { numRuns: 100 }
    );
  });

  it('bit-reversed indices array length equals FFT size', () => {
    fc.assert(
      fc.property(fftInputArb, ([size, _pairs]) => {
        const fft = new FFT(size);

        assert.strictEqual(fft.bitReversedIndices.length, size,
          `bit-reversed indices length: expected ${size}, got ${fft.bitReversedIndices.length}`);
      }),
      { numRuns: 100 }
    );
  });

  it('FFT.forward() output elements are all Complex instances', () => {
    fc.assert(
      fc.property(fftInputArb, ([size, pairs]) => {
        const input = pairs.map(([re, im]) => new Complex(re, im));
        const fft = new FFT(size);
        const output = fft.forward(input);

        for (let i = 0; i < output.length; i++) {
          assert.ok(output[i] instanceof Complex,
            `output[${i}] is not a Complex instance`);
          assert.strictEqual(typeof output[i].re, 'number',
            `output[${i}].re is not a number`);
          assert.strictEqual(typeof output[i].im, 'number',
            `output[${i}].im is not a number`);
        }
      }),
      { numRuns: 100 }
    );
  });
});
