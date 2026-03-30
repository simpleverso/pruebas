/**
 * Property 3: Logger Message Format
 *
 * For any log level, module name, and message string, calling the corresponding
 * logger method shall produce output that contains a timestamp matching HH:MM:SS
 * pattern, the level label (DEBUG/INFO/WARNING/ERROR/SUCCESS), and the module name.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 3: Logger Message Format
 * Validates: Requirements 3.4
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

// Map log levels to their method names and expected labels
const LEVEL_CONFIG = [
  { level: LogLevel.DEBUG, method: 'debug', label: 'DEBUG', consoleMethod: 'debug' },
  { level: LogLevel.INFO, method: 'info', label: 'INFO', consoleMethod: 'info' },
  { level: LogLevel.WARNING, method: 'warning', label: 'WARNING', consoleMethod: 'warn' },
  { level: LogLevel.ERROR, method: 'error', label: 'ERROR', consoleMethod: 'error' },
  { level: LogLevel.SUCCESS, method: 'success', label: 'SUCCESS', consoleMethod: 'log' },
];

// HH:MM:SS pattern (with optional .mmm milliseconds)
const TIMESTAMP_PATTERN = /\d{2}:\d{2}:\d{2}/;

// Generator for non-empty alphanumeric module names
const moduleNameArb = fc.stringMatching(/^[a-zA-Z0-9]{1,30}$/);

// Generator for arbitrary message strings (non-empty)
const messageArb = fc.string({ minLength: 1, maxLength: 100 });

describe('Property 3: Logger Message Format', () => {
  let capturedOutput;
  let originalConsole;

  beforeEach(() => {
    capturedOutput = [];
    logEntries.length = 0;

    // Capture all console methods
    originalConsole = {};
    for (const { consoleMethod } of LEVEL_CONFIG) {
      originalConsole[consoleMethod] = console[consoleMethod];
      console[consoleMethod] = (...args) => {
        capturedOutput.push(args.join(' '));
      };
    }

    // Ensure logger accepts all levels
    logger.setLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    // Restore console methods
    for (const { consoleMethod } of LEVEL_CONFIG) {
      console[consoleMethod] = originalConsole[consoleMethod];
    }
  });

  for (const { method, label, consoleMethod } of LEVEL_CONFIG) {
    it(`[${label}] output contains timestamp (HH:MM:SS), level label, and module name`, () => {
      fc.assert(
        fc.property(moduleNameArb, messageArb, (moduleName, message) => {
          // Reset captures
          capturedOutput.length = 0;
          logEntries.length = 0;

          // Call the logger method
          logger[method](moduleName, message);

          // Verify console output
          assert.ok(
            capturedOutput.length > 0,
            `Expected console.${consoleMethod} to be called for ${label}`
          );

          const consoleOutput = capturedOutput[0];

          // Verify timestamp pattern HH:MM:SS
          assert.ok(
            TIMESTAMP_PATTERN.test(consoleOutput),
            `Console output should contain HH:MM:SS timestamp. Got: "${consoleOutput}"`
          );

          // Verify level label
          assert.ok(
            consoleOutput.includes(label),
            `Console output should contain level label "${label}". Got: "${consoleOutput}"`
          );

          // Verify module name
          assert.ok(
            consoleOutput.includes(moduleName),
            `Console output should contain module name "${moduleName}". Got: "${consoleOutput}"`
          );

          // Verify DOM output has the same properties (except DEBUG which skips DOM for performance)
          if (label !== 'DEBUG') {
            assert.ok(
              logEntries.length > 0,
              `Expected DOM entry to be appended for ${label}`
            );

            const domText = logEntries[logEntries.length - 1].textContent;

            assert.ok(
              TIMESTAMP_PATTERN.test(domText),
              `DOM output should contain HH:MM:SS timestamp. Got: "${domText}"`
            );

            assert.ok(
              domText.includes(label),
              `DOM output should contain level label "${label}". Got: "${domText}"`
            );

            assert.ok(
              domText.includes(moduleName),
              `DOM output should contain module name "${moduleName}". Got: "${domText}"`
            );
          }
        }),
        { numRuns: 100 }
      );
    });
  }
});
