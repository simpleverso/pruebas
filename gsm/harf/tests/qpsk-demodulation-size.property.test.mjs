/**
 * Property 10: QPSK Demodulation Output Size
 *
 * For any array of N Complex subcarrier symbols, qpskDemodulate() shall return
 * an array of exactly 2×N bits, where each bit is either 0 or 1.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 10: QPSK Demodulation Output Size
 * Validates: Requirements 7.7
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// Stub DOM for logger dependency
globalThis.document = {
  getElementById() { return null; },
  createElement() { return { className: '', textContent: '' }; },
};

// Stub performance.now for DSP module timing calls
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => 0 };
}

const { Complex } = await import('../js/dsp.js');
const { DroneIDDecoder } = await import('../js/droneid-decoder.js');

// Arbitrary for finite doubles suitable for Complex components
const finiteDouble = fc.double({ min: -1e6, max: 1e6, noNaN: true });

// Arbitrary for a Complex number
const complexArb = fc.tuple(finiteDouble, finiteDouble).map(([re, im]) => new Complex(re, im));

// Arbitrary for an array of Complex numbers (length 1–100)
const complexArrayArb = fc.array(complexArb, { minLength: 1, maxLength: 100 });

describe('Property 10: QPSK Demodulation Output Size', () => {
  it('output length equals exactly 2 × input length', () => {
    fc.assert(
      fc.property(complexArrayArb, (subcarriers) => {
        const decoder = new DroneIDDecoder();
        const bits = decoder.qpskDemodulate(subcarriers);

        assert.strictEqual(bits.length, 2 * subcarriers.length,
          `Expected ${2 * subcarriers.length} bits, got ${bits.length} for input length=${subcarriers.length}`);
      }),
      { numRuns: 100 }
    );
  });

  it('each output value is either 0 or 1', () => {
    fc.assert(
      fc.property(complexArrayArb, (subcarriers) => {
        const decoder = new DroneIDDecoder();
        const bits = decoder.qpskDemodulate(subcarriers);

        for (let i = 0; i < bits.length; i++) {
          assert.ok(
            bits[i] === 0 || bits[i] === 1,
            `Bit at index ${i} is ${bits[i]}, expected 0 or 1`
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});
