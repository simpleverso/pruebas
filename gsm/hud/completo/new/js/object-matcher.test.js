import { describe, it, expect, beforeEach } from 'vitest';

// Load the ObjectMatcher IIFE — it attaches to globalThis
import './object-matcher.js';

const matcher = globalThis.ObjectMatcher;

/**
 * Helper: create a simple ImageData-like object with RGBA data.
 * Fills with a gradient pattern for meaningful gradient computation.
 */
function makeImageData(width, height, fillFn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (fillFn) {
        const c = fillFn(x, y);
        data[idx] = c.r;
        data[idx + 1] = c.g;
        data[idx + 2] = c.b;
        data[idx + 3] = 255;
      } else {
        // Default: horizontal gradient
        const v = Math.floor((x / width) * 255);
        data[idx] = v;
        data[idx + 1] = v;
        data[idx + 2] = v;
        data[idx + 3] = 255;
      }
    }
  }
  return { data, width, height };
}

/**
 * Helper: compute L2 magnitude of a Float32Array.
 */
function l2Magnitude(arr) {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
  return Math.sqrt(sum);
}

/**
 * Helper: cosine similarity between two arrays.
 */
function cosineSim(a, b) {
  let dot = 0, magA = 0, magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  magA = Math.sqrt(magA);
  magB = Math.sqrt(magB);
  if (magA < 1e-10 || magB < 1e-10) return 0;
  return dot / (magA * magB);
}

/**
 * Helper: make a TrackedBlob-like object.
 */
function makeBlob(id, cx, cy, area, descriptor) {
  return {
    id,
    centroid: { x: cx, y: cy },
    boundingBox: { x: cx - 5, y: cy - 5, w: 10, h: 10 },
    area: area || 100,
    pixels: new Uint8Array(0),
    velocity: { vx: 0, vy: 0 },
    framesLost: 0,
    descriptor: descriptor || new Float32Array(0),
    referenceDescriptor: descriptor || new Float32Array(0)
  };
}

describe('ObjectMatcher', () => {
  beforeEach(() => {
    matcher.configure({
      cellsX: 4,
      cellsY: 4,
      orientationBins: 9,
      spatialWeight: 0.4,
      areaWeight: 0.3,
      descriptorWeight: 0.3,
      reIdThreshold: 0.6,
      reIdWindowFrames: 30,
      motionDamping: 0.8,
      searchRegionScale: 1.5
    });
    matcher.resetLostTargets();
  });

  describe('computeDescriptor', () => {
    it('returns a Float32Array of fixed length (4*4*9 = 144)', () => {
      const img = makeImageData(32, 32);
      const desc = matcher.computeDescriptor(img, { x: 0, y: 0, w: 32, h: 32 });
      expect(desc).toBeInstanceOf(Float32Array);
      expect(desc.length).toBe(144);
    });

    it('returns L2-normalized descriptor (magnitude ≈ 1.0)', () => {
      const img = makeImageData(32, 32);
      const desc = matcher.computeDescriptor(img, { x: 0, y: 0, w: 32, h: 32 });
      const mag = l2Magnitude(desc);
      // Should be ~1.0 for non-zero descriptors
      expect(mag).toBeCloseTo(1.0, 1);
    });

    it('returns same length descriptor regardless of bounding box size', () => {
      const img = makeImageData(100, 100);
      const desc1 = matcher.computeDescriptor(img, { x: 0, y: 0, w: 20, h: 20 });
      const desc2 = matcher.computeDescriptor(img, { x: 0, y: 0, w: 80, h: 80 });
      expect(desc1.length).toBe(desc2.length);
      expect(desc1.length).toBe(144);
    });

    it('returns zero vector for null/empty input', () => {
      const desc = matcher.computeDescriptor(null, null);
      expect(desc.length).toBe(144);
      // All zeros
      for (let i = 0; i < desc.length; i++) {
        expect(desc[i]).toBe(0);
      }
    });

    it('produces similar descriptors for the same region', () => {
      const img = makeImageData(32, 32);
      const desc1 = matcher.computeDescriptor(img, { x: 0, y: 0, w: 32, h: 32 });
      const desc2 = matcher.computeDescriptor(img, { x: 0, y: 0, w: 32, h: 32 });
      expect(cosineSim(desc1, desc2)).toBeCloseTo(1.0, 5);
    });

    it('handles bounding box larger than image gracefully', () => {
      const img = makeImageData(10, 10);
      const desc = matcher.computeDescriptor(img, { x: 0, y: 0, w: 100, h: 100 });
      expect(desc).toBeInstanceOf(Float32Array);
      expect(desc.length).toBe(144);
    });

    it('handles very small bounding box (< 2px)', () => {
      const img = makeImageData(10, 10);
      const desc = matcher.computeDescriptor(img, { x: 0, y: 0, w: 1, h: 1 });
      expect(desc.length).toBe(144);
    });
  });

  describe('updateReferenceDescriptor', () => {
    it('computes EMA: alpha * current + (1 - alpha) * reference', () => {
      const current = new Float32Array([1.0, 0.0, 0.5]);
      const reference = new Float32Array([0.0, 1.0, 0.5]);
      const alpha = 0.3;
      const result = matcher.updateReferenceDescriptor(current, reference, alpha);

      expect(result[0]).toBeCloseTo(0.3 * 1.0 + 0.7 * 0.0, 5);
      expect(result[1]).toBeCloseTo(0.3 * 0.0 + 0.7 * 1.0, 5);
      expect(result[2]).toBeCloseTo(0.3 * 0.5 + 0.7 * 0.5, 5);
    });

    it('returns current when alpha = 1', () => {
      const current = new Float32Array([1.0, 2.0, 3.0]);
      const reference = new Float32Array([4.0, 5.0, 6.0]);
      const result = matcher.updateReferenceDescriptor(current, reference, 1.0);
      for (let i = 0; i < 3; i++) {
        expect(result[i]).toBeCloseTo(current[i], 5);
      }
    });

    it('returns reference when alpha = 0', () => {
      const current = new Float32Array([1.0, 2.0, 3.0]);
      const reference = new Float32Array([4.0, 5.0, 6.0]);
      const result = matcher.updateReferenceDescriptor(current, reference, 0.0);
      for (let i = 0; i < 3; i++) {
        expect(result[i]).toBeCloseTo(reference[i], 5);
      }
    });

    it('handles null inputs gracefully', () => {
      const desc = new Float32Array([1, 2, 3]);
      expect(matcher.updateReferenceDescriptor(null, desc, 0.5)).toBe(desc);
      expect(matcher.updateReferenceDescriptor(desc, null, 0.5)).toBe(desc);
    });
  });

  describe('matchCandidates', () => {
    it('returns scored matches sorted by combinedScore descending', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      const blob1 = makeBlob(1, 50, 50, 100, new Float32Array(144).fill(0.1));
      const blob2 = makeBlob(2, 200, 200, 100, new Float32Array(144).fill(0.05));
      const searchRegion = { x: 0, y: 0, w: 300, h: 300 };

      const results = matcher.matchCandidates(refDesc, [blob1, blob2], searchRegion);
      expect(results.length).toBe(2);
      expect(results[0].combinedScore).toBeGreaterThanOrEqual(results[1].combinedScore);
    });

    it('returns empty array for empty candidates', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      const results = matcher.matchCandidates(refDesc, [], { x: 0, y: 0, w: 100, h: 100 });
      expect(results).toEqual([]);
    });

    it('excludes candidates outside search region', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      const blobInside = makeBlob(1, 50, 50, 100, new Float32Array(144).fill(0.1));
      const blobOutside = makeBlob(2, 500, 500, 100, new Float32Array(144).fill(0.1));
      const searchRegion = { x: 0, y: 0, w: 100, h: 100 };

      const results = matcher.matchCandidates(refDesc, [blobInside, blobOutside], searchRegion);
      expect(results.length).toBe(1);
      expect(results[0].blobId).toBe(1);
    });

    it('each match has spatialScore, areaScore, descriptorScore, combinedScore', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      const blob = makeBlob(1, 50, 50, 100, new Float32Array(144).fill(0.1));
      const results = matcher.matchCandidates(refDesc, [blob], { x: 0, y: 0, w: 100, h: 100 });

      expect(results[0]).toHaveProperty('blobId');
      expect(results[0]).toHaveProperty('spatialScore');
      expect(results[0]).toHaveProperty('areaScore');
      expect(results[0]).toHaveProperty('descriptorScore');
      expect(results[0]).toHaveProperty('combinedScore');
    });

    it('combinedScore equals weighted sum of component scores', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      const blob = makeBlob(1, 50, 50, 100, new Float32Array(144).fill(0.1));
      const results = matcher.matchCandidates(refDesc, [blob], { x: 0, y: 0, w: 100, h: 100 });

      const m = results[0];
      const expected = 0.4 * m.spatialScore + 0.3 * m.areaScore + 0.3 * m.descriptorScore;
      expect(m.combinedScore).toBeCloseTo(expected, 5);
    });
  });

  describe('predictPosition', () => {
    it('predicts next position as (x + vx, y + vy) for framesLost=0', () => {
      const blob = {
        centroid: { x: 100, y: 200 },
        velocity: { vx: 5, vy: -3 },
        framesLost: 0
      };
      const pos = matcher.predictPosition(blob);
      expect(pos.x).toBe(105);
      expect(pos.y).toBe(197);
    });

    it('extrapolates for skipped frames: (x + vx*k, y + vy*k)', () => {
      const blob = {
        centroid: { x: 100, y: 200 },
        velocity: { vx: 5, vy: -3 },
        framesLost: 4 // k = 5
      };
      const pos = matcher.predictPosition(blob);
      expect(pos.x).toBe(125);
      expect(pos.y).toBe(185);
    });

    it('returns (0,0) for null blob', () => {
      const pos = matcher.predictPosition(null);
      expect(pos).toEqual({ x: 0, y: 0 });
    });

    it('handles zero velocity', () => {
      const blob = {
        centroid: { x: 50, y: 60 },
        velocity: { vx: 0, vy: 0 },
        framesLost: 0
      };
      const pos = matcher.predictPosition(blob);
      expect(pos.x).toBe(50);
      expect(pos.y).toBe(60);
    });
  });

  describe('configure', () => {
    it('updates config parameters', () => {
      matcher.configure({ orientationBins: 12, spatialWeight: 0.5 });
      const cfg = matcher.getConfig();
      expect(cfg.orientationBins).toBe(12);
      expect(cfg.spatialWeight).toBe(0.5);
    });

    it('ignores invalid parameter types', () => {
      matcher.configure({ orientationBins: 'invalid' });
      const cfg = matcher.getConfig();
      expect(cfg.orientationBins).toBe(9); // unchanged
    });

    it('ignores unknown parameters', () => {
      matcher.configure({ unknownParam: 42 });
      const cfg = matcher.getConfig();
      expect(cfg).not.toHaveProperty('unknownParam');
    });
  });

  describe('computeSearchRegion', () => {
    it('creates a region centered on predicted position', () => {
      const region = matcher.computeSearchRegion(
        { x: 100, y: 100 },
        { w: 40, h: 40 },
        640, 480
      );
      // scale=1.5 → 60x60 region centered at (100,100)
      expect(region.x).toBe(70);
      expect(region.y).toBe(70);
      expect(region.w).toBe(60);
      expect(region.h).toBe(60);
    });

    it('clamps to frame bounds', () => {
      const region = matcher.computeSearchRegion(
        { x: 5, y: 5 },
        { w: 40, h: 40 },
        640, 480
      );
      expect(region.x).toBe(0);
      expect(region.y).toBe(0);
    });
  });

  describe('fullFrameSearchRegion', () => {
    it('returns full frame dimensions', () => {
      const region = matcher.fullFrameSearchRegion(640, 480);
      expect(region).toEqual({ x: 0, y: 0, w: 640, h: 480 });
    });
  });

  describe('isPartiallyOccluded', () => {
    it('returns true when area is 15-50% of reference', () => {
      expect(matcher.isPartiallyOccluded(30, 100)).toBe(true);  // 30%
      expect(matcher.isPartiallyOccluded(15, 100)).toBe(true);  // 15%
      expect(matcher.isPartiallyOccluded(50, 100)).toBe(true);  // 50%
    });

    it('returns false when area is above 50% of reference', () => {
      expect(matcher.isPartiallyOccluded(60, 100)).toBe(false);
    });

    it('returns false when area is below 15% of reference', () => {
      expect(matcher.isPartiallyOccluded(10, 100)).toBe(false);
    });

    it('returns false for zero reference area', () => {
      expect(matcher.isPartiallyOccluded(50, 0)).toBe(false);
    });
  });

  describe('re-identification', () => {
    it('registers and retrieves lost targets', () => {
      const desc = new Float32Array(144).fill(0.1);
      matcher.registerLostTarget(42, desc, 100, { x: 50, y: 50 });
      const targets = matcher.getLostTargets();
      expect(targets.length).toBe(1);
      expect(targets[0].blobId).toBe(42);
    });

    it('attemptReIdentification matches blob with similar descriptor', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      matcher.registerLostTarget(42, refDesc, 100, { x: 50, y: 50 });

      const blob = makeBlob(99, 60, 60, 100, new Float32Array(144).fill(0.1));
      const result = matcher.attemptReIdentification([blob]);
      expect(result).not.toBeNull();
      expect(result.lostTarget.blobId).toBe(42);
      expect(result.matchedBlob.id).toBe(99);
      expect(result.similarity).toBeGreaterThan(0.6);
    });

    it('returns null when no blobs match above threshold', () => {
      const refDesc = new Float32Array(144).fill(0.1);
      matcher.registerLostTarget(42, refDesc, 100, { x: 50, y: 50 });

      // Very different descriptor
      const diffDesc = new Float32Array(144);
      diffDesc[0] = 1.0; // only one bin set
      const blob = makeBlob(99, 60, 60, 100, diffDesc);
      const result = matcher.attemptReIdentification([blob]);
      expect(result).toBeNull();
    });

    it('tickLostTargets increments frame counter and removes expired', () => {
      const desc = new Float32Array(144).fill(0.1);
      matcher.registerLostTarget(42, desc, 100, { x: 50, y: 50 });

      // Tick 31 times (exceeds 30-frame window)
      for (let i = 0; i <= 30; i++) {
        matcher.tickLostTargets();
      }
      expect(matcher.getLostTargets().length).toBe(0);
    });

    it('removeLostTarget removes by blob ID', () => {
      const desc = new Float32Array(144).fill(0.1);
      matcher.registerLostTarget(42, desc, 100, { x: 50, y: 50 });
      matcher.registerLostTarget(43, desc, 100, { x: 60, y: 60 });

      matcher.removeLostTarget(42);
      const targets = matcher.getLostTargets();
      expect(targets.length).toBe(1);
      expect(targets[0].blobId).toBe(43);
    });
  });
});
