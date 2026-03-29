import { describe, it, expect, beforeEach } from 'vitest';

// Load the BufferPool IIFE — it attaches to globalThis via `var`
import './buffer-pool.js';

const pool = globalThis.BufferPool;

describe('BufferPool', () => {
  beforeEach(() => {
    pool.dispose();
  });

  describe('init', () => {
    it('pre-allocates the requested number of buffers', () => {
      pool.init(1024, 4);
      const stats = pool.getStats();
      expect(stats.total).toBe(4);
      expect(stats.available).toBe(4);
      expect(stats.inUse).toBe(0);
    });

    it('creates buffers of the requested size', () => {
      pool.init(2048, 2);
      const buf = pool.acquire();
      expect(buf.byteLength).toBe(2048);
      pool.release(buf);
    });

    it('throws on invalid bufferSize', () => {
      expect(() => pool.init(0, 4)).toThrow('bufferSize must be a positive number');
      expect(() => pool.init(-1, 4)).toThrow('bufferSize must be a positive number');
      expect(() => pool.init('abc', 4)).toThrow('bufferSize must be a positive number');
    });

    it('throws on invalid poolSize', () => {
      expect(() => pool.init(1024, 0)).toThrow('poolSize must be a positive integer');
      expect(() => pool.init(1024, -1)).toThrow('poolSize must be a positive integer');
      expect(() => pool.init(1024, 2.5)).toThrow('poolSize must be a positive integer');
    });

    it('re-initializes cleanly if called again', () => {
      pool.init(1024, 2);
      pool.acquire();
      pool.init(512, 3);
      const stats = pool.getStats();
      expect(stats.total).toBe(3);
      expect(stats.available).toBe(3);
      expect(stats.inUse).toBe(0);
    });
  });

  describe('acquire', () => {
    it('returns an ArrayBuffer from the pool', () => {
      pool.init(1024, 2);
      const buf = pool.acquire();
      expect(buf).toBeInstanceOf(ArrayBuffer);
      expect(buf.byteLength).toBe(1024);
    });

    it('decrements available count and increments inUse', () => {
      pool.init(1024, 3);
      pool.acquire();
      const stats = pool.getStats();
      expect(stats.available).toBe(2);
      expect(stats.inUse).toBe(1);
    });

    it('throws when no buffers are available', () => {
      pool.init(1024, 1);
      pool.acquire();
      expect(() => pool.acquire()).toThrow('no buffers available');
    });

    it('throws when pool is not initialized', () => {
      expect(() => pool.acquire()).toThrow('not initialized');
    });

    it('enforces max 2 buffer constraint (pool of size 2)', () => {
      pool.init(1024, 2);
      pool.acquire();
      pool.acquire();
      expect(() => pool.acquire()).toThrow('no buffers available');
    });
  });

  describe('release', () => {
    it('returns a buffer to the available pool', () => {
      pool.init(1024, 2);
      const buf = pool.acquire();
      pool.release(buf);
      const stats = pool.getStats();
      expect(stats.available).toBe(2);
      expect(stats.inUse).toBe(0);
    });

    it('allows re-acquiring a released buffer', () => {
      pool.init(1024, 1);
      const buf1 = pool.acquire();
      pool.release(buf1);
      const buf2 = pool.acquire();
      expect(buf2).toBeInstanceOf(ArrayBuffer);
    });

    it('throws when releasing a buffer not from the pool', () => {
      pool.init(1024, 2);
      const foreign = new ArrayBuffer(1024);
      expect(() => pool.release(foreign)).toThrow('not recognized as in-use');
    });

    it('throws when releasing the same buffer twice', () => {
      pool.init(1024, 2);
      const buf = pool.acquire();
      pool.release(buf);
      expect(() => pool.release(buf)).toThrow('not recognized as in-use');
    });

    it('throws when pool is not initialized', () => {
      expect(() => pool.release(new ArrayBuffer(1024))).toThrow('not initialized');
    });
  });

  describe('getStats', () => {
    it('reflects correct counts after mixed operations', () => {
      pool.init(1024, 4);
      const a = pool.acquire();
      const b = pool.acquire();
      expect(pool.getStats()).toEqual({ total: 4, available: 2, inUse: 2 });

      pool.release(a);
      expect(pool.getStats()).toEqual({ total: 4, available: 3, inUse: 1 });

      pool.release(b);
      expect(pool.getStats()).toEqual({ total: 4, available: 4, inUse: 0 });
    });

    it('total always equals available + inUse', () => {
      pool.init(512, 5);
      pool.acquire();
      pool.acquire();
      const stats = pool.getStats();
      expect(stats.total).toBe(stats.available + stats.inUse);
    });
  });

  describe('dispose', () => {
    it('resets all pool state', () => {
      pool.init(1024, 3);
      pool.acquire();
      pool.dispose();
      const stats = pool.getStats();
      expect(stats.total).toBe(0);
      expect(stats.available).toBe(0);
      expect(stats.inUse).toBe(0);
    });

    it('requires re-init after dispose', () => {
      pool.init(1024, 2);
      pool.dispose();
      expect(() => pool.acquire()).toThrow('not initialized');
    });

    it('can be called multiple times safely', () => {
      pool.init(1024, 2);
      pool.dispose();
      pool.dispose();
      expect(pool.getStats().total).toBe(0);
    });
  });
});
