// config-manager.test.js — Unit tests for ConfigManager
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './config-manager.js';

var ConfigManager = globalThis.ConfigManager;

// Mock localStorage
var store = {};
var localStorageMock = {
  getItem: function (key) { return store[key] || null; },
  setItem: function (key, val) { store[key] = String(val); },
  removeItem: function (key) { delete store[key]; },
  clear: function () { store = {}; }
};

beforeEach(function () {
  store = {};
  globalThis.localStorage = localStorageMock;
});

afterEach(function () {
  store = {};
});

describe('ConfigManager.getDefaults', function () {
  it('returns an object with schemaVersion 1', function () {
    var d = ConfigManager.getDefaults();
    expect(d.schemaVersion).toBe(1);
  });

  it('contains all required top-level sections', function () {
    var d = ConfigManager.getDefaults();
    var sections = [
      'schemaVersion', 'video', 'pipeline', 'frameSkip', 'tracker',
      'tensorflow', 'serial', 'ptz', 'deviceRules', 'gamepad',
      'calibration', 'hud', 'recording'
    ];
    for (var i = 0; i < sections.length; i++) {
      expect(d).toHaveProperty(sections[i]);
    }
  });

  it('has correct frameSkip defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.frameSkip.enabled).toBe(false);
    expect(d.frameSkip.interval).toBe(3);
  });

  it('has correct tracker defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.tracker.lostFrameThreshold).toBe(10);
    expect(d.tracker.reIdWindowFrames).toBe(30);
  });

  it('has correct tensorflow defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.tensorflow.confidenceThreshold).toBe(0.5);
    expect(d.tensorflow.backendPreference).toEqual(['webgl', 'wasm', 'cpu']);
  });

  it('has correct serial defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.serial.ackTimeout).toBe(500);
    expect(d.serial.retryCount).toBe(3);
    expect(d.serial.baudRate).toBe(9600);
  });

  it('has correct hud defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.hud.gridOpacity).toBe(30);
    expect(d.hud.reticleStyle).toBe('tactical-circle');
  });

  it('has correct calibration centering defaults', function () {
    var d = ConfigManager.getDefaults();
    expect(d.calibration.centering.tolerance).toBe(0.05);
    expect(d.calibration.centering.maxIterations).toBe(10);
  });

  it('returns a fresh copy each call (no shared references)', function () {
    var a = ConfigManager.getDefaults();
    var b = ConfigManager.getDefaults();
    a.tracker.minArea = 999;
    expect(b.tracker.minArea).not.toBe(999);
  });
});

describe('ConfigManager.validate', function () {
  it('returns valid for a complete defaults config', function () {
    var d = ConfigManager.getDefaults();
    var result = ConfigManager.validate(d);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns invalid for null', function () {
    var result = ConfigManager.validate(null);
    expect(result.valid).toBe(false);
  });

  it('returns invalid for a string', function () {
    var result = ConfigManager.validate('not a config');
    expect(result.valid).toBe(false);
  });

  it('returns invalid for an array', function () {
    var result = ConfigManager.validate([]);
    expect(result.valid).toBe(false);
  });

  it('reports missing schemaVersion', function () {
    var cfg = ConfigManager.getDefaults();
    delete cfg.schemaVersion;
    var result = ConfigManager.validate(cfg);
    expect(result.valid).toBe(false);
    expect(result.errors.some(function (e) { return e.includes('schemaVersion'); })).toBe(true);
  });

  it('reports missing sections', function () {
    var result = ConfigManager.validate({ schemaVersion: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('ConfigManager.save and load', function () {
  it('load returns defaults when nothing is stored', function () {
    var cfg = ConfigManager.load();
    expect(cfg.schemaVersion).toBe(1);
    expect(cfg.video.fallbackEnabled).toBe(true);
  });

  it('round-trips a config through save/load', function () {
    var cfg = ConfigManager.getDefaults();
    cfg.tracker.minArea = 42;
    cfg.hud.reticleStyle = 'mil-dot';
    ConfigManager.save(cfg);

    var loaded = ConfigManager.load();
    expect(loaded.tracker.minArea).toBe(42);
    expect(loaded.hud.reticleStyle).toBe('mil-dot');
  });

  it('load fills missing fields from defaults', function () {
    // Save a partial config
    store['ptz-vision-hud-config'] = JSON.stringify({ schemaVersion: 1, video: { lastDeviceId: 'cam1' } });
    var loaded = ConfigManager.load();
    expect(loaded.video.lastDeviceId).toBe('cam1');
    expect(loaded.video.fallbackEnabled).toBe(true); // filled from default
    expect(loaded.tracker.minArea).toBe(100); // filled from default
  });

  it('load returns defaults for corrupted JSON', function () {
    store['ptz-vision-hud-config'] = 'not valid json{{{';
    var loaded = ConfigManager.load();
    expect(loaded.schemaVersion).toBe(1);
  });
});

describe('ConfigManager.importFromFile', function () {
  function makeFile(content) {
    return new Blob([content], { type: 'application/json' });
  }

  it('imports a valid full config', async function () {
    var cfg = ConfigManager.getDefaults();
    cfg.tracker.minArea = 200;
    var file = makeFile(JSON.stringify(cfg));

    var result = await ConfigManager.importFromFile(file);
    expect(result.applied.tracker.minArea).toBe(200);
    expect(result.warnings).toHaveLength(0);
  });

  it('fills missing fields with defaults and reports warnings', async function () {
    var partial = { schemaVersion: 1, video: { lastDeviceId: 'cam2' } };
    var file = makeFile(JSON.stringify(partial));

    var result = await ConfigManager.importFromFile(file);
    expect(result.applied.video.lastDeviceId).toBe('cam2');
    expect(result.applied.video.fallbackEnabled).toBe(true);
    expect(result.applied.tracker.minArea).toBe(100);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('preserves valid fields from imported config', async function () {
    var partial = {
      schemaVersion: 1,
      hud: { reticleStyle: 'bracket', reticleOpacity: 50, reticleThickness: 2, gridPreset: 'none', gridOpacity: 10, gridThickness: 2, gridN: 12, scanLineEffect: false }
    };
    var file = makeFile(JSON.stringify(partial));

    var result = await ConfigManager.importFromFile(file);
    expect(result.applied.hud.reticleStyle).toBe('bracket');
    expect(result.applied.hud.reticleOpacity).toBe(50);
    expect(result.applied.hud.scanLineEffect).toBe(false);
  });

  it('rejects invalid JSON', async function () {
    var file = makeFile('not json at all');
    await expect(ConfigManager.importFromFile(file)).rejects.toThrow('Invalid JSON');
  });

  it('rejects null file', async function () {
    await expect(ConfigManager.importFromFile(null)).rejects.toThrow('No file provided');
  });

  it('persists imported config to localStorage', async function () {
    var cfg = ConfigManager.getDefaults();
    cfg.recording.bitrate = 5000000;
    var file = makeFile(JSON.stringify(cfg));

    await ConfigManager.importFromFile(file);
    var loaded = ConfigManager.load();
    expect(loaded.recording.bitrate).toBe(5000000);
  });

  it('always sets schemaVersion to current', async function () {
    var old = { schemaVersion: 0, video: { lastDeviceId: null, fallbackEnabled: true } };
    var file = makeFile(JSON.stringify(old));

    var result = await ConfigManager.importFromFile(file);
    expect(result.applied.schemaVersion).toBe(1);
  });
});
