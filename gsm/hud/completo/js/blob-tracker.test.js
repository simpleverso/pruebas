import { describe, it, expect, beforeEach } from 'vitest';

// Load the BlobTracker IIFE — it attaches to globalThis via `var`
import './blob-tracker.js';

const tracker = globalThis.BlobTracker;

/**
 * Helper: create a binary frame buffer (0 = background, 255 = foreground).
 * @param {number} width
 * @param {number} height
 * @param {Array<{x:number,y:number}>} foregroundPixels - list of (x,y) to set to 255
 * @returns {ArrayBuffer}
 */
function makeFrame(width, height, foregroundPixels) {
  const buf = new ArrayBuffer(width * height);
  const data = new Uint8Array(buf);
  for (const { x, y } of foregroundPixels) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      data[y * width + x] = 255;
    }
  }
  return buf;
}

/**
 * Helper: create a rectangular block of foreground pixels.
 */
function makeRect(x0, y0, w, h) {
  const pixels = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      pixels.push({ x, y });
    }
  }
  return pixels;
}

describe('BlobTracker', () => {
  beforeEach(() => {
    tracker.init({ minArea: 1, lostFrameThreshold: 10 });
  });

  describe('init', () => {
    it('resets internal state', () => {
      const frame = makeFrame(10, 10, makeRect(0, 0, 3, 3));
      tracker.detectBlobs(frame, 10, 10);
      tracker.init({ minArea: 1 });
      expect(tracker.getPrimaryTarget()).toBeNull();
      expect(tracker.getDisplacement()).toBeNull();
    });

    it('accepts custom config values', () => {
      tracker.init({ minArea: 100 });
      // A 3x3 blob (area=9) should be filtered out with minArea=100
      const frame = makeFrame(20, 20, makeRect(0, 0, 3, 3));
      const blobs = tracker.detectBlobs(frame, 20, 20);
      expect(blobs.length).toBe(0);
    });
  });

  describe('detectBlobs', () => {
    it('detects a single connected component', () => {
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs.length).toBe(1);
      expect(blobs[0].area).toBe(9);
    });

    it('detects multiple disconnected components', () => {
      const pixels = [...makeRect(0, 0, 2, 2), ...makeRect(6, 6, 2, 2)];
      const frame = makeFrame(10, 10, pixels);
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs.length).toBe(2);
    });

    it('filters blobs below minimum area threshold', () => {
      tracker.init({ minArea: 5 });
      // 2x2 = 4 pixels, below threshold of 5
      const frame = makeFrame(10, 10, makeRect(0, 0, 2, 2));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs.length).toBe(0);
    });

    it('computes correct centroid as mean of pixel coordinates', () => {
      // 3x3 block at (1,1) to (3,3) — centroid should be (2, 2)
      const frame = makeFrame(10, 10, makeRect(1, 1, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs[0].centroid.x).toBe(2);
      expect(blobs[0].centroid.y).toBe(2);
    });

    it('computes correct bounding box', () => {
      const frame = makeFrame(10, 10, makeRect(2, 3, 4, 2));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs[0].boundingBox).toEqual({ x: 2, y: 3, w: 4, h: 2 });
    });

    it('computes correct area as pixel count', () => {
      const frame = makeFrame(10, 10, makeRect(0, 0, 5, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs[0].area).toBe(15);
    });

    it('returns empty array for all-black frame', () => {
      const frame = makeFrame(10, 10, []);
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs.length).toBe(0);
    });

    it('treats L-shaped region as single connected component', () => {
      // L-shape: vertical bar + horizontal bar connected at corner
      const pixels = [
        ...makeRect(0, 0, 1, 4), // vertical bar
        ...makeRect(1, 3, 3, 1)  // horizontal bar at bottom
      ];
      const frame = makeFrame(10, 10, pixels);
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs.length).toBe(1);
      expect(blobs[0].area).toBe(7);
    });

    it('assigns unique IDs to each blob', () => {
      tracker.init({ minArea: 1 });
      const pixels = [...makeRect(0, 0, 2, 2), ...makeRect(5, 5, 2, 2)];
      const frame = makeFrame(10, 10, pixels);
      const blobs = tracker.detectBlobs(frame, 10, 10);
      expect(blobs[0].id).not.toBe(blobs[1].id);
    });
  });

  describe('associateBlobs', () => {
    it('creates new tracked blobs when no previous blobs exist', () => {
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      const tracked = tracker.associateBlobs(blobs, []);
      expect(tracked.length).toBe(1);
      expect(tracked[0].framesLost).toBe(0);
      expect(tracked[0].velocity).toEqual({ vx: 0, vy: 0 });
    });

    it('matches blobs by proximity across frames', () => {
      // Frame 1: blob at (2,2)
      const frame1 = makeFrame(20, 20, makeRect(1, 1, 3, 3));
      const blobs1 = tracker.detectBlobs(frame1, 20, 20);
      const tracked1 = tracker.associateBlobs(blobs1, []);

      // Frame 2: blob moved slightly to (4,4)
      const frame2 = makeFrame(20, 20, makeRect(3, 3, 3, 3));
      const blobs2 = tracker.detectBlobs(frame2, 20, 20);
      const tracked2 = tracker.associateBlobs(blobs2, tracked1);

      expect(tracked2.length).toBe(1);
      expect(tracked2[0].id).toBe(tracked1[0].id); // same ID preserved
    });

    it('computes velocity from centroid movement', () => {
      const frame1 = makeFrame(20, 20, makeRect(1, 1, 3, 3));
      const blobs1 = tracker.detectBlobs(frame1, 20, 20);
      const tracked1 = tracker.associateBlobs(blobs1, []);

      const frame2 = makeFrame(20, 20, makeRect(4, 6, 3, 3));
      const blobs2 = tracker.detectBlobs(frame2, 20, 20);
      const tracked2 = tracker.associateBlobs(blobs2, tracked1);

      // Centroid moved from (2,2) to (5,7) → velocity (3, 5)
      expect(tracked2[0].velocity.vx).toBe(3);
      expect(tracked2[0].velocity.vy).toBe(5);
    });

    it('does not match one blob to two targets', () => {
      // Two previous blobs, one current blob — only one match
      const frame1 = makeFrame(20, 20, [...makeRect(0, 0, 3, 3), ...makeRect(10, 10, 3, 3)]);
      const blobs1 = tracker.detectBlobs(frame1, 20, 20);
      const tracked1 = tracker.associateBlobs(blobs1, []);

      // Only one blob in frame 2, near first blob
      const frame2 = makeFrame(20, 20, makeRect(1, 1, 3, 3));
      const blobs2 = tracker.detectBlobs(frame2, 20, 20);
      const tracked2 = tracker.associateBlobs(blobs2, tracked1);

      // One matched + one unmatched previous (framesLost incremented)
      const matched = tracked2.filter(t => t.framesLost === 0);
      const lost = tracked2.filter(t => t.framesLost > 0);
      expect(matched.length).toBe(1);
      expect(lost.length).toBe(1);
    });

    it('increments framesLost for unmatched previous blobs', () => {
      const frame1 = makeFrame(20, 20, makeRect(5, 5, 3, 3));
      const blobs1 = tracker.detectBlobs(frame1, 20, 20);
      const tracked1 = tracker.associateBlobs(blobs1, []);

      // Empty frame — blob disappears
      const frame2 = makeFrame(20, 20, []);
      const blobs2 = tracker.detectBlobs(frame2, 20, 20);
      const tracked2 = tracker.associateBlobs(blobs2, tracked1);

      expect(tracked2.length).toBe(1);
      expect(tracked2[0].framesLost).toBe(1);
    });

    it('removes blobs when framesLost exceeds threshold', () => {
      tracker.init({ minArea: 1, lostFrameThreshold: 2 });

      const frame1 = makeFrame(10, 10, makeRect(0, 0, 3, 3));
      const blobs1 = tracker.detectBlobs(frame1, 10, 10);
      var tracked = tracker.associateBlobs(blobs1, []);

      // Simulate 3 empty frames — blob should be removed after threshold
      for (let i = 0; i < 3; i++) {
        const emptyFrame = makeFrame(10, 10, []);
        const emptyBlobs = tracker.detectBlobs(emptyFrame, 10, 10);
        tracked = tracker.associateBlobs(emptyBlobs, tracked);
      }

      expect(tracked.length).toBe(0);
    });
  });

  describe('setPrimaryTarget / getPrimaryTarget', () => {
    it('returns null when no primary target is set', () => {
      expect(tracker.getPrimaryTarget()).toBeNull();
    });

    it('returns the tracked blob matching the set ID', () => {
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      const tracked = tracker.associateBlobs(blobs, []);

      tracker.setPrimaryTarget(tracked[0].id);
      const target = tracker.getPrimaryTarget();
      expect(target).not.toBeNull();
      expect(target.id).toBe(tracked[0].id);
    });

    it('returns null if primary target ID does not match any tracked blob', () => {
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      tracker.detectBlobs(frame, 10, 10);
      tracker.associateBlobs([], []);

      tracker.setPrimaryTarget(9999);
      expect(tracker.getPrimaryTarget()).toBeNull();
    });
  });

  describe('getDisplacement', () => {
    it('returns null when no primary target is set', () => {
      expect(tracker.getDisplacement()).toBeNull();
    });

    it('computes displacement from frame center', () => {
      // 10x10 frame, center = (5, 5)
      // Blob at (2,2) with 3x3 → centroid (3, 3)
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      const tracked = tracker.associateBlobs(blobs, []);

      tracker.setPrimaryTarget(tracked[0].id);
      const disp = tracker.getDisplacement();
      expect(disp).not.toBeNull();
      // centroid (3,3) - center (5,5) = (-2, -2)
      expect(disp.dx).toBe(-2);
      expect(disp.dy).toBe(-2);
    });

    it('returns (0,0) when target is at frame center', () => {
      // 10x10 frame, center = (5, 5)
      // Blob at (4,4) with 3x3 → centroid (5, 5)
      const frame = makeFrame(10, 10, makeRect(4, 4, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      const tracked = tracker.associateBlobs(blobs, []);

      tracker.setPrimaryTarget(tracked[0].id);
      const disp = tracker.getDisplacement();
      expect(disp.dx).toBe(0);
      expect(disp.dy).toBe(0);
    });
  });

  describe('start / stop', () => {
    it('stop clears tracked blobs and primary target', () => {
      const frame = makeFrame(10, 10, makeRect(2, 2, 3, 3));
      const blobs = tracker.detectBlobs(frame, 10, 10);
      const tracked = tracker.associateBlobs(blobs, []);
      tracker.setPrimaryTarget(tracked[0].id);

      tracker.stop();
      expect(tracker.getPrimaryTarget()).toBeNull();
    });

    it('start and stop can be called without errors', () => {
      expect(() => tracker.start()).not.toThrow();
      expect(() => tracker.stop()).not.toThrow();
    });
  });
});
