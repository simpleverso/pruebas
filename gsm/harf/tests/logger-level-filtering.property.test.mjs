/**
 * Property 5: Logger Level Filtering
 *
 * For any pair of (minLevel, messageLevel) where messageLevel is strictly below
 * minLevel, calling the logger method for messageLevel shall produce no DOM
 * output and no console output.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 5: Logger Level Filtering
 * Validates: Requirements 3.7
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';

// Mock the DOM before importing logger
const logEntries = [];

globalThis.document = {
  getElementById(id) {
    if (id === 'logConsole') {
      return {
        appendChild(child) {
          logEntries.push(child);
        },
        scrollTop: 0,
        scrollHeight: 0,
      };
    }
    return null;
  },
  createElement(tag) {
    return { className: '', textContent: '' };
  },
};

// Import logger after DOM mock is in place
const { default: logger, LogLevel } = await import('../js/logger.js');

// All levels in ascending order: DEBUG=0, INFO=1, WARNING=2, ERROR=3, SUCCESS=4
const ALL_LEVELS = [
  { value: LogLevel.DEBUG,   method: 'debug',   consoleMethod: 'debug' },
  { value: LogLevel.INFO,    method: 'info',    consoleMethod: 'info'  },
  { value: LogLevel.WARNING, method: 'warning', consoleMethod: 'warn'  },
  { value: LogLevel.ERROR,   method: 'error',   consoleMethod: 'error' },
  { value: LogLevel.SUCCESS, method: 'success', consoleMethod: 'log'   },
];

// Arbitrary that generates valid (minLevel, messageLevel) pairs where messageLevel < minLevel
// minLevel ranges from 1..4 (INFO..SUCCESS), messageLevel from 0..(minLevel-1)
const filteredPairArb = fc.integer({ min: 1, max: 4 }).chain((minLevel) =>
  fc.integer({ min: 0, max: minLevel - 1 }).map((messageLevel) => ({
    minLevel,
    messageLevel,
    minConfig: ALL_LEVELS[minLevel],
    msgConfig: ALL_LEVELS[messageLevel],
  }))
);

// Generator for non-empty module names
const moduleNameArb = fc.stringMatching(/^[a-zA-Z0-9]{1,30}$/);

// Generator for non-empty message strings
const messageArb = fc.string({ minLength: 1, maxLength: 100 });

describe('Property 5: Logger Level Filtering', () => {
  let consoleCalls;
  let originalConsole;

  beforeEach(() => {
    consoleCalls = {};
    logEntries.length = 0;

    // Capture all console methods we care about
    originalConsole = {};
    for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
      originalConsole[m] = console[m];
      consoleCalls[m] = [];
      console[m] = (...args) => {
        consoleCalls[m].push(args);
      };
    }
  });

  afterEach(() => {
    // Restore console methods
    for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
      console[m] = originalConsole[m];
    }
  });

  it('produces no DOM output when messageLevel < minLevel', () => {
    fc.assert(
      fc.property(filteredPairArb, moduleNameArb, messageArb, (pair, moduleName, message) => {
        // Reset captures
        logEntries.length = 0;

        // Set the minimum level
        logger.setLevel(pair.minLevel);

        // Call the logger method for the lower (filtered) level
        logger[pair.msgConfig.method](moduleName, message);

        // Verify NO DOM element was appended
        assert.equal(
          logEntries.length,
          0,
          `Expected no DOM output when minLevel=${pair.minConfig.method}(${pair.minLevel}) ` +
          `and messageLevel=${pair.msgConfig.method}(${pair.messageLevel}), ` +
          `but ${logEntries.length} entries were appended`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('produces no console output when messageLevel < minLevel', () => {
    fc.assert(
      fc.property(filteredPairArb, moduleNameArb, messageArb, (pair, moduleName, message) => {
        // Reset all console call captures
        for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
          consoleCalls[m].length = 0;
        }

        // Set the minimum level
        logger.setLevel(pair.minLevel);

        // Call the logger method for the lower (filtered) level
        logger[pair.msgConfig.method](moduleName, message);

        // Verify NO console method was called at all
        for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
          assert.equal(
            consoleCalls[m].length,
            0,
            `Expected no console.${m} call when minLevel=${pair.minConfig.method}(${pair.minLevel}) ` +
            `and messageLevel=${pair.msgConfig.method}(${pair.messageLevel}), ` +
            `but console.${m} was called ${consoleCalls[m].length} time(s)`
          );
        }
      }),
      { numRuns: 100 }
    );
  });
});
