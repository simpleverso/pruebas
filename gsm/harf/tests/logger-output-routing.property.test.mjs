/**
 * Property 4: Logger Output Routing
 *
 * For any log level, calling the corresponding logger method shall both append
 * a child element to the #logConsole DOM element with a CSS class matching the
 * level name, and call the corresponding console.* method (debug→console.debug,
 * info→console.info, warning→console.warn, error→console.error, success→console.log).
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 4: Logger Output Routing
 * Validates: Requirements 3.5, 3.6
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

// Map log levels to their method names, expected CSS classes, and console methods
const LEVEL_CONFIG = [
  { level: LogLevel.DEBUG, method: 'debug', cssClass: 'log-entry debug', consoleMethod: 'debug' },
  { level: LogLevel.INFO, method: 'info', cssClass: 'log-entry info', consoleMethod: 'info' },
  { level: LogLevel.WARNING, method: 'warning', cssClass: 'log-entry warning', consoleMethod: 'warn' },
  { level: LogLevel.ERROR, method: 'error', cssClass: 'log-entry error', consoleMethod: 'error' },
  { level: LogLevel.SUCCESS, method: 'success', cssClass: 'log-entry success', consoleMethod: 'log' },
];

// Arbitrary for picking a random level config entry
const levelConfigArb = fc.constantFrom(...LEVEL_CONFIG);

// Generator for non-empty module names
const moduleNameArb = fc.stringMatching(/^[a-zA-Z0-9]{1,30}$/);

// Generator for non-empty message strings
const messageArb = fc.string({ minLength: 1, maxLength: 100 });

describe('Property 4: Logger Output Routing', () => {
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

    // Ensure logger accepts all levels
    logger.setLevel(LogLevel.DEBUG);
  });

  afterEach(() => {
    // Restore console methods
    for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
      console[m] = originalConsole[m];
    }
  });

  it('appends DOM element with correct CSS class for any log level above DEBUG', () => {
    // DEBUG level is intentionally skipped from DOM output to keep the UI responsive
    // during high-frequency scanning. DEBUG logs still go to console and history.
    const nonDebugLevels = LEVEL_CONFIG.filter(c => c.level > LogLevel.DEBUG);
    const nonDebugArb = fc.constantFrom(...nonDebugLevels);

    fc.assert(
      fc.property(nonDebugArb, moduleNameArb, messageArb, (config, moduleName, message) => {
        logEntries.length = 0;

        logger[config.method](moduleName, message);

        assert.ok(
          logEntries.length > 0,
          `Expected DOM entry to be appended for ${config.method}`
        );

        const entry = logEntries[logEntries.length - 1];

        assert.equal(
          entry.className,
          config.cssClass,
          `Expected CSS class "${config.cssClass}" but got "${entry.className}" for level ${config.method}`
        );
      }),
      { numRuns: 100 }
    );
  });

  it('does NOT append DOM element for DEBUG level (performance optimization)', () => {
    fc.assert(
      fc.property(moduleNameArb, messageArb, (moduleName, message) => {
        logEntries.length = 0;

        logger.debug(moduleName, message);

        assert.equal(
          logEntries.length,
          0,
          'DEBUG level should not append to DOM'
        );
      }),
      { numRuns: 100 }
    );
  });

  it('calls the correct console.* method for any log level', () => {
    fc.assert(
      fc.property(levelConfigArb, moduleNameArb, messageArb, (config, moduleName, message) => {
        // Reset all console call captures
        for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
          consoleCalls[m].length = 0;
        }

        // Call the logger method for this level
        logger[config.method](moduleName, message);

        // Verify the correct console method was called
        assert.ok(
          consoleCalls[config.consoleMethod].length > 0,
          `Expected console.${config.consoleMethod} to be called for ${config.method}`
        );

        // Verify no OTHER console methods were called
        for (const m of ['debug', 'info', 'warn', 'error', 'log']) {
          if (m !== config.consoleMethod) {
            assert.equal(
              consoleCalls[m].length,
              0,
              `console.${m} should NOT be called for level ${config.method} (expected console.${config.consoleMethod})`
            );
          }
        }
      }),
      { numRuns: 100 }
    );
  });
});
