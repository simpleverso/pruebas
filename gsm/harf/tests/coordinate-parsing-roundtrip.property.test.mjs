/**
 * Property 11: Coordinate Parsing Round Trip
 *
 * For any integer coordinate value in the range [-1800000000, 1800000000],
 * encoding it as 4 big-endian bytes and then calling parseCoordinate() shall
 * return the original value divided by 10000000.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 11: Coordinate Parsing Round Trip
 * Validates: Requirements 7.3, 11.4
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

const { DroneIDDecoder } = await import('../js/droneid-decoder.js');

/**
 * Encode a signed 32-bit integer as 4 big-endian bytes.
 * Handles negative values via unsigned representation (two's complement).
 */
function encodeInt32BE(value) {
  // Convert to unsigned 32-bit representation for correct byte extraction
  const unsigned = value >>> 0;
  return [
    (unsigned >>> 24) & 0xFF,
    (unsigned >>> 16) & 0xFF,
    (unsigned >>> 8) & 0xFF,
    unsigned & 0xFF,
  ];
}

// Arbitrary for integers in the valid coordinate range
const coordIntArb = fc.integer({ min: -1800000000, max: 1800000000 });

describe('Property 11: Coordinate Parsing Round Trip', () => {
  it('encode as 4 big-endian bytes then parseCoordinate returns original / 10000000', () => {
    fc.assert(
      fc.property(coordIntArb, (intVal) => {
        const bytes = encodeInt32BE(intVal);
        const decoder = new DroneIDDecoder();
        const result = decoder.parseCoordinate(bytes, 0);
        const expected = intVal / 10000000;

        assert.strictEqual(result, expected,
          `For intVal=${intVal}: expected ${expected}, got ${result}`);
      }),
      { numRuns: 100 }
    );
  });
});
