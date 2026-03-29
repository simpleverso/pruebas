// gamepad-input.js — GamepadInput
// Gamepad enumeration, polling (60Hz), stick-to-command mapping, override logic.
// Provides: init, enumerateGamepads, selectGamepad, poll, isOverriding, onOverrideStart, onOverrideEnd, start, stop
// Requirements: 11.1–11.17

/* global globalThis, ConfigManager */
var GamepadInput = (function () {
  'use strict';

  // ---- Internal state ----
  var _activeIndex = null;        // index of the active gamepad
  var _activeName = '';           // display name of the active gamepad
  var _status = 'none';          // 'connected' | 'disconnected' | 'fallback-active' | 'none'
  var _started = false;
  var _pollTimer = null;          // rAF or interval ID for 60Hz polling
  var _overriding = false;        // true when sticks exceed dead-zone
  var _holdTimer = null;          // timer for hold delay before resuming auto-tracking
  var _overrideStartCallbacks = [];
  var _overrideEndCallbacks = [];

  // Config values (loaded from ConfigManager)
  var _deadZone = 0.15;
  var _holdDelay = 2000;
  var _mappings = {
    panAxis: 0,
    tiltAxis: 1,
    zoomAxis: 3,
    toggleTrackingButton: 4,
    lockTargetButton: 5,
    recordButton: 0
  };

  // Last polled state (cached for consumers)
  var _lastState = {
    panAxis: 0,
    tiltAxis: 0,
    zoomAxis: 0,
    buttons: {
      toggleTracking: false,
      lockTarget: false,
      record: false
    }
  };

  // Previous button states for edge detection (press, not hold)
  var _prevButtons = {
    toggleTracking: false,
    lockTarget: false,
    record: false
  };

  // ---- Helpers ----

  /**
   * Load gamepad config from ConfigManager.
   */
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg.gamepad) {
          _deadZone = typeof cfg.gamepad.deadZone === 'number' ? cfg.gamepad.deadZone : 0.15;
          _holdDelay = typeof cfg.gamepad.holdDelay === 'number' ? cfg.gamepad.holdDelay : 2000;
          if (cfg.gamepad.mappings) {
            _mappings.panAxis = typeof cfg.gamepad.mappings.panAxis === 'number' ? cfg.gamepad.mappings.panAxis : 0;
            _mappings.tiltAxis = typeof cfg.gamepad.mappings.tiltAxis === 'number' ? cfg.gamepad.mappings.tiltAxis : 1;
            _mappings.zoomAxis = typeof cfg.gamepad.mappings.zoomAxis === 'number' ? cfg.gamepad.mappings.zoomAxis : 3;
            _mappings.toggleTrackingButton = typeof cfg.gamepad.mappings.toggleTrackingButton === 'number' ? cfg.gamepad.mappings.toggleTrackingButton : 4;
            _mappings.lockTargetButton = typeof cfg.gamepad.mappings.lockTargetButton === 'number' ? cfg.gamepad.mappings.lockTargetButton : 5;
            _mappings.recordButton = typeof cfg.gamepad.mappings.recordButton === 'number' ? cfg.gamepad.mappings.recordButton : 0;
          }
          return cfg.gamepad.lastIndex;
        }
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Persist gamepad config via ConfigManager.
   */
  function _persistConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.gamepad.lastIndex = _activeIndex;
        cfg.gamepad.deadZone = _deadZone;
        cfg.gamepad.holdDelay = _holdDelay;
        cfg.gamepad.mappings = {
          panAxis: _mappings.panAxis,
          tiltAxis: _mappings.tiltAxis,
          zoomAxis: _mappings.zoomAxis,
          toggleTrackingButton: _mappings.toggleTrackingButton,
          lockTargetButton: _mappings.lockTargetButton,
          recordButton: _mappings.recordButton
        };
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Get the raw Gamepad object by index from the browser API.
   * @param {number} index
   * @returns {Gamepad|null}
   */
  function _getRawGamepad(index) {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    try {
      var gamepads = navigator.getGamepads();
      if (gamepads && index >= 0 && index < gamepads.length) {
        return gamepads[index] || null;
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  /**
   * Get all connected gamepads from the browser API.
   * @returns {Gamepad[]}
   */
  function _getAllGamepads() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return [];
    try {
      var raw = navigator.getGamepads();
      var result = [];
      if (raw) {
        for (var i = 0; i < raw.length; i++) {
          if (raw[i]) result.push(raw[i]);
        }
      }
      return result;
    } catch (_) { /* ignore */ }
    return [];
  }

  /**
   * Apply dead-zone to an axis value.
   * Returns 0 if within dead-zone, otherwise scales the remaining range to [0,1].
   * @param {number} value - raw axis value in [-1, 1]
   * @param {number} dz - dead-zone threshold
   * @returns {number} - processed value in [-1, 1]
   */
  function _applyDeadZone(value, dz) {
    if (Math.abs(value) <= dz) return 0;
    // Scale the remaining range so that just outside dead-zone starts near 0
    var sign = value > 0 ? 1 : -1;
    return sign * (Math.abs(value) - dz) / (1 - dz);
  }

  /**
   * Check if any axis value exceeds the dead-zone.
   * @param {number} pan
   * @param {number} tilt
   * @param {number} zoom
   * @returns {boolean}
   */
  function _anyStickActive(pan, tilt, zoom) {
    return pan !== 0 || tilt !== 0 || zoom !== 0;
  }

  /**
   * Fire override start callbacks.
   */
  function _fireOverrideStart() {
    for (var i = 0; i < _overrideStartCallbacks.length; i++) {
      try { _overrideStartCallbacks[i](); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Fire override end callbacks.
   */
  function _fireOverrideEnd() {
    for (var i = 0; i < _overrideEndCallbacks.length; i++) {
      try { _overrideEndCallbacks[i](); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Clear the hold delay timer.
   */
  function _clearHoldTimer() {
    if (_holdTimer !== null) {
      clearTimeout(_holdTimer);
      _holdTimer = null;
    }
  }

  /**
   * Handle gamepad connected event.
   */
  function _onGamepadConnected(e) {
    // Auto-assign if we have no active gamepad
    if (_activeIndex === null || _status === 'none' || _status === 'disconnected') {
      _activeIndex = e.gamepad.index;
      _activeName = e.gamepad.id || 'Gamepad ' + e.gamepad.index;
      _status = 'connected';
      _persistConfig();
    }
  }

  /**
   * Handle gamepad disconnected event.
   */
  function _onGamepadDisconnected(e) {
    if (e.gamepad.index !== _activeIndex) return;
    _status = 'disconnected';
    _attemptFallback();
  }

  /**
   * Attempt to fall back to the next available gamepad.
   */
  function _attemptFallback() {
    var gamepads = _getAllGamepads();
    var fallback = null;

    for (var i = 0; i < gamepads.length; i++) {
      if (gamepads[i].index !== _activeIndex) {
        fallback = gamepads[i];
        break;
      }
    }

    if (fallback) {
      _activeIndex = fallback.index;
      _activeName = fallback.id || 'Gamepad ' + fallback.index;
      _status = 'fallback-active';
      _persistConfig();
    } else {
      // No gamepads available
      _activeIndex = null;
      _activeName = '';
      _status = 'none';
      // Will auto-assign when a new gamepad connects via the connected event
    }
  }

  /**
   * Internal poll tick — reads gamepad state and updates override logic.
   */
  function _pollTick() {
    if (!_started) return;

    var gp = _activeIndex !== null ? _getRawGamepad(_activeIndex) : null;

    if (!gp) {
      // Gamepad not available — check if it disconnected
      if (_activeIndex !== null && _status === 'connected') {
        _status = 'disconnected';
        _attemptFallback();
      }
      _lastState.panAxis = 0;
      _lastState.tiltAxis = 0;
      _lastState.zoomAxis = 0;
      _lastState.buttons.toggleTracking = false;
      _lastState.buttons.lockTarget = false;
      _lastState.buttons.record = false;
      return;
    }

    // Read axes with dead-zone
    var rawPan = gp.axes[_mappings.panAxis] || 0;
    var rawTilt = gp.axes[_mappings.tiltAxis] || 0;
    var rawZoom = gp.axes[_mappings.zoomAxis] || 0;

    var pan = _applyDeadZone(rawPan, _deadZone);
    var tilt = _applyDeadZone(rawTilt, _deadZone);
    var zoom = _applyDeadZone(rawZoom, _deadZone);

    _lastState.panAxis = pan;
    _lastState.tiltAxis = tilt;
    _lastState.zoomAxis = zoom;

    // Read buttons
    var toggleBtn = gp.buttons[_mappings.toggleTrackingButton];
    var lockBtn = gp.buttons[_mappings.lockTargetButton];
    var recordBtn = gp.buttons[_mappings.recordButton];

    _lastState.buttons.toggleTracking = toggleBtn ? toggleBtn.pressed : false;
    _lastState.buttons.lockTarget = lockBtn ? lockBtn.pressed : false;
    _lastState.buttons.record = recordBtn ? recordBtn.pressed : false;

    // Update previous button states
    _prevButtons.toggleTracking = _lastState.buttons.toggleTracking;
    _prevButtons.lockTarget = _lastState.buttons.lockTarget;
    _prevButtons.record = _lastState.buttons.record;

    // Override logic
    var sticksActive = _anyStickActive(pan, tilt, zoom);

    if (sticksActive && !_overriding) {
      // Entering override mode
      _overriding = true;
      _clearHoldTimer();
      _fireOverrideStart();
    } else if (!sticksActive && _overriding) {
      // Sticks returned to dead-zone — start hold delay
      _clearHoldTimer();
      _holdTimer = setTimeout(function () {
        _overriding = false;
        _holdTimer = null;
        _fireOverrideEnd();
      }, _holdDelay);
    } else if (sticksActive && _overriding) {
      // Still overriding — cancel any pending hold timer
      _clearHoldTimer();
    }
  }

  /**
   * Start the 60Hz polling loop using setInterval (more reliable than rAF for background tabs).
   */
  function _startPolling() {
    _stopPolling();
    // ~60Hz = ~16.67ms interval
    _pollTimer = setInterval(_pollTick, 16);
  }

  /**
   * Stop the polling loop.
   */
  function _stopPolling() {
    if (_pollTimer !== null) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
  }

  // ---- Public API ----

  /**
   * Initialize GamepadInput: load config, set up event listeners, auto-detect gamepads.
   */
  function init() {
    var lastIndex = _loadConfig();

    // Set up gamepad connect/disconnect listeners
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', _onGamepadConnected);
      window.addEventListener('gamepaddisconnected', _onGamepadDisconnected);
    }

    // Try to use last-used gamepad or first available
    var gamepads = _getAllGamepads();

    if (lastIndex !== null && lastIndex !== undefined) {
      // Check if last-used gamepad is still connected
      var found = false;
      for (var i = 0; i < gamepads.length; i++) {
        if (gamepads[i].index === lastIndex) {
          _activeIndex = lastIndex;
          _activeName = gamepads[i].id || 'Gamepad ' + lastIndex;
          _status = 'connected';
          found = true;
          break;
        }
      }
      if (!found && gamepads.length > 0) {
        // Last-used not available, use first detected
        _activeIndex = gamepads[0].index;
        _activeName = gamepads[0].id || 'Gamepad ' + gamepads[0].index;
        _status = 'connected';
      } else if (!found) {
        _activeIndex = null;
        _activeName = '';
        _status = 'none';
      }
    } else if (gamepads.length > 0) {
      // No last-used, auto-use first detected
      _activeIndex = gamepads[0].index;
      _activeName = gamepads[0].id || 'Gamepad ' + gamepads[0].index;
      _status = 'connected';
    } else {
      _activeIndex = null;
      _activeName = '';
      _status = 'none';
    }

    if (_activeIndex !== null) {
      _persistConfig();
    }
  }

  /**
   * Enumerate all connected gamepads.
   * @returns {Array<{index: number, name: string, connected: boolean}>}
   */
  function enumerateGamepads() {
    var gamepads = _getAllGamepads();
    var result = [];
    for (var i = 0; i < gamepads.length; i++) {
      result.push({
        index: gamepads[i].index,
        name: gamepads[i].id || 'Gamepad ' + gamepads[i].index,
        connected: gamepads[i].connected
      });
    }
    return result;
  }

  /**
   * Select a specific gamepad by index.
   * @param {number} index
   */
  function selectGamepad(index) {
    var gp = _getRawGamepad(index);
    if (gp) {
      _activeIndex = index;
      _activeName = gp.id || 'Gamepad ' + index;
      _status = 'connected';
      _persistConfig();
    }
  }

  /**
   * Poll the current gamepad state.
   * Returns the latest cached state (updated at 60Hz by the internal loop).
   * @returns {GamepadState}
   */
  function poll() {
    // If polling loop is not running (e.g., called manually), do a tick
    if (!_started) {
      _pollTick();
    }
    return {
      panAxis: _lastState.panAxis,
      tiltAxis: _lastState.tiltAxis,
      zoomAxis: _lastState.zoomAxis,
      buttons: {
        toggleTracking: _lastState.buttons.toggleTracking,
        lockTarget: _lastState.buttons.lockTarget,
        record: _lastState.buttons.record
      }
    };
  }

  /**
   * Check if the gamepad is currently overriding auto-tracking.
   * @returns {boolean}
   */
  function isOverriding() {
    return _overriding;
  }

  /**
   * Register a callback for when gamepad override starts.
   * @param {function} callback
   */
  function onOverrideStart(callback) {
    if (typeof callback === 'function') {
      _overrideStartCallbacks.push(callback);
    }
  }

  /**
   * Register a callback for when gamepad override ends.
   * @param {function} callback
   */
  function onOverrideEnd(callback) {
    if (typeof callback === 'function') {
      _overrideEndCallbacks.push(callback);
    }
  }

  /**
   * Start the GamepadInput subsystem: begin 60Hz polling.
   */
  function start() {
    _started = true;
    _startPolling();
  }

  /**
   * Stop the GamepadInput subsystem: stop polling, clear timers, reset state.
   */
  function stop() {
    _started = false;
    _stopPolling();
    _clearHoldTimer();
    _overriding = false;
    _lastState.panAxis = 0;
    _lastState.tiltAxis = 0;
    _lastState.zoomAxis = 0;
    _lastState.buttons.toggleTracking = false;
    _lastState.buttons.lockTarget = false;
    _lastState.buttons.record = false;

    if (typeof window !== 'undefined') {
      window.removeEventListener('gamepadconnected', _onGamepadConnected);
      window.removeEventListener('gamepaddisconnected', _onGamepadDisconnected);
    }
  }

  /**
   * Get the current status of the GamepadInput subsystem.
   * @returns {{ index: number|null, name: string, status: string, overriding: boolean }}
   */
  function getStatus() {
    return {
      index: _activeIndex,
      name: _activeName,
      status: _status,
      overriding: _overriding
    };
  }

  // ---- Testable internals (exposed for property tests) ----

  /**
   * Apply dead-zone to an axis value.
   * Exposed for testing stick-to-command proportionality.
   * @param {number} value - raw axis value in [-1, 1]
   * @param {number} dz - dead-zone threshold
   * @returns {number}
   */
  function _testApplyDeadZone(value, dz) {
    return _applyDeadZone(value, dz);
  }

  /**
   * Compute gamepad state from raw axis/button values.
   * Exposed for testing without real gamepad hardware.
   * @param {object} rawState - { axes: number[], buttons: Array<{pressed: boolean}> }
   * @param {object} [mappings] - axis/button mappings override
   * @param {number} [deadZone] - dead-zone override
   * @returns {GamepadState}
   */
  function _computeState(rawState, mappings, deadZone) {
    var m = mappings || _mappings;
    var dz = typeof deadZone === 'number' ? deadZone : _deadZone;
    var axes = rawState.axes || [];
    var buttons = rawState.buttons || [];

    var rawPan = axes[m.panAxis] || 0;
    var rawTilt = axes[m.tiltAxis] || 0;
    var rawZoom = axes[m.zoomAxis] || 0;

    var toggleBtn = buttons[m.toggleTrackingButton];
    var lockBtn = buttons[m.lockTargetButton];
    var recordBtn = buttons[m.recordButton];

    return {
      panAxis: _applyDeadZone(rawPan, dz),
      tiltAxis: _applyDeadZone(rawTilt, dz),
      zoomAxis: _applyDeadZone(rawZoom, dz),
      buttons: {
        toggleTracking: toggleBtn ? (typeof toggleBtn === 'object' ? toggleBtn.pressed : !!toggleBtn) : false,
        lockTarget: lockBtn ? (typeof lockBtn === 'object' ? lockBtn.pressed : !!lockBtn) : false,
        record: recordBtn ? (typeof recordBtn === 'object' ? recordBtn.pressed : !!recordBtn) : false
      }
    };
  }

  /**
   * Determine override state given axis values and current override state.
   * Exposed for testing override engagement/disengagement logic.
   * @param {number} pan - processed pan axis value
   * @param {number} tilt - processed tilt axis value
   * @param {number} zoom - processed zoom axis value
   * @param {boolean} currentlyOverriding - current override state
   * @returns {{ overriding: boolean, action: 'start' | 'hold-delay' | 'none' }}
   */
  function _computeOverride(pan, tilt, zoom, currentlyOverriding) {
    var sticksActive = pan !== 0 || tilt !== 0 || zoom !== 0;

    if (sticksActive && !currentlyOverriding) {
      return { overriding: true, action: 'start' };
    } else if (!sticksActive && currentlyOverriding) {
      return { overriding: true, action: 'hold-delay' };
    } else if (sticksActive && currentlyOverriding) {
      return { overriding: true, action: 'none' };
    } else {
      return { overriding: false, action: 'none' };
    }
  }

  /**
   * Select fallback gamepad from a list given the current active index.
   * Exposed for testing fallback selection logic.
   * @param {Array} gamepadList - array of { index: number, name: string }
   * @param {number|null} activeIndex - the currently active gamepad index
   * @returns {{ fallbackIndex: number|null, newStatus: string }}
   */
  function _selectFallback(gamepadList, activeIndex) {
    if (!gamepadList || gamepadList.length === 0) {
      return { fallbackIndex: null, newStatus: 'none' };
    }

    for (var i = 0; i < gamepadList.length; i++) {
      if (gamepadList[i].index !== activeIndex) {
        return { fallbackIndex: gamepadList[i].index, newStatus: 'fallback-active' };
      }
    }

    return { fallbackIndex: null, newStatus: 'none' };
  }

  return {
    init: init,
    enumerateGamepads: enumerateGamepads,
    selectGamepad: selectGamepad,
    poll: poll,
    isOverriding: isOverriding,
    onOverrideStart: onOverrideStart,
    onOverrideEnd: onOverrideEnd,
    start: start,
    stop: stop,
    getStatus: getStatus,
    // Testable internals
    _applyDeadZone: _testApplyDeadZone,
    _computeState: _computeState,
    _computeOverride: _computeOverride,
    _selectFallback: _selectFallback
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.GamepadInput = GamepadInput;
}
