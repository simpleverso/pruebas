/**
 * Property 6: Complex Arithmetic Correctness
 *
 * For any two Complex numbers (a, b), the following must hold:
 * - a.add(b) equals Complex(a.re + b.re, a.im + b.im)
 * - a.sub(b) equals Complex(a.re - b.re, a.im - b.im)
 * - a.mul(b) equals Complex(a.re*b.re - a.im*b.im, a.re*b.im + a.im*b.re)
 * - a.magnitude() equals sqrt(a.re² + a.im²)
 * - a.conjugate() equals Complex(a.re, -a.im)
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 6: Complex Arithmetic Correctness
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

const { Complex } = await import('../js/dsp.js');

// Arbitrary for finite doubles (avoid NaN/Infinity which break arithmetic checks)
const finiteDouble = fc.double({ min: -1e6, max: 1e6, noNaN: true });

// Arbitrary for a Complex number pair
const complexPairArb = fc.tuple(finiteDouble, finiteDouble, finiteDouble, finiteDouble);

describe('Property 6: Complex Arithmetic Correctness', () => {
  it('a.add(b) equals Complex(a.re + b.re, a.im + b.im)', () => {
    fc.assert(
      fc.property(complexPairArb, ([aRe, aIm, bRe, bIm]) => {
        const a = new Complex(aRe, aIm);
        const b = new Complex(bRe, bIm);
        const result = a.add(b);

        assert.strictEqual(result.re, aRe + bRe, `add real: expected ${aRe + bRe}, got ${result.re}`);
        assert.strictEqual(result.im, aIm + bIm, `add imag: expected ${aIm + bIm}, got ${result.im}`);
      }),
      { numRuns: 100 }
    );
  });

  it('a.sub(b) equals Complex(a.re - b.re, a.im - b.im)', () => {
    fc.assert(
      fc.property(complexPairArb, ([aRe, aIm, bRe, bIm]) => {
        const a = new Complex(aRe, aIm);
        const b = new Complex(bRe, bIm);
        const result = a.sub(b);

        assert.strictEqual(result.re, aRe - bRe, `sub real: expected ${aRe - bRe}, got ${result.re}`);
        assert.strictEqual(result.im, aIm - bIm, `sub imag: expected ${aIm - bIm}, got ${result.im}`);
      }),
      { numRuns: 100 }
    );
  });

  it('a.mul(b) equals Complex(a.re*b.re - a.im*b.im, a.re*b.im + a.im*b.re)', () => {
    fc.assert(
      fc.property(complexPairArb, ([aRe, aIm, bRe, bIm]) => {
        const a = new Complex(aRe, aIm);
        const b = new Complex(bRe, bIm);
        const result = a.mul(b);

        const expectedRe = aRe * bRe - aIm * bIm;
        const expectedIm = aRe * bIm + aIm * bRe;

        assert.strictEqual(result.re, expectedRe, `mul real: expected ${expectedRe}, got ${result.re}`);
        assert.strictEqual(result.im, expectedIm, `mul imag: expected ${expectedIm}, got ${result.im}`);
      }),
      { numRuns: 100 }
    );
  });

  it('a.magnitude() equals sqrt(a.re² + a.im²)', () => {
    fc.assert(
      fc.property(fc.tuple(finiteDouble, finiteDouble), ([re, im]) => {
        const a = new Complex(re, im);
        const result = a.magnitude();
        const expected = Math.sqrt(re * re + im * im);

        assert.strictEqual(result, expected, `magnitude: expected ${expected}, got ${result}`);
      }),
      { numRuns: 100 }
    );
  });

  it('a.conjugate() equals Complex(a.re, -a.im)', () => {
    fc.assert(
      fc.property(fc.tuple(finiteDouble, finiteDouble), ([re, im]) => {
        const a = new Complex(re, im);
        const result = a.conjugate();

        assert.strictEqual(result.re, re, `conjugate real: expected ${re}, got ${result.re}`);
        assert.strictEqual(result.im, -im, `conjugate imag: expected ${-im}, got ${result.im}`);
      }),
      { numRuns: 100 }
    );
  });
});
