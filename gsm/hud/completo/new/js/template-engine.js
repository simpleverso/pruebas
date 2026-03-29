// template-engine.js — TemplateEngine
// Parses and evaluates command templates with placeholder substitution.
// Supported placeholders: {percent}, {percent_signed}, {angle}, {angle_delta},
// {steps}, {speed}, {direction}, {raw_hex}
// Provides: compile, evaluate, validate
// Requirements: 8.5, 8.6, 8.7

(function () {
  'use strict';

  var SUPPORTED_PLACEHOLDERS = [
    'percent',
    'percent_signed',
    'angle',
    'angle_delta',
    'steps',
    'speed',
    'direction',
    'raw_hex'
  ];

  // Regex to match any {placeholder} token in a template string
  var PLACEHOLDER_REGEX = /\{([a-z_]+)\}/g;

  /**
   * compile(template) → CompiledTemplate
   *
   * Parses a command template string and extracts placeholders.
   * Returns an intermediate compiled form with:
   *   - raw: the original template string
   *   - placeholders: array of unique placeholder names found
   *   - hasRawHex: boolean indicating if {raw_hex} is present
   */
  function compile(template) {
    var raw = String(template);
    var placeholders = [];
    var seen = {};
    var match;

    // Reset regex lastIndex for global regex
    PLACEHOLDER_REGEX.lastIndex = 0;
    while ((match = PLACEHOLDER_REGEX.exec(raw)) !== null) {
      var name = match[1];
      if (SUPPORTED_PLACEHOLDERS.indexOf(name) !== -1 && !seen[name]) {
        placeholders.push(name);
        seen[name] = true;
      }
    }

    return {
      raw: raw,
      placeholders: placeholders,
      hasRawHex: placeholders.indexOf('raw_hex') !== -1
    };
  }

  /**
   * evaluate(compiled, variables) → string | Uint8Array
   *
   * Substitutes all placeholders in the compiled template with values from
   * the variables object. If the template contains {raw_hex} and the result
   * is a pure hex string, returns a Uint8Array of the decoded bytes.
   * If a placeholder variable is unavailable, substitutes "0" (or "" for
   * direction) and logs a warning.
   */
  function evaluate(compiled, variables) {
    variables = variables || {};
    var result = compiled.raw;

    // Replace each supported placeholder occurrence
    result = result.replace(PLACEHOLDER_REGEX, function (fullMatch, name) {
      if (SUPPORTED_PLACEHOLDERS.indexOf(name) === -1) {
        // Not a supported placeholder — leave as-is
        return fullMatch;
      }

      var value = variables[name];

      if (value === undefined || value === null) {
        // Unavailable variable — substitute fallback and warn
        if (typeof console !== 'undefined' && console.warn) {
          console.warn('[TemplateEngine] Placeholder {' + name + '} has no value; substituting fallback.');
        }
        return name === 'direction' ? '' : '0';
      }

      return String(value);
    });

    // If the template uses raw_hex and the entire result is a valid hex string,
    // convert to Uint8Array
    if (compiled.hasRawHex && /^[0-9a-fA-F]*$/.test(result) && result.length > 0 && result.length % 2 === 0) {
      var bytes = new Uint8Array(result.length / 2);
      for (var i = 0; i < result.length; i += 2) {
        bytes[i / 2] = parseInt(result.substring(i, i + 2), 16);
      }
      return bytes;
    }

    return result;
  }

  /**
   * validate(template) → { valid, placeholders, errors }
   *
   * Checks template syntax and returns:
   *   - valid: true if no errors
   *   - placeholders: list of recognized placeholder names found
   *   - errors: list of error messages (e.g., unrecognized placeholders, unclosed braces)
   */
  function validate(template) {
    var raw = String(template);
    var placeholders = [];
    var errors = [];
    var seen = {};
    var match;

    // Check for unclosed braces: { without matching }
    var openCount = 0;
    var closeCount = 0;
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] === '{') openCount++;
      if (raw[i] === '}') closeCount++;
    }
    if (openCount !== closeCount) {
      errors.push('Mismatched braces: ' + openCount + ' opening and ' + closeCount + ' closing braces.');
    }

    // Extract all {name} tokens
    PLACEHOLDER_REGEX.lastIndex = 0;
    while ((match = PLACEHOLDER_REGEX.exec(raw)) !== null) {
      var name = match[1];
      if (SUPPORTED_PLACEHOLDERS.indexOf(name) !== -1) {
        if (!seen[name]) {
          placeholders.push(name);
          seen[name] = true;
        }
      } else {
        errors.push('Unrecognized placeholder: {' + name + '}');
      }
    }

    return {
      valid: errors.length === 0,
      placeholders: placeholders,
      errors: errors
    };
  }

  // Expose as global IIFE
  globalThis.TemplateEngine = {
    compile: compile,
    evaluate: evaluate,
    validate: validate,
    SUPPORTED_PLACEHOLDERS: SUPPORTED_PLACEHOLDERS
  };
})();
