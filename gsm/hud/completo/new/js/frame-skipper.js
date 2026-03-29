// frame-skipper.js — FrameSkipper
// Controls which frames are processed vs displayed raw.
// Provides: setEnabled, setInterval, shouldProcess, getEffectiveRate, getSkipRatio
// Requirements: 4.1, 4.2, 4.5, 4.6

/* global globalThis, ConfigManager */
var FrameSkipper = (function () {
  // ---- Internal state ----
  var _enabled = false;
  var _interval = 3; // default skip interval N (2–10)
  var _baseFps = 30; // assumed base capture rate

  // ---- Helpers ----

  /**
   * Clamp interval to valid range [2, 10].
   * @param {number} n
   * @returns {number}
   */
  function _clampInterval(n) {
    if (typeof n !== 'number' || isNaN(n)) return 3;
    n = Math.round(n);
    if (n < 2) return 2;
    if (n > 10) return 10;
    return n;
  }

  /**
   * Persist enabled state and interval via ConfigManager.
   */
  function _persist() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.frameSkip.enabled = _enabled;
        cfg.frameSkip.interval = _interval;
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Load persisted state from ConfigManager.
   */
  function _loadFromConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg && cfg.frameSkip) {
          _enabled = !!cfg.frameSkip.enabled;
          _interval = _clampInterval(cfg.frameSkip.interval);
        }
      } catch (_) { /* ignore */ }
    }
  }

  // Load persisted state on module init
  _loadFromConfig();

  // ---- Public API ----

  /**
   * Enable or disable frame skipping.
   * When disabled, every frame is processed.
   * Change applies immediately on the next frame (Req 4.5).
   * Persisted via ConfigManager (Req 4.6).
   * @param {boolean} enabled
   */
  function setEnabled(enabled) {
    _enabled = !!enabled;
    _persist();
  }

  /**
   * Set the skip interval N (range 2–10).
   * When enabled, only every Nth frame is processed.
   * Change applies immediately on the next frame (Req 4.5).
   * Persisted via ConfigManager (Req 4.6).
   * @param {number} n
   */
  function setInterval(n) {
    _interval = _clampInterval(n);
    _persist();
  }

  /**
   * Determine whether a given frame should be processed.
   * When disabled, always returns true (every frame processed).
   * When enabled with interval N, returns true when frameIndex % N === 0.
   * @param {number} frameIndex
   * @returns {boolean}
   */
  function shouldProcess(frameIndex) {
    if (!_enabled) return true;
    return frameIndex % _interval === 0;
  }

  /**
   * Get the effective processing rate in FPS.
   * When disabled, returns the base FPS (all frames processed).
   * When enabled, returns baseFps / interval.
   * @returns {number}
   */
  function getEffectiveRate() {
    if (!_enabled) return _baseFps;
    return _baseFps / _interval;
  }

  /**
   * Get the skip ratio as a human-readable string, e.g. "1/5".
   * When disabled, returns "1/1" (every frame processed).
   * @returns {string}
   */
  function getSkipRatio() {
    if (!_enabled) return '1/1';
    return '1/' + _interval;
  }

  return {
    setEnabled: setEnabled,
    setInterval: setInterval,
    shouldProcess: shouldProcess,
    getEffectiveRate: getEffectiveRate,
    getSkipRatio: getSkipRatio
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.FrameSkipper = FrameSkipper;
}
