import { describe, it, expect, beforeEach } from 'vitest';

import './buffer-pool.js';
import './frame-processor.js';

const FP = globalThis.FrameProcessor;
const pool = globalThis.BufferPool;

// Helper: create an RGBA buffer with a solid color
function makeRGBA(width, height, r, g, b, a) {
  var buf = new ArrayBuffer(width * height * 4);
  var view = new Uint8Array(buf);
  for (var i = 0; i < width * height; i++) {
    view[i * 4] = r;
    view[i * 4 + 1] = g;
    view[i * 4 + 2] = b;
    view[i * 4 + 3] = a;
  }
  return buf;
}

// Helper: create a grayscale buffer with a single value
function makeGray(width, height, value) {
  var buf = new ArrayBuffer(width * height);
  var view = new Uint8Array(buf);
  view.fill(value);
  return buf;
}

describe('FrameProcessor', () => {
  beforeEach(() => {
    FP.init(null);
    pool.dispose();
  });

  describe('init', () => {
    it('initializes with null wasmModule for JS-only mode', () => {
      FP.init(null);
      // Should not throw
    });
  });

  describe('start / stop', () => {
    it('processFrame is a no-op when not started', () => {
      FP.init(null);
      FP.setPipeline([{ type: 'grayscale', params: {} }]);
      var input = makeRGBA(4, 4, 100, 200, 50, 255);
      var output = new ArrayBuffer(16);
      FP.processFrame(input, output, 4, 4);
      // Output should remain zeroed since not started
      var view = new Uint8Array(output);
      expect(view.every(v => v === 0)).toBe(true);
    });

    it('processFrame works after start', () => {
      FP.init(null);
      FP.setPipeline([{ type: 'grayscale', params: {} }]);
      FP.start();
      var input = makeRGBA(4, 4, 100, 200, 50, 255);
      var output = new ArrayBuffer(16);
      FP.processFrame(input, output, 4, 4);
      var view = new Uint8Array(output);
      expect(view.some(v => v > 0)).toBe(true);
    });

    it('processFrame is a no-op after stop', () => {
      FP.init(null);
      FP.setPipeline([{ type: 'grayscale', params: {} }]);
      FP.start();
      FP.stop();
      var input = makeRGBA(4, 4, 100, 200, 50, 255);
      var output = new ArrayBuffer(16);
      FP.processFrame(input, output, 4, 4);
      var view = new Uint8Array(output);
      expect(view.every(v => v === 0)).toBe(true);
    });
  });

  describe('JS fallback: grayscale', () => {
    it('converts RGBA to luminance using (77*R + 150*G + 29*B) >> 8', () => {
      var input = makeRGBA(2, 2, 100, 200, 50, 255);
      var output = new ArrayBuffer(4);
      FP._jsFallback.grayscale(input, output, 2, 2);
      var view = new Uint8Array(output);
      var expected = (77 * 100 + 150 * 200 + 29 * 50) >> 8;
      for (var i = 0; i < 4; i++) {
        expect(view[i]).toBe(expected);
      }
    });

    it('handles pure white (255,255,255)', () => {
      var input = makeRGBA(1, 1, 255, 255, 255, 255);
      var output = new ArrayBuffer(1);
      FP._jsFallback.grayscale(input, output, 1, 1);
      var view = new Uint8Array(output);
      var expected = (77 * 255 + 150 * 255 + 29 * 255) >> 8;
      expect(view[0]).toBe(expected);
    });

    it('handles pure black (0,0,0)', () => {
      var input = makeRGBA(1, 1, 0, 0, 0, 255);
      var output = new ArrayBuffer(1);
      FP._jsFallback.grayscale(input, output, 1, 1);
      expect(new Uint8Array(output)[0]).toBe(0);
    });
  });

  describe('JS fallback: binarize', () => {
    it('thresholds pixels: >= threshold → 255, else → 0', () => {
      var input = new ArrayBuffer(4);
      new Uint8Array(input).set([50, 128, 200, 127]);
      var output = new ArrayBuffer(4);
      FP._jsFallback.binarize(input, output, 2, 2, 128);
      var view = new Uint8Array(output);
      expect(Array.from(view)).toEqual([0, 255, 255, 0]);
    });
  });

  describe('JS fallback: sobel', () => {
    it('sets border pixels to 0', () => {
      var input = makeGray(4, 4, 128);
      var output = new ArrayBuffer(16);
      FP._jsFallback.sobel(input, output, 4, 4);
      var view = new Uint8Array(output);
      // Top row
      expect(view[0]).toBe(0);
      expect(view[1]).toBe(0);
      expect(view[2]).toBe(0);
      expect(view[3]).toBe(0);
      // Bottom row
      expect(view[12]).toBe(0);
      expect(view[15]).toBe(0);
    });

    it('produces 0 for uniform image (no edges)', () => {
      var input = makeGray(5, 5, 100);
      var output = new ArrayBuffer(25);
      FP._jsFallback.sobel(input, output, 5, 5);
      var view = new Uint8Array(output);
      for (var i = 0; i < 25; i++) {
        expect(view[i]).toBe(0);
      }
    });

    it('detects edges at intensity transitions', () => {
      // Create a 5x5 image with left half dark, right half bright
      var input = new ArrayBuffer(25);
      var inView = new Uint8Array(input);
      for (var y = 0; y < 5; y++) {
        for (var x = 0; x < 5; x++) {
          inView[y * 5 + x] = x < 2 ? 0 : 255;
        }
      }
      var output = new ArrayBuffer(25);
      FP._jsFallback.sobel(input, output, 5, 5);
      var view = new Uint8Array(output);
      // Interior pixels near the edge should have non-zero gradient
      expect(view[1 * 5 + 2]).toBeGreaterThan(0);
    });
  });

  describe('JS fallback: canny', () => {
    it('produces binary output (only 0 and 255)', () => {
      // Create a simple edge image
      var input = new ArrayBuffer(25);
      var inView = new Uint8Array(input);
      for (var y = 0; y < 5; y++) {
        for (var x = 0; x < 5; x++) {
          inView[y * 5 + x] = x < 2 ? 0 : 255;
        }
      }
      var output = new ArrayBuffer(25);
      FP._jsFallback.canny(input, output, 5, 5, 30, 100);
      var view = new Uint8Array(output);
      for (var i = 0; i < 25; i++) {
        expect(view[i] === 0 || view[i] === 255).toBe(true);
      }
    });

    it('produces all zeros for uniform image', () => {
      var input = makeGray(5, 5, 128);
      var output = new ArrayBuffer(25);
      FP._jsFallback.canny(input, output, 5, 5, 50, 150);
      var view = new Uint8Array(output);
      for (var i = 0; i < 25; i++) {
        expect(view[i]).toBe(0);
      }
    });
  });

  describe('pipeline chaining', () => {
    it('chains grayscale → binarize correctly', () => {
      pool.init(640 * 480, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'binarize', params: { threshold: 128 } }
      ]);
      FP.start();

      var w = 4, h = 4;
      var input = makeRGBA(w, h, 200, 200, 200, 255);
      var output = new ArrayBuffer(w * h);
      FP.processFrame(input, output, w, h);

      // Grayscale of (200,200,200) = (77*200+150*200+29*200)>>8 = 200
      // Binarize with threshold 128: 200 >= 128 → 255
      var view = new Uint8Array(output);
      for (var i = 0; i < w * h; i++) {
        expect(view[i]).toBe(255);
      }
    });

    it('chains grayscale → sobel correctly', () => {
      pool.init(640 * 480, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'sobel', params: {} }
      ]);
      FP.start();

      // Uniform color → uniform grayscale → sobel produces all zeros
      var w = 5, h = 5;
      var input = makeRGBA(w, h, 100, 100, 100, 255);
      var output = new ArrayBuffer(w * h);
      FP.processFrame(input, output, w, h);

      var view = new Uint8Array(output);
      for (var i = 0; i < w * h; i++) {
        expect(view[i]).toBe(0);
      }
    });

    it('chains three operations: grayscale → binarize → sobel', () => {
      pool.init(640 * 480, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'binarize', params: { threshold: 128 } },
        { type: 'sobel', params: {} }
      ]);
      FP.start();

      var w = 5, h = 5;
      var input = makeRGBA(w, h, 200, 200, 200, 255);
      var output = new ArrayBuffer(w * h);
      FP.processFrame(input, output, w, h);

      // Uniform → grayscale uniform → binarize all 255 → sobel all 0
      var view = new Uint8Array(output);
      for (var i = 0; i < w * h; i++) {
        expect(view[i]).toBe(0);
      }
    });

    it('produces same result as manual sequential application', () => {
      var w = 4, h = 4;
      var input = makeRGBA(w, h, 100, 200, 50, 255);

      // Manual: grayscale then binarize
      var grayBuf = new ArrayBuffer(w * h);
      FP._jsFallback.grayscale(input, grayBuf, w, h);
      var binBuf = new ArrayBuffer(w * h);
      FP._jsFallback.binarize(grayBuf, binBuf, w, h, 128);

      // Pipeline
      pool.init(w * h, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'binarize', params: { threshold: 128 } }
      ]);
      FP.start();
      var output = new ArrayBuffer(w * h);
      FP.processFrame(input, output, w, h);

      expect(Array.from(new Uint8Array(output))).toEqual(Array.from(new Uint8Array(binBuf)));
    });
  });

  describe('parameter hot-reload', () => {
    it('updateParameter changes binarize threshold for next frame', () => {
      pool.init(640 * 480, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'binarize', params: { threshold: 128 } }
      ]);
      FP.start();

      var w = 2, h = 2;
      // R=100, G=100, B=100 → grayscale ≈ 99
      var input = makeRGBA(w, h, 100, 100, 100, 255);

      // With threshold 128: 99 < 128 → 0
      var output1 = new ArrayBuffer(w * h);
      FP.processFrame(input, output1, w, h);
      expect(new Uint8Array(output1)[0]).toBe(0);

      // Hot-reload threshold to 50: 99 >= 50 → 255
      FP.updateParameter('binarize', 'threshold', 50);
      var output2 = new ArrayBuffer(w * h);
      FP.processFrame(input, output2, w, h);
      expect(new Uint8Array(output2)[0]).toBe(255);
    });

    it('updateParameter changes canny thresholds', () => {
      FP.init(null);
      FP.setPipeline([
        { type: 'canny', params: { lowThreshold: 50, highThreshold: 150 } }
      ]);
      FP.start();

      // Verify parameter was updated (no crash)
      FP.updateParameter('canny', 'lowThreshold', 10);
      FP.updateParameter('canny', 'highThreshold', 200);

      var w = 5, h = 5;
      var input = makeGray(w, h, 128);
      var output = new ArrayBuffer(w * h);
      FP.processFrame(input, output, w, h);
      // Uniform image → no edges regardless of thresholds
      var view = new Uint8Array(output);
      for (var i = 0; i < w * h; i++) {
        expect(view[i]).toBe(0);
      }
    });
  });

  describe('empty pipeline', () => {
    it('processFrame does nothing with empty pipeline', () => {
      FP.init(null);
      FP.setPipeline([]);
      FP.start();
      var input = makeRGBA(2, 2, 100, 200, 50, 255);
      var output = new ArrayBuffer(4);
      FP.processFrame(input, output, 2, 2);
      var view = new Uint8Array(output);
      expect(view.every(v => v === 0)).toBe(true);
    });
  });

  describe('BufferPool integration', () => {
    it('acquires and releases intermediate buffers during chaining', () => {
      pool.init(640 * 480, 4);
      FP.init(null);
      FP.setPipeline([
        { type: 'grayscale', params: {} },
        { type: 'binarize', params: { threshold: 128 } },
        { type: 'sobel', params: {} }
      ]);
      FP.start();

      var w = 5, h = 5;
      var input = makeRGBA(w, h, 200, 200, 200, 255);
      var output = new ArrayBuffer(w * h);

      var statsBefore = pool.getStats();
      FP.processFrame(input, output, w, h);
      var statsAfter = pool.getStats();

      // All intermediate buffers should be released back
      expect(statsAfter.inUse).toBe(statsBefore.inUse);
    });
  });
});
