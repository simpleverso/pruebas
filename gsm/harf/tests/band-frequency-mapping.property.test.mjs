/**
 * Property 12: Band-to-Frequency Mapping
 *
 * For any band name in {'2.4', '5.8', '1.4'}, the frequency controller shall
 * resolve it to the same constant as the original: 2437000000, 5200000000,
 * or 1420000000 Hz respectively.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 12: Band-to-Frequency Mapping
 * Validates: Requirements 5.3, 11.2
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// Stub DOM so logger (imported by frequency-controller) can load
globalThis.document = {
  getElementById() { return null; },
  createElement() { return { className: '', textContent: '' }; },
  querySelectorAll() { return []; },
};

const { default: frequencyController, DRONEID_FREQ_2_4, DRONEID_FREQ_5_8, DRONEID_FREQ_1_4 } =
  await import('../js/frequency-controller.js');

const EXPECTED_MAPPING = {
  '2.4': 2437000000,
  '5.8': 5200000000,
  '1.4': 1420000000,
};

describe('Property 12: Band-to-Frequency Mapping', () => {
  it('getFrequencyForBand returns the correct constant for any valid band', () => {
    fc.assert(
      fc.property(fc.constantFrom('2.4', '5.8', '1.4'), (band) => {
        const freq = frequencyController.getFrequencyForBand(band);
        assert.strictEqual(
          freq,
          EXPECTED_MAPPING[band],
          `Band '${band}': expected ${EXPECTED_MAPPING[band]}, got ${freq}`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('exported frequency constants match the expected values', () => {
    fc.assert(
      fc.property(fc.constantFrom('2.4', '5.8', '1.4'), (band) => {
        const constantMap = {
          '2.4': DRONEID_FREQ_2_4,
          '5.8': DRONEID_FREQ_5_8,
          '1.4': DRONEID_FREQ_1_4,
        };
        assert.strictEqual(
          constantMap[band],
          EXPECTED_MAPPING[band],
          `Exported constant for '${band}': expected ${EXPECTED_MAPPING[band]}, got ${constantMap[band]}`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('getFrequencyForBand and exported constants agree for any valid band', () => {
    fc.assert(
      fc.property(fc.constantFrom('2.4', '5.8', '1.4'), (band) => {
        const fromMethod = frequencyController.getFrequencyForBand(band);
        const constantMap = {
          '2.4': DRONEID_FREQ_2_4,
          '5.8': DRONEID_FREQ_5_8,
          '1.4': DRONEID_FREQ_1_4,
        };
        assert.strictEqual(
          fromMethod,
          constantMap[band],
          `Band '${band}': method returned ${fromMethod}, constant is ${constantMap[band]}`
        );
      }),
      { numRuns: 100 }
    );
  });
});
