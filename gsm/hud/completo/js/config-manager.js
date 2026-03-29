// config-manager.js — ConfigManager
// Handles config.json persistence (localStorage), export/import, schema validation.
// Provides: load, save, exportToFile, importFromFile, getDefaults, validate
// Requirements: 20.1–20.8

/* global globalThis */
var ConfigManager = (function () {
  var STORAGE_KEY = 'ptz-vision-hud-config';
  var CURRENT_SCHEMA_VERSION = 1;

  /**
   * Returns the full default Config object matching the design schema.
   * @returns {object}
   */
  function getDefaults() {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,

      video: {
        lastDeviceId: null,
        fallbackEnabled: true
      },

      pipeline: {
        operations: [],
        enabled: false
      },

      frameSkip: {
        enabled: false,
        interval: 3
      },

      tracker: {
        minArea: 100,
        deadZone: 20,
        lostFrameThreshold: 10,
        reIdThreshold: 0.6,
        reIdWindowFrames: 30,
        descriptorBins: 9,
        spatialWeight: 0.4,
        areaWeight: 0.3,
        descriptorWeight: 0.3,
        motionDamping: 0.8,
        searchRegionScale: 1.5
      },

      tensorflow: {
        enabled: false,
        categories: [],
        confidenceThreshold: 0.5,
        inferenceInterval: 3,
        backendPreference: ['webgl', 'wasm', 'cpu']
      },

      serial: {
        lastPortId: null,
        fallbackEnabled: true,
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        ackTimeout: 500,
        retryCount: 3,
        commandTemplates: {}
      },

      ptz: {
        speedLevels: { slow: 25, medium: 50, fast: 100 },
        variableType: 'percent',
        deadZoneRadius: 20
      },

      deviceRules: {
        rules: [],
        interRuleDelay: 0
      },

      gamepad: {
        lastIndex: null,
        fallbackEnabled: true,
        deadZone: 0.15,
        holdDelay: 2000,
        mappings: {
          panAxis: 0,
          tiltAxis: 1,
          zoomAxis: 3,
          toggleTrackingButton: 4,
          lockTargetButton: 5,
          recordButton: 0
        }
      },

      calibration: {
        movement: null,
        light: null,
        deviceResponse: null,
        zoom: null,
        centering: {
          blob: null,
          tensorflow: null,
          tolerance: 0.05,
          maxIterations: 10
        }
      },

      hud: {
        reticleStyle: 'tactical-circle',
        reticleOpacity: 80,
        reticleThickness: 1,
        gridPreset: 'none',
        gridOpacity: 30,
        gridThickness: 1,
        gridN: 8,
        scanLineEffect: true
      },

      recording: {
        format: 'webm-vp9',
        resolution: '640x480',
        bitrate: 2500000
      }
    };
  }

  /**
   * List of required top-level sections in a valid Config.
   */
  var REQUIRED_SECTIONS = [
    'schemaVersion', 'video', 'pipeline', 'frameSkip', 'tracker',
    'tensorflow', 'serial', 'ptz', 'deviceRules', 'gamepad',
    'calibration', 'hud', 'recording'
  ];

  /**
   * Deep-merge source into target. For each key in target:
   * - If source has the key and it's a plain object (and target's is too), recurse.
   * - If source has the key and it's a valid value (not undefined), use source's value.
   * - Otherwise keep target's default.
   * Returns { merged, warnings } where warnings lists paths reset to defaults.
   */
  function deepMerge(target, source, path) {
    var merged = {};
    var warnings = [];
    path = path || '';

    var keys = Object.keys(target);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var fullPath = path ? path + '.' + key : key;
      var targetVal = target[key];
      var sourceVal = source !== null && source !== undefined ? source[key] : undefined;

      if (sourceVal === undefined || sourceVal === null && targetVal !== null) {
        // Missing from source — use default
        merged[key] = deepClone(targetVal);
        if (sourceVal === undefined && path !== '') {
          warnings.push('Field "' + fullPath + '" missing, reset to default');
        }
      } else if (isPlainObject(targetVal) && isPlainObject(sourceVal)) {
        // Both are objects — recurse
        var result = deepMerge(targetVal, sourceVal, fullPath);
        merged[key] = result.merged;
        warnings = warnings.concat(result.warnings);
      } else {
        // Use source value
        merged[key] = deepClone(sourceVal);
      }
    }

    return { merged: merged, warnings: warnings };
  }

  /**
   * Check if a value is a plain object (not array, not null).
   */
  function isPlainObject(val) {
    return val !== null && typeof val === 'object' && !Array.isArray(val);
  }

  /**
   * Deep clone a value using JSON round-trip.
   */
  function deepClone(val) {
    if (val === null || val === undefined) return val;
    return JSON.parse(JSON.stringify(val));
  }

  /**
   * Validate a config object. Checks that all required sections exist
   * and fills missing fields with defaults.
   * @param {unknown} config - The config to validate
   * @returns {{ valid: boolean, errors: string[] }}
   */
  function validate(config) {
    var errors = [];

    if (config === null || config === undefined || typeof config !== 'object' || Array.isArray(config)) {
      errors.push('Config must be a non-null object');
      return { valid: false, errors: errors };
    }

    // Check schemaVersion
    if (typeof config.schemaVersion !== 'number') {
      errors.push('Missing or invalid "schemaVersion" field');
    }

    // Check all required sections
    var defaults = getDefaults();
    for (var i = 0; i < REQUIRED_SECTIONS.length; i++) {
      var section = REQUIRED_SECTIONS[i];
      if (section === 'schemaVersion') continue; // already checked
      if (config[section] === undefined || config[section] === null) {
        errors.push('Missing required section: "' + section + '"');
      } else if (isPlainObject(defaults[section]) && !isPlainObject(config[section])) {
        errors.push('Section "' + section + '" must be an object');
      }
    }

    return { valid: errors.length === 0, errors: errors };
  }

  /**
   * Load config from localStorage. Returns defaults merged with stored config.
   * @returns {object}
   */
  function load() {
    var defaults = getDefaults();

    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return deepClone(defaults);

      var parsed = JSON.parse(raw);
      var result = deepMerge(defaults, parsed, '');
      return result.merged;
    } catch (e) {
      // Corrupted data — return defaults
      return deepClone(defaults);
    }
  }

  /**
   * Save config to localStorage as JSON.
   * @param {object} config
   */
  function save(config) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    } catch (e) {
      // Storage full or unavailable — fail silently in production
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('ConfigManager: failed to save config', e);
      }
    }
  }

  /**
   * Export current config as a downloadable config.json file.
   */
  function exportToFile() {
    var config = load();
    var json = JSON.stringify(config, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.href = url;
    a.download = 'config.json';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();

    // Cleanup
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Read text content from a File or Blob.
   * Uses .text() if available (modern browsers + Node), falls back to FileReader.
   * @param {File|Blob} file
   * @returns {Promise<string>}
   */
  function readFileText(file) {
    if (typeof file.text === 'function') {
      return file.text();
    }
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) { resolve(e.target.result); };
      reader.onerror = function () { reject(new Error('Failed to read file')); };
      reader.readAsText(file);
    });
  }

  /**
   * Import config from a File object. Reads, parses, validates, merges with defaults.
   * @param {File|Blob} file
   * @returns {Promise<{ applied: object, warnings: string[] }>}
   */
  function importFromFile(file) {
    if (!file) {
      return Promise.reject(new Error('No file provided'));
    }

    return readFileText(file).then(function (text) {
      var parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        throw new Error('Invalid JSON: ' + parseErr.message);
      }

      var defaults = getDefaults();
      var mergeResult = deepMerge(defaults, parsed, '');
      var applied = mergeResult.merged;
      var warnings = mergeResult.warnings;

      // Ensure schemaVersion is always current
      applied.schemaVersion = CURRENT_SCHEMA_VERSION;

      // Validate the merged result
      var validation = validate(applied);
      if (!validation.valid) {
        warnings = warnings.concat(validation.errors);
      }

      // Persist the imported config
      save(applied);

      return { applied: applied, warnings: warnings };
    });
  }

  return {
    load: load,
    save: save,
    exportToFile: exportToFile,
    importFromFile: importFromFile,
    getDefaults: getDefaults,
    validate: validate
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.ConfigManager = ConfigManager;
}
