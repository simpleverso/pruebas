// lifecycle-manager.js — LifecycleManager
// Per-subsystem start/stop toggles, resource cleanup, memory monitoring.
// Provides: startSubsystem, stopSubsystem, stopAll, getMemoryUsage, getSubsystemState, onBeforeUnload
// Requirements: 21.1–21.12

/* global globalThis */
var LifecycleManager = (function () {
  // Known subsystem names
  var SUBSYSTEM_NAMES = ['Pipeline', 'Tracker', 'TFjs', 'Serial', 'Calibration', 'Recording'];

  // Max frame buffers per active subsystem
  var MAX_BUFFERS_PER_SUBSYSTEM = 2;

  // Default memory warning threshold in MB
  var MEMORY_WARNING_THRESHOLD_MB = 500;

  // Internal mutable state
  var _subsystems = {};
  var _beforeUnloadBound = false;

  /**
   * Create a fresh default state for all subsystems.
   * @returns {object} subsystems state map
   */
  function _createDefaultState() {
    var state = {};
    for (var i = 0; i < SUBSYSTEM_NAMES.length; i++) {
      state[SUBSYSTEM_NAMES[i]] = {
        running: false,
        buffersHeld: 0,
        callbacks: [],    // rAF / setTimeout IDs
        resources: null    // references to streams, connections, models, etc.
      };
    }
    return state;
  }

  /**
   * Pure function: start a subsystem in the given state.
   * Returns a new state object with the named subsystem started.
   * Does not affect other subsystems.
   * @param {string} name - Subsystem name
   * @param {object} subsystemsState - Current state map
   * @returns {object} New state map
   */
  function _startSubsystem(name, subsystemsState) {
    if (SUBSYSTEM_NAMES.indexOf(name) === -1) {
      return subsystemsState; // unknown subsystem — no change
    }

    // Shallow-clone the top-level state
    var newState = {};
    for (var k in subsystemsState) {
      if (Object.prototype.hasOwnProperty.call(subsystemsState, k)) {
        newState[k] = subsystemsState[k];
      }
    }

    // Deep-clone only the target subsystem entry
    var prev = subsystemsState[name] || { running: false, buffersHeld: 0, callbacks: [], resources: null };
    newState[name] = {
      running: true,
      buffersHeld: Math.min(prev.buffersHeld || 0, MAX_BUFFERS_PER_SUBSYSTEM),
      callbacks: prev.callbacks ? prev.callbacks.slice() : [],
      resources: prev.resources
    };

    return newState;
  }

  /**
   * Pure function: stop a subsystem in the given state.
   * Returns a new state object with the named subsystem stopped,
   * its buffers released, callbacks cleared, and resources nullified.
   * Does not affect other subsystems.
   * @param {string} name - Subsystem name
   * @param {object} subsystemsState - Current state map
   * @returns {object} New state map
   */
  function _stopSubsystem(name, subsystemsState) {
    if (SUBSYSTEM_NAMES.indexOf(name) === -1) {
      return subsystemsState; // unknown subsystem — no change
    }

    // Shallow-clone the top-level state
    var newState = {};
    for (var k in subsystemsState) {
      if (Object.prototype.hasOwnProperty.call(subsystemsState, k)) {
        newState[k] = subsystemsState[k];
      }
    }

    // Stopped subsystem: release everything
    newState[name] = {
      running: false,
      buffersHeld: 0,
      callbacks: [],
      resources: null
    };

    return newState;
  }

  /**
   * Pure function: check if memory usage exceeds the warning threshold.
   * @param {number} usageMB - Current memory usage in MB
   * @param {number} thresholdMB - Warning threshold in MB
   * @returns {{ warning: boolean, level: string }}
   */
  function _checkMemoryWarning(usageMB, thresholdMB) {
    if (typeof usageMB !== 'number' || isNaN(usageMB)) {
      return { warning: false, level: 'nominal' };
    }
    if (typeof thresholdMB !== 'number' || isNaN(thresholdMB) || thresholdMB <= 0) {
      return { warning: false, level: 'nominal' };
    }
    if (usageMB > thresholdMB) {
      return { warning: true, level: 'amber' };
    }
    return { warning: false, level: 'nominal' };
  }

  // ---- Stateful public API (wraps pure functions with internal mutable state) ----

  /**
   * Initialize the lifecycle manager. Sets up default state for all subsystems.
   */
  function init() {
    _subsystems = _createDefaultState();
    _bindBeforeUnload();
  }

  /**
   * Start a named subsystem.
   * @param {string} name
   */
  function startSubsystem(name) {
    _subsystems = _startSubsystem(name, _subsystems);
  }

  /**
   * Stop a named subsystem, performing cleanup.
   * @param {string} name
   */
  function stopSubsystem(name) {
    var sub = _subsystems[name];
    if (sub && sub.running) {
      // Cancel any registered callbacks
      if (sub.callbacks && sub.callbacks.length > 0) {
        for (var i = 0; i < sub.callbacks.length; i++) {
          var cb = sub.callbacks[i];
          if (typeof cb === 'number') {
            // Could be rAF or setTimeout — cancel both to be safe
            if (typeof cancelAnimationFrame === 'function') {
              try { cancelAnimationFrame(cb); } catch (e) { /* ignore */ }
            }
            if (typeof clearTimeout === 'function') {
              try { clearTimeout(cb); } catch (e) { /* ignore */ }
            }
          }
        }
      }

      // TF.js-specific: dispose model
      if (name === 'TFjs' && sub.resources && typeof sub.resources.dispose === 'function') {
        try { sub.resources.dispose(); } catch (e) { /* ignore */ }
      }

      // Recording-specific: finalize MediaRecorder
      if (name === 'Recording' && sub.resources) {
        if (sub.resources.recorder && typeof sub.resources.recorder.stop === 'function') {
          try { sub.resources.recorder.stop(); } catch (e) { /* ignore */ }
        }
        // Release blob data
        if (sub.resources.blob) {
          sub.resources.blob = null;
        }
      }

      // Serial-specific: close port
      if (name === 'Serial' && sub.resources && typeof sub.resources.close === 'function') {
        try { sub.resources.close(); } catch (e) { /* ignore */ }
      }
    }

    _subsystems = _stopSubsystem(name, _subsystems);
  }

  /**
   * Stop all subsystems (used on page unload).
   */
  function stopAll() {
    for (var i = 0; i < SUBSYSTEM_NAMES.length; i++) {
      stopSubsystem(SUBSYSTEM_NAMES[i]);
    }
  }

  /**
   * Get the current state of a subsystem.
   * @param {string} name
   * @returns {{ running: boolean, buffersHeld: number } | null}
   */
  function getSubsystemState(name) {
    var sub = _subsystems[name];
    if (!sub) return null;
    return {
      running: sub.running,
      buffersHeld: sub.buffersHeld
    };
  }

  /**
   * Get all subsystem states.
   * @returns {object}
   */
  function getAllStates() {
    var result = {};
    for (var i = 0; i < SUBSYSTEM_NAMES.length; i++) {
      var name = SUBSYSTEM_NAMES[i];
      var sub = _subsystems[name];
      result[name] = {
        running: sub ? sub.running : false,
        buffersHeld: sub ? sub.buffersHeld : 0
      };
    }
    return result;
  }

  /**
   * Get current memory usage info.
   * @returns {{ usageMB: number, warning: boolean, level: string }}
   */
  function getMemoryUsage() {
    var usageMB = 0;
    if (typeof performance !== 'undefined' && performance.memory) {
      usageMB = performance.memory.usedJSHeapSize / (1024 * 1024);
    }
    var check = _checkMemoryWarning(usageMB, MEMORY_WARNING_THRESHOLD_MB);
    return {
      usageMB: usageMB,
      warning: check.warning,
      level: check.level
    };
  }

  /**
   * Register a callback ID for a subsystem (rAF or setTimeout).
   * @param {string} name
   * @param {number} callbackId
   */
  function registerCallback(name, callbackId) {
    if (_subsystems[name] && _subsystems[name].running) {
      _subsystems[name].callbacks.push(callbackId);
    }
  }

  /**
   * Set resources reference for a subsystem.
   * @param {string} name
   * @param {*} resources
   */
  function setResources(name, resources) {
    if (_subsystems[name]) {
      _subsystems[name].resources = resources;
    }
  }

  /**
   * Bind the beforeunload handler (once).
   */
  function _bindBeforeUnload() {
    if (_beforeUnloadBound) return;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('beforeunload', function () {
        stopAll();
      });
      _beforeUnloadBound = true;
    }
  }

  return {
    // Public API
    init: init,
    startSubsystem: startSubsystem,
    stopSubsystem: stopSubsystem,
    stopAll: stopAll,
    getSubsystemState: getSubsystemState,
    getAllStates: getAllStates,
    getMemoryUsage: getMemoryUsage,
    registerCallback: registerCallback,
    setResources: setResources,

    // Testable pure-function internals
    _startSubsystem: _startSubsystem,
    _stopSubsystem: _stopSubsystem,
    _checkMemoryWarning: _checkMemoryWarning,

    // Constants exposed for tests
    SUBSYSTEM_NAMES: SUBSYSTEM_NAMES,
    MAX_BUFFERS_PER_SUBSYSTEM: MAX_BUFFERS_PER_SUBSYSTEM,
    MEMORY_WARNING_THRESHOLD_MB: MEMORY_WARNING_THRESHOLD_MB
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.LifecycleManager = LifecycleManager;
}
