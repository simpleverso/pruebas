// hud-renderer.test.js — Unit tests for HUDRenderer
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './config-manager.js';
import './hud-renderer.js';

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

// Minimal canvas mock with 2d context
function createMockCanvas(width, height) {
  var calls = [];
  var ctx = {
    globalAlpha: 1,
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    beginPath: function () { calls.push('beginPath'); },
    moveTo: function (x, y) { calls.push('moveTo:' + x + ',' + y); },
    lineTo: function (x, y) { calls.push('lineTo:' + x + ',' + y); },
    stroke: function () { calls.push('stroke'); },
    fill: function () { calls.push('fill'); },
    arc: function () { calls.push('arc'); },
    fillText: function (t, x, y) { calls.push('fillText:' + t); },
    measureText: function (t) { return { width: t.length * 6 }; },
    putImageData: function () { calls.push('putImageData'); },
    _calls: calls
  };
  return {
    width: width || 640,
    height: height || 480,
    getContext: function () { return ctx; },
    _ctx: ctx
  };
}

describe('HUDRenderer', function () {

  describe('init', function () {
    it('should initialize with a canvas element', function () {
      var canvas = createMockCanvas(640, 480);
      HUDRenderer.init(canvas);
      var state = HUDRenderer.getState();
      expect(state.reticleStyle).toBe('tactical-circle');
      expect(state.gridPreset).toBe('none');
    });
  });

  describe('setReticleStyle', function () {
    it('should accept valid reticle styles', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);

      HUDRenderer.setReticleStyle('tactical-circle');
      expect(HUDRenderer.getState().reticleStyle).toBe('tactical-circle');

      HUDRenderer.setReticleStyle('mil-dot');
      expect(HUDRenderer.getState().reticleStyle).toBe('mil-dot');

      HUDRenderer.setReticleStyle('bracket');
      expect(HUDRenderer.getState().reticleStyle).toBe('bracket');

      HUDRenderer.setReticleStyle('crosshair');
      expect(HUDRenderer.getState().reticleStyle).toBe('crosshair');
    });

    it('should reject invalid reticle styles', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleStyle('crosshair');
      HUDRenderer.setReticleStyle('invalid-style');
      expect(HUDRenderer.getState().reticleStyle).toBe('crosshair');
    });
  });

  describe('setGridPreset', function () {
    it('should accept all valid grid presets', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      var presets = ['thirds', 'center-cross', 'quadrants', 'fine-grid', 'golden-ratio', 'crosshair-only', 'none'];
      for (var i = 0; i < presets.length; i++) {
        HUDRenderer.setGridPreset(presets[i]);
        expect(HUDRenderer.getState().gridPreset).toBe(presets[i]);
      }
    });

    it('should reject invalid grid presets', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setGridPreset('thirds');
      HUDRenderer.setGridPreset('bogus');
      expect(HUDRenderer.getState().gridPreset).toBe('thirds');
    });
  });

  describe('setReticleConfig', function () {
    it('should set opacity and thickness', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleConfig({ opacity: 50, thickness: 2 });
      var state = HUDRenderer.getState();
      expect(state.reticleOpacity).toBe(50);
      expect(state.reticleThickness).toBe(2);
    });

    it('should clamp opacity to 0–100', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleConfig({ opacity: 150 });
      expect(HUDRenderer.getState().reticleOpacity).toBe(100);
      HUDRenderer.setReticleConfig({ opacity: -10 });
      expect(HUDRenderer.getState().reticleOpacity).toBe(0);
    });

    it('should clamp thickness to 1–3', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleConfig({ thickness: 5 });
      expect(HUDRenderer.getState().reticleThickness).toBe(3);
      HUDRenderer.setReticleConfig({ thickness: 0 });
      expect(HUDRenderer.getState().reticleThickness).toBe(1);
    });
  });

  describe('setGridConfig', function () {
    it('should set opacity, thickness, and gridN', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setGridConfig({ opacity: 60, thickness: 2, gridN: 10 });
      var state = HUDRenderer.getState();
      expect(state.gridOpacity).toBe(60);
      expect(state.gridThickness).toBe(2);
      expect(state.gridN).toBe(10);
    });

    it('should clamp gridN to 4–16', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setGridConfig({ gridN: 2 });
      expect(HUDRenderer.getState().gridN).toBe(4);
      HUDRenderer.setGridConfig({ gridN: 20 });
      expect(HUDRenderer.getState().gridN).toBe(16);
    });
  });

  describe('_statusToColor', function () {
    it('should map nominal to green', function () {
      expect(HUDRenderer._statusToColor('nominal')).toBe('#00FF00');
    });
    it('should map warning to amber', function () {
      expect(HUDRenderer._statusToColor('warning')).toBe('#FFAA00');
    });
    it('should map error to red', function () {
      expect(HUDRenderer._statusToColor('error')).toBe('#FF3333');
    });
    it('should default to green for unknown status', function () {
      expect(HUDRenderer._statusToColor('unknown')).toBe('#00FF00');
    });
  });

  describe('_gridPresetLineCount', function () {
    it('should return 4 for thirds', function () {
      expect(HUDRenderer._gridPresetLineCount('thirds')).toBe(4);
    });
    it('should return 2 for center-cross', function () {
      expect(HUDRenderer._gridPresetLineCount('center-cross')).toBe(2);
    });
    it('should return 2 for quadrants', function () {
      expect(HUDRenderer._gridPresetLineCount('quadrants')).toBe(2);
    });
    it('should return 2*(N-1) for fine-grid', function () {
      expect(HUDRenderer._gridPresetLineCount('fine-grid', 4)).toBe(6);
      expect(HUDRenderer._gridPresetLineCount('fine-grid', 8)).toBe(14);
      expect(HUDRenderer._gridPresetLineCount('fine-grid', 16)).toBe(30);
    });
    it('should return 4 for golden-ratio', function () {
      expect(HUDRenderer._gridPresetLineCount('golden-ratio')).toBe(4);
    });
    it('should return 0 for crosshair-only', function () {
      expect(HUDRenderer._gridPresetLineCount('crosshair-only')).toBe(0);
    });
    it('should return 0 for none', function () {
      expect(HUDRenderer._gridPresetLineCount('none')).toBe(0);
    });
    it('should default gridN to 8 if not provided for fine-grid', function () {
      expect(HUDRenderer._gridPresetLineCount('fine-grid')).toBe(14);
    });
  });

  describe('renderFrame', function () {
    it('should not throw when called with valid data', function () {
      var canvas = createMockCanvas(640, 480);
      HUDRenderer.init(canvas);
      var frame = { data: new Uint8ClampedArray(640 * 480 * 4), width: 640, height: 480 };
      var overlays = {
        blobs: [{ id: 1, centroid: { x: 100, y: 100 }, boundingBox: { x: 80, y: 80, w: 40, h: 40 }, area: 1600 }],
        detections: [{ class: 'person', score: 0.85, bbox: { x: 200, y: 200, w: 60, h: 120 } }],
        telemetry: { fps: 30, processingLatencyMs: 5, panAngle: 45, tiltAngle: 10, zoomLevel: 2, trackingStatus: 'tracking', memoryUsageMB: 200, activeRuleCount: 3 },
        status: { serialStatus: 'connected', webcamStatus: 'connected', gamepadStatus: 'connected' }
      };
      expect(function () { HUDRenderer.renderFrame(frame, overlays); }).not.toThrow();
    });

    it('should not throw with null overlays', function () {
      var canvas = createMockCanvas(640, 480);
      HUDRenderer.init(canvas);
      expect(function () { HUDRenderer.renderFrame(null, null); }).not.toThrow();
    });

    it('should not throw with empty overlays', function () {
      var canvas = createMockCanvas(640, 480);
      HUDRenderer.init(canvas);
      expect(function () { HUDRenderer.renderFrame(null, {}); }).not.toThrow();
    });
  });

  describe('start / stop', function () {
    it('should toggle running state', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.start();
      expect(HUDRenderer.getState().running).toBe(true);
      HUDRenderer.stop();
      expect(HUDRenderer.getState().running).toBe(false);
    });
  });

  describe('config persistence', function () {
    it('should persist reticle style via ConfigManager', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleStyle('mil-dot');
      var config = ConfigManager.load();
      expect(config.hud.reticleStyle).toBe('mil-dot');
    });

    it('should persist grid preset via ConfigManager', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setGridPreset('golden-ratio');
      var config = ConfigManager.load();
      expect(config.hud.gridPreset).toBe('golden-ratio');
    });

    it('should persist opacity and thickness', function () {
      var canvas = createMockCanvas();
      HUDRenderer.init(canvas);
      HUDRenderer.setReticleConfig({ opacity: 60, thickness: 3 });
      HUDRenderer.setGridConfig({ opacity: 45, thickness: 2, gridN: 12 });
      var config = ConfigManager.load();
      expect(config.hud.reticleOpacity).toBe(60);
      expect(config.hud.reticleThickness).toBe(3);
      expect(config.hud.gridOpacity).toBe(45);
      expect(config.hud.gridThickness).toBe(2);
      expect(config.hud.gridN).toBe(12);
    });
  });
});
