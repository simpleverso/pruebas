// buffer-pool.js — BufferPool
// Pre-allocated ArrayBuffer pool for zero-copy frame transfer between JS and WASM.
// Provides: init, acquire, release, getStats, dispose
// Requirements: 21.4, 21.5, 21.6

/* global globalThis */
var BufferPool = (function () {
  // Pool state
  var _bufferSize = 0;
  var _poolSize = 0;
  var _available = [];  // ArrayBuffers ready for use
  var _inUse = new Set(); // ArrayBuffers currently acquired
  var _initialized = false;

  /**
   * Initialize the buffer pool with pre-allocated ArrayBuffer objects.
   * @param {number} bufferSize - Size of each ArrayBuffer in bytes
   * @param {number} poolSize - Number of buffers to pre-allocate
   */
  function init(bufferSize, poolSize) {
    if (_initialized) {
      dispose();
    }

    if (typeof bufferSize !== 'number' || bufferSize <= 0) {
      throw new Error('BufferPool: bufferSize must be a positive number');
    }
    if (typeof poolSize !== 'number' || poolSize <= 0 || !Number.isInteger(poolSize)) {
      throw new Error('BufferPool: poolSize must be a positive integer');
    }

    _bufferSize = bufferSize;
    _poolSize = poolSize;
    _available = [];
    _inUse = new Set();

    for (var i = 0; i < poolSize; i++) {
      _available.push(new ArrayBuffer(bufferSize));
    }

    _initialized = true;
  }

  /**
   * Acquire a buffer from the pool.
   * Returns a pre-allocated ArrayBuffer for reuse.
   * Enforces max 2 buffers per subsystem constraint at the pool level
   * by throwing when no buffers are available.
   * @returns {ArrayBuffer}
   */
  function acquire() {
    if (!_initialized) {
      throw new Error('BufferPool: not initialized. Call init() first.');
    }

    if (_available.length === 0) {
      throw new Error('BufferPool: no buffers available. Release a buffer before acquiring.');
    }

    var buffer = _available.pop();
    _inUse.add(buffer);
    return buffer;
  }

  /**
   * Release a buffer back to the pool for reuse.
   * @param {ArrayBuffer} buffer - The buffer to release
   */
  function release(buffer) {
    if (!_initialized) {
      throw new Error('BufferPool: not initialized. Call init() first.');
    }

    if (!_inUse.has(buffer)) {
      throw new Error('BufferPool: buffer not recognized as in-use. Cannot release.');
    }

    _inUse.delete(buffer);
    _available.push(buffer);
  }

  /**
   * Get current pool statistics.
   * @returns {{ total: number, available: number, inUse: number }}
   */
  function getStats() {
    return {
      total: _available.length + _inUse.size,
      available: _available.length,
      inUse: _inUse.size
    };
  }

  /**
   * Dispose of the pool, releasing all buffers and resetting state.
   * After dispose, init() must be called again before use.
   */
  function dispose() {
    _available = [];
    _inUse = new Set();
    _bufferSize = 0;
    _poolSize = 0;
    _initialized = false;
  }

  return {
    init: init,
    acquire: acquire,
    release: release,
    getStats: getStats,
    dispose: dispose
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.BufferPool = BufferPool;
}
