/**
 * DOM ID Preservation (Property 1) and CSS Selector Preservation (Property 2)
 *
 * Property 1: For any element ID present in the original harf.html,
 * the refactored index.html shall contain an element with the same ID.
 *
 * Property 2: For any CSS selector defined in the original <style> block
 * of harf.html, the external css/styles.css shall contain a rule with
 * the same selector.
 *
 * Feature: hackrf-drone-detector-refactor
 * Validates: Requirements 1.4, 2.1, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const HARF_PATH = path.resolve('harf.html');
const INDEX_PATH = path.resolve('index.html');
const CSS_PATH = path.resolve('css/styles.css');

/**
 * Extract all id="..." attribute values from an HTML string.
 */
function extractIds(html) {
  const ids = new Set();
  const regex = /\bid=["']([^"']+)["']/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    ids.add(match[1]);
  }
  return ids;
}

/**
 * Extract CSS selectors from a CSS string.
 * Takes text before each '{', normalises whitespace, and deduplicates.
 */
function extractSelectors(css) {
  const selectors = new Set();
  // Remove CSS comments
  const cleaned = css.replace(/\/\*[\s\S]*?\*\//g, '');
  // Match everything before a '{'
  const regex = /([^{}]+)\{/g;
  let match;
  while ((match = regex.exec(cleaned)) !== null) {
    const raw = match[1].trim().replace(/\s+/g, ' ');
    if (raw) {
      selectors.add(raw);
    }
  }
  return selectors;
}

/**
 * Extract the content between the first <style> and </style> tags.
 */
function extractStyleBlock(html) {
  const match = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  return match ? match[1] : '';
}

// ── Property 1: DOM ID Preservation ──────────────────────────────────────────

describe('Property 1: DOM ID Preservation', () => {
  const harfHtml = fs.readFileSync(HARF_PATH, 'utf-8');
  const indexHtml = fs.readFileSync(INDEX_PATH, 'utf-8');
  const originalIds = extractIds(harfHtml);
  const refactoredIds = extractIds(indexHtml);

  it('harf.html contains at least one element ID', () => {
    assert.ok(originalIds.size > 0, 'Expected harf.html to have element IDs');
  });

  it('every ID from harf.html exists in index.html', () => {
    const missing = [];
    for (const id of originalIds) {
      if (!refactoredIds.has(id)) {
        missing.push(id);
      }
    }
    assert.strictEqual(
      missing.length,
      0,
      `IDs present in harf.html but missing from index.html: ${JSON.stringify(missing)}`
    );
  });
});

// ── Property 2: CSS Selector Preservation ────────────────────────────────────

describe('Property 2: CSS Selector Preservation', () => {
  const harfHtml = fs.readFileSync(HARF_PATH, 'utf-8');
  const styleBlock = extractStyleBlock(harfHtml);
  const originalSelectors = extractSelectors(styleBlock);

  const cssContent = fs.readFileSync(CSS_PATH, 'utf-8');
  const externalSelectors = extractSelectors(cssContent);

  it('harf.html <style> block contains at least one CSS selector', () => {
    assert.ok(originalSelectors.size > 0, 'Expected harf.html to have CSS selectors');
  });

  it('every CSS selector from harf.html <style> exists in css/styles.css', () => {
    const missing = [];
    for (const selector of originalSelectors) {
      if (!externalSelectors.has(selector)) {
        missing.push(selector);
      }
    }
    assert.strictEqual(
      missing.length,
      0,
      `Selectors present in harf.html but missing from css/styles.css: ${JSON.stringify(missing)}`
    );
  });
});
