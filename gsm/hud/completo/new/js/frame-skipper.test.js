// frame-skipper.test.js — Unit tests for FrameSkipper
import { describe, it, expect, beforeEach } from 'vitest';

// Stub ConfigManager before loading FrameSkipper
let storedConfig = null;
globalThis.ConfigManager = {
  load() {
    if (storedConfig) return JSON.parse(JSON.stringify(storedConfig));
    return {
      schemaVersion: 1,
      frameSkip: { enabled: false, interval: 3 }
    };
  },
  save(cfg) {
    storedConfig = JSON.parse(JSON.stringify(cfg));
  }
};

// Re-import FrameSkipper fresh for each test suite
// Since it's an IIFE that reads config on load, we need to reset state
await import('./frame-skipper.js');
const FrameSkipper = globalThis.FrameSkipper;

describe('FrameSkipper', () => {
  beforeEach(() => {
    storedConfig = null;
    // Reset to defaults
    FrameSkipper.setEnabled(false);
    FrameSkipper.setInterval(3);
  });

  describe('setEnabled / shouldProcess', () => {
    it('when disabled, shouldProcess returns true for every frame', () => {
      FrameSkipper.setEnabled(false);
      for (let i = 0; i < 20; i++) {
        expect(FrameSkipper.shouldProcess(i)).toBe(true);
      }
    });

    it('when enabled with interval 3, processes every 3rd frame', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(3);

      const results = [];
      for (let i = 0; i < 12; i++) {
        results.push(FrameSkipper.shouldProcess(i));
      }
      // frames 0, 3, 6, 9 should be true
      expect(results).toEqual([
        true, false, false,
        true, false, false,
        true, false, false,
        true, false, false
      ]);
    });

    it('when enabled with interval 5, processes every 5th frame', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(5);

      const processed = [];
      for (let i = 0; i < 10; i++) {
        if (FrameSkipper.shouldProcess(i)) processed.push(i);
      }
      expect(processed).toEqual([0, 5]);
    });
  });

  describe('setInterval clamping', () => {
    it('clamps interval below 2 to 2', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(1);
      // With interval 2, frames 0, 2, 4 should process
      expect(FrameSkipper.shouldProcess(0)).toBe(true);
      expect(FrameSkipper.shouldProcess(1)).toBe(false);
      expect(FrameSkipper.shouldProcess(2)).toBe(true);
    });

    it('clamps interval above 10 to 10', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(15);
      // With interval 10, frame 10 should process
      expect(FrameSkipper.shouldProcess(0)).toBe(true);
      expect(FrameSkipper.shouldProcess(5)).toBe(false);
      expect(FrameSkipper.shouldProcess(10)).toBe(true);
    });

    it('rounds non-integer intervals', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(4.7);
      // Should round to 5
      expect(FrameSkipper.shouldProcess(0)).toBe(true);
      expect(FrameSkipper.shouldProcess(4)).toBe(false);
      expect(FrameSkipper.shouldProcess(5)).toBe(true);
    });

    it('handles NaN by defaulting to 3', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(NaN);
      expect(FrameSkipper.shouldProcess(0)).toBe(true);
      expect(FrameSkipper.shouldProcess(1)).toBe(false);
      expect(FrameSkipper.shouldProcess(2)).toBe(false);
      expect(FrameSkipper.shouldProcess(3)).toBe(true);
    });
  });

  describe('getEffectiveRate', () => {
    it('returns base FPS (30) when disabled', () => {
      FrameSkipper.setEnabled(false);
      expect(FrameSkipper.getEffectiveRate()).toBe(30);
    });

    it('returns baseFps / interval when enabled', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(5);
      expect(FrameSkipper.getEffectiveRate()).toBe(6); // 30 / 5
    });

    it('returns baseFps / 2 for interval 2', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(2);
      expect(FrameSkipper.getEffectiveRate()).toBe(15); // 30 / 2
    });

    it('returns baseFps / 10 for interval 10', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(10);
      expect(FrameSkipper.getEffectiveRate()).toBe(3); // 30 / 10
    });
  });

  describe('getSkipRatio', () => {
    it('returns "1/1" when disabled', () => {
      FrameSkipper.setEnabled(false);
      expect(FrameSkipper.getSkipRatio()).toBe('1/1');
    });

    it('returns "1/N" when enabled with interval N', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(5);
      expect(FrameSkipper.getSkipRatio()).toBe('1/5');
    });

    it('returns "1/2" for interval 2', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(2);
      expect(FrameSkipper.getSkipRatio()).toBe('1/2');
    });

    it('returns "1/10" for interval 10', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(10);
      expect(FrameSkipper.getSkipRatio()).toBe('1/10');
    });
  });

  describe('immediate application (Req 4.5)', () => {
    it('toggling enabled takes effect on the very next shouldProcess call', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(4);
      expect(FrameSkipper.shouldProcess(1)).toBe(false);

      // Disable mid-stream — next call should process
      FrameSkipper.setEnabled(false);
      expect(FrameSkipper.shouldProcess(1)).toBe(true);
    });

    it('changing interval takes effect on the very next shouldProcess call', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(3);
      expect(FrameSkipper.shouldProcess(4)).toBe(false); // 4 % 3 !== 0

      FrameSkipper.setInterval(4);
      expect(FrameSkipper.shouldProcess(4)).toBe(true); // 4 % 4 === 0
    });
  });

  describe('ConfigManager persistence (Req 4.6)', () => {
    it('persists enabled state on setEnabled', () => {
      FrameSkipper.setEnabled(true);
      const saved = storedConfig;
      expect(saved.frameSkip.enabled).toBe(true);
    });

    it('persists interval on setInterval', () => {
      FrameSkipper.setInterval(7);
      const saved = storedConfig;
      expect(saved.frameSkip.interval).toBe(7);
    });

    it('persists both enabled and interval together', () => {
      FrameSkipper.setEnabled(true);
      FrameSkipper.setInterval(6);
      const saved = storedConfig;
      expect(saved.frameSkip.enabled).toBe(true);
      expect(saved.frameSkip.interval).toBe(6);
    });
  });
});
