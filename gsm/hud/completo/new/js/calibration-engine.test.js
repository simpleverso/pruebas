// calibration-engine.test.js — Unit tests for CalibrationEngine pure-function internals
import { describe, it, expect, beforeEach } from 'vitest';
import '../../dev/js/calibration-engine.js';

const CE = globalThis.CalibrationEngine;

describe('CalibrationEngine', () => {
  describe('_computeMedian', () => {
    it('returns median of odd-length array', () => {
      expect(CE._computeMedian([3, 1, 2])).toBe(2);
    });

    it('returns median of even-length array', () => {
      expect(CE._computeMedian([4, 1, 3, 2])).toBe(2.5);
    });

    it('returns 0 for empty array', () => {
      expect(CE._computeMedian([])).toBe(0);
    });

    it('returns single value for single-element array', () => {
      expect(CE._computeMedian([42])).toBe(42);
    });

    it('handles repeated values', () => {
      expect(CE._computeMedian([5, 5, 5, 5, 5])).toBe(5);
    });
  });

  describe('_computeAverage', () => {
    it('returns average of values', () => {
      expect(CE._computeAverage([10, 20, 30])).toBe(20);
    });

    it('returns 0 for empty array', () => {
      expect(CE._computeAverage([])).toBe(0);
    });

    it('returns single value for single-element array', () => {
      expect(CE._computeAverage([7])).toBe(7);
    });
  });

  describe('_computeMeanLuminance', () => {
    it('computes mean luminance from RGBA data', () => {
      // 2x1 image: pixel1 = (255,255,255,255), pixel2 = (0,0,0,255)
      const data = new Uint8Array([255, 255, 255, 255, 0, 0, 0, 255]);
      const lum = CE._computeMeanLuminance(data, 2, 1);
      // pixel1 lum = 0.299*255 + 0.587*255 + 0.114*255 = 255
      // pixel2 lum = 0
      // mean = 127.5
      expect(lum).toBeCloseTo(127.5, 1);
    });

    it('returns 0 for empty data', () => {
      expect(CE._computeMeanLuminance(new Uint8Array([]), 0, 0)).toBe(0);
    });

    it('handles uniform color', () => {
      // 1x1 red pixel: R=200, G=0, B=0
      const data = new Uint8Array([200, 0, 0, 255]);
      const lum = CE._computeMeanLuminance(data, 1, 1);
      expect(lum).toBeCloseTo(0.299 * 200, 1);
    });
  });

  describe('_isLowLight', () => {
    it('returns true when luminance is below threshold', () => {
      expect(CE._isLowLight(20, 30)).toBe(true);
    });

    it('returns false when luminance is above threshold', () => {
      expect(CE._isLowLight(50, 30)).toBe(false);
    });

    it('returns false when luminance equals threshold', () => {
      expect(CE._isLowLight(30, 30)).toBe(false);
    });
  });

  describe('_computePredictiveOffset', () => {
    it('returns velocity * latency', () => {
      expect(CE._computePredictiveOffset(10, 50)).toBe(500);
    });

    it('returns 0 for zero velocity', () => {
      expect(CE._computePredictiveOffset(0, 100)).toBe(0);
    });

    it('returns 0 for zero latency', () => {
      expect(CE._computePredictiveOffset(5, 0)).toBe(0);
    });
  });

  describe('_interpolateZoomSensitivity', () => {
    const table = [
      { zoomLevel: 1, sensitivityMultiplier: 1.0 },
      { zoomLevel: 4, sensitivityMultiplier: 2.0 },
      { zoomLevel: 8, sensitivityMultiplier: 4.0 }
    ];

    it('returns exact value at calibrated level', () => {
      expect(CE._interpolateZoomSensitivity(table, 4)).toBe(2.0);
    });

    it('interpolates between two levels', () => {
      // Between 1 and 4: t = (2.5-1)/(4-1) = 0.5, result = 1.0 + 0.5*1.0 = 1.5
      expect(CE._interpolateZoomSensitivity(table, 2.5)).toBeCloseTo(1.5, 5);
    });

    it('clamps below minimum zoom level', () => {
      expect(CE._interpolateZoomSensitivity(table, 0)).toBe(1.0);
    });

    it('clamps above maximum zoom level', () => {
      expect(CE._interpolateZoomSensitivity(table, 20)).toBe(4.0);
    });

    it('returns 1.0 for empty table', () => {
      expect(CE._interpolateZoomSensitivity([], 5)).toBe(1.0);
    });

    it('returns single entry value for single-entry table', () => {
      expect(CE._interpolateZoomSensitivity([{ zoomLevel: 3, sensitivityMultiplier: 2.5 }], 10)).toBe(2.5);
    });
  });

  describe('_computeCenteringOffset', () => {
    it('computes offset from frame center', () => {
      const result = CE._computeCenteringOffset(
        { x: 400, y: 300 },
        { x: 320, y: 240 },
        { pixelsPerUnitPan: 10, pixelsPerUnitTilt: 10 }
      );
      expect(result.dx).toBe(80);
      expect(result.dy).toBe(60);
      expect(result.panCommand).toBe(8);
      expect(result.tiltCommand).toBe(6);
    });

    it('returns zero commands when object is at center', () => {
      const result = CE._computeCenteringOffset(
        { x: 320, y: 240 },
        { x: 320, y: 240 },
        { pixelsPerUnitPan: 10, pixelsPerUnitTilt: 10 }
      );
      expect(result.dx).toBe(0);
      expect(result.dy).toBe(0);
      expect(result.panCommand).toBe(0);
      expect(result.tiltCommand).toBe(0);
    });

    it('handles zero calibration ratios gracefully', () => {
      const result = CE._computeCenteringOffset(
        { x: 400, y: 300 },
        { x: 320, y: 240 },
        { pixelsPerUnitPan: 0, pixelsPerUnitTilt: 0 }
      );
      expect(result.panCommand).toBe(0);
      expect(result.tiltCommand).toBe(0);
    });
  });

  describe('_simulateCenteringIteration', () => {
    it('converges when correction factor is high enough', () => {
      const result = CE._simulateCenteringIteration(100, 0.8, 10, 0.05);
      expect(result.converged).toBe(true);
      expect(result.iterationsUsed).toBeLessThanOrEqual(10);
    });

    it('does not converge with zero correction factor', () => {
      const result = CE._simulateCenteringIteration(100, 0, 10, 0.05);
      expect(result.converged).toBe(false);
      expect(result.iterationsUsed).toBe(10);
      expect(result.finalOffset).toBe(100);
    });

    it('converges immediately if already within tolerance', () => {
      const result = CE._simulateCenteringIteration(1, 0.5, 10, 0.05);
      // tolerance = 1 * 0.05 = 0.05, initial offset = 1 > 0.05
      // After iteration 1: 1 * 0.5 = 0.5, still > 0.05
      // Need several iterations
      expect(result.converged).toBe(true);
    });

    it('respects max iterations limit', () => {
      const result = CE._simulateCenteringIteration(1000, 0.1, 3, 0.01);
      expect(result.iterationsUsed).toBeLessThanOrEqual(3);
    });
  });

  describe('getCalibrationData / applyCalibration', () => {
    beforeEach(() => {
      CE.stop();
      CE.start();
    });

    it('returns default calibration data', () => {
      const data = CE.getCalibrationData();
      expect(data.movement).toBeNull();
      expect(data.light).toBeNull();
      expect(data.deviceResponse).toBeNull();
      expect(data.zoom).toBeNull();
      expect(data.centering.tolerance).toBe(0.05);
      expect(data.centering.maxIterations).toBe(10);
    });

    it('applies and retrieves calibration data', () => {
      CE.applyCalibration({
        movement: { pixelsPerUnitPan: 15, pixelsPerUnitTilt: 12 },
        light: { meanLuminance: 120, adjustedThreshold: 96 },
        deviceResponse: { latencyMs: 45 },
        zoom: { lookupTable: [{ zoomLevel: 1, sensitivityMultiplier: 1.0 }] },
        centering: {
          blob: { correctionX: 1.1, correctionY: 0.9 },
          tolerance: 0.03
        }
      });

      const data = CE.getCalibrationData();
      expect(data.movement.pixelsPerUnitPan).toBe(15);
      expect(data.light.meanLuminance).toBe(120);
      expect(data.deviceResponse.latencyMs).toBe(45);
      expect(data.zoom.lookupTable).toHaveLength(1);
      expect(data.centering.blob.correctionX).toBe(1.1);
      expect(data.centering.tolerance).toBe(0.03);
    });
  });

  describe('start / stop', () => {
    it('starts and stops without error', () => {
      expect(() => CE.start()).not.toThrow();
      expect(() => CE.stop()).not.toThrow();
    });

    it('clears active calibration on stop', () => {
      CE.start();
      expect(CE.getActiveCalibration()).toBeNull();
      CE.stop();
      expect(CE.getActiveCalibration()).toBeNull();
    });
  });
});
