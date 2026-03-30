/**
 * Property 13: ES Module Syntax
 *
 * For any JavaScript file in the js/ directory, the file shall contain at least
 * one `export` statement and shall not assign to `window.*` globals for
 * inter-module communication.
 *
 * Feature: hackrf-drone-detector-refactor
 * Property 13: ES Module Syntax
 * Validates: Requirements 12.3
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const JS_DIR = path.resolve('js');

const EXPECTED_FILES = [
  'logger.js',
  'dsp.js',
  'hackrf-manager.js',
  'frequency-controller.js',
  'droneid-decoder.js',
  'detection-controller.js',
  'ui-manager.js',
  'main.js',
];

describe('Property 13: ES Module Syntax', () => {
  for (const file of EXPECTED_FILES) {
    const filePath = path.join(JS_DIR, file);

    it(`${file} exists in js/ directory`, () => {
      assert.ok(fs.existsSync(filePath), `Expected file js/${file} to exist`);
    });

    it(`${file} uses ES module syntax (export or import)`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      const hasExport = /\bexport\b/.test(content);
      const hasImport = /\bimport\b/.test(content);

      // main.js is the entry-point module — it only imports, never exports.
      // All other modules must have at least one export statement.
      if (file === 'main.js') {
        assert.ok(
          hasImport,
          `js/${file} is the entry-point and must use ES module import syntax`
        );
      } else {
        assert.ok(
          hasExport,
          `js/${file} must contain at least one 'export' statement`
        );
      }
    });

    it(`${file} does not contain window.* global assignments`, () => {
      const content = fs.readFileSync(filePath, 'utf-8');
      // Match window.something = ... patterns (assignments to window globals)
      // Exclude event listener registrations like window.addEventListener
      const lines = content.split('\n');
      const windowAssignments = [];
      for (const line of lines) {
        // Match window.foo = ... but not window.addEventListener(...)
        if (/window\.\w+\s*=/.test(line) && !/window\.addEventListener/.test(line)) {
          windowAssignments.push(line.trim());
        }
      }
      assert.strictEqual(
        windowAssignments.length,
        0,
        `js/${file} must not assign to window.* globals, found: ${JSON.stringify(windowAssignments)}`
      );
    });
  }
});
