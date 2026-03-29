// ptz-movement.js — PTZ Movement Control
// Manual commands, auto-tracking displacement conversion, dead-zone, speed levels.
// Provides: sendManualCommand, convertDisplacement, isInDeadZone, setSpeedLevel, testCommand
// Requirements: 9.1–9.8

/* global globalThis, ConfigManager, SerialController, TemplateEngine */
var PTZMovement = (function () {
  'use strict';

  // ---- Constants ----

  var VALID_COMMANDS = [
    'pan-left', 'pan-right', 'tilt-up', 'tilt-down',
    'zoom-in', 'zoom-out', 'stop'
  ];

  var VALID_VARIABLE_TYPES = [
    'percent', 'percent_signed', 'angle', 'angle_delta',
    'steps', 'speed', 'direction', 'raw_hex'
  ];

  var VALID_SPEED_LEVELS = ['slow', 'medium', 'fast'];

  var DIRECTION_MAP = {
    'pan-left': 'left',
    'pan-right': 'right',
    'tilt-up': 'up',
    'tilt-down': 'down',
    'zoom-in': 'in',
    'zoom-out': 'out',
    'stop': 'stop'
  };

  // ---- Internal state ----

  var _mode = 'manual'; // 'manual' | 'auto'
  var _speedLevel = 'medium';
  var _variableType = 'percent';
  var _deadZoneRadius = 20;
  var _speedLevels = { slow: 25, medium: 50, fast: 100 };
  var _commandTemplates = {};
  var _ackTimeout = 500;
  var _started = false;

  // ---- Config persistence ----

  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg.ptz) {
          _variableType = cfg.ptz.variableType || 'percent';
          _deadZoneRadius = cfg.ptz.deadZoneRadius !== undefined ? cfg.ptz.deadZoneRadius : 20;
          if (cfg.ptz.speedLevels) {
            _speedLevels = {
              slow: cfg.ptz.speedLevels.slow !== undefined ? cfg.ptz.speedLevels.slow : 25,
              medium: cfg.ptz.speedLevels.medium !== undefined ? cfg.ptz.speedLevels.medium : 50,
              fast: cfg.ptz.speedLevels.fast !== undefined ? cfg.ptz.speedLevels.fast : 100
            };
          }
        }
        if (cfg.serial) {
          _commandTemplates = cfg.serial.commandTemplates || {};
          _ackTimeout = cfg.serial.ackTimeout || 500;
        }
      } catch (_) { /* ignore */ }
    }
  }

  function _persistConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.ptz.variableType = _variableType;
        cfg.ptz.deadZoneRadius = _deadZoneRadius;
        cfg.ptz.speedLevels = { slow: _speedLevels.slow, medium: _speedLevels.medium, fast: _speedLevels.fast };
        cfg.serial.commandTemplates = _commandTemplates;
        cfg.serial.ackTimeout = _ackTimeout;
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  // ---- Core logic ----

  /**
   * Check if a displacement vector is within the dead-zone.
   * @param {number} dx - horizontal displacement
   * @param {number} dy - vertical displacement
   * @param {number} radius - dead-zone radius
   * @returns {boolean} true if magnitude <= radius
   */
  function isInDeadZone(dx, dy, radius) {
    var mag = Math.sqrt(dx * dx + dy * dy);
    return mag <= radius;
  }

  /**
   * Convert a displacement vector (dx, dy) to movement variable values
   * for the given variable type and speed level.
   *
   * @param {number} dx - horizontal displacement (pixels from center)
   * @param {number} dy - vertical displacement (pixels from center)
   * @param {string} variableType - one of VALID_VARIABLE_TYPES
   * @param {string} speedLevel - 'slow', 'medium', or 'fast'
   * @returns {{ pan: object, tilt: object }} - variable objects for pan and tilt commands
   */
  function convertDisplacement(dx, dy, variableType, speedLevel) {
    var vType = variableType || _variableType;
    var sLevel = speedLevel || _speedLevel;
    var speedValue = _speedLevels[sLevel] !== undefined ? _speedLevels[sLevel] : _speedLevels.medium;

    var mag = Math.sqrt(dx * dx + dy * dy);
    // Normalize displacement to 0..1 range (capped at 1)
    // Use a reference max of 320 pixels (half of 640px frame width)
    var maxDisplacement = 320;
    var normMag = Math.min(mag / maxDisplacement, 1.0);

    // Determine direction
    var panDir = dx >= 0 ? 'right' : 'left';
    var tiltDir = dy >= 0 ? 'down' : 'up';

    var absDx = Math.abs(dx);
    var absDy = Math.abs(dy);
    var normDx = Math.min(absDx / maxDisplacement, 1.0);
    var normDy = Math.min(absDy / maxDisplacement, 1.0);

    var panVars = _buildVariables(normDx, panDir, vType, speedValue, dx);
    var tiltVars = _buildVariables(normDy, tiltDir, vType, speedValue, dy);

    return { pan: panVars, tilt: tiltVars };
  }

  /**
   * Build a command variables object for a given normalized magnitude,
   * direction, variable type, and speed value.
   *
   * @param {number} normMag - normalized magnitude 0..1
   * @param {string} dir - direction keyword
   * @param {string} vType - variable type
   * @param {number} speedValue - speed level value (0-100 range)
   * @param {number} rawDisplacement - raw displacement value (signed)
   * @returns {object} command variables
   */
  function _buildVariables(normMag, dir, vType, speedValue, rawDisplacement) {
    var vars = {};

    switch (vType) {
      case 'percent':
        // 0-100, scaled by speed level and displacement magnitude
        vars.percent = Math.round(Math.min(normMag * speedValue, 100));
        vars.percent = Math.max(0, Math.min(100, vars.percent));
        break;

      case 'percent_signed':
        // -100 to +100
        var sign = rawDisplacement >= 0 ? 1 : -1;
        vars.percent_signed = Math.round(sign * Math.min(normMag * speedValue, 100));
        vars.percent_signed = Math.max(-100, Math.min(100, vars.percent_signed));
        break;

      case 'angle':
        // Pan: 0-360, Tilt: -90 to 90
        if (dir === 'left' || dir === 'right') {
          vars.angle = Math.round(normMag * 360 * 10) / 10;
          vars.angle = Math.max(0, Math.min(360, vars.angle));
        } else {
          // tilt: map to -90..90
          var tiltSign = (dir === 'up') ? -1 : 1;
          vars.angle = Math.round(tiltSign * normMag * 90 * 10) / 10;
          vars.angle = Math.max(-90, Math.min(90, vars.angle));
        }
        break;

      case 'angle_delta':
        // Relative angle change, scaled by speed
        var deltaSign = rawDisplacement >= 0 ? 1 : -1;
        var scaledDelta = normMag * (speedValue / 100) * 45; // max 45 degrees per command
        vars.angle_delta = Math.round(deltaSign * scaledDelta * 10) / 10;
        break;

      case 'steps':
        // Discrete steps, scaled by speed
        var stepsSign = rawDisplacement >= 0 ? 1 : -1;
        vars.steps = Math.round(stepsSign * normMag * speedValue);
        break;

      case 'speed':
        // 1-255 byte range
        vars.speed = Math.round(normMag * (speedValue / 100) * 254) + 1;
        vars.speed = Math.max(1, Math.min(255, vars.speed));
        break;

      case 'direction':
        vars.direction = dir;
        break;

      case 'raw_hex':
        // Generate a simple hex representation of the speed byte
        var hexVal = Math.round(normMag * (speedValue / 100) * 255);
        hexVal = Math.max(0, Math.min(255, hexVal));
        vars.raw_hex = hexVal.toString(16).padStart(2, '0');
        break;

      default:
        vars.percent = Math.round(Math.min(normMag * speedValue, 100));
        vars.percent = Math.max(0, Math.min(100, vars.percent));
        break;
    }

    // Always include direction for template flexibility
    vars.direction = vars.direction || dir;

    return vars;
  }


  /**
   * Determine the PTZ action type ('pan', 'tilt', 'zoom', 'stop') from a command string.
   * @param {string} command
   * @returns {string}
   */
  function _commandToAction(command) {
    if (command === 'stop') return 'stop';
    if (command === 'pan-left' || command === 'pan-right') return 'pan';
    if (command === 'tilt-up' || command === 'tilt-down') return 'tilt';
    if (command === 'zoom-in' || command === 'zoom-out') return 'zoom';
    return 'stop';
  }

  /**
   * Send a manual PTZ command via SerialController.
   * Must complete within 50ms (Req 9.2).
   *
   * @param {string} command - one of VALID_COMMANDS
   * @param {object} [overrideVars] - optional variable overrides
   * @returns {Promise<boolean>}
   */
  function sendManualCommand(command, overrideVars) {
    if (VALID_COMMANDS.indexOf(command) === -1) {
      return Promise.resolve(false);
    }

    var action = _commandToAction(command);
    var vars = overrideVars || {};

    // If no override vars, build default vars for the command
    if (!overrideVars) {
      var dir = DIRECTION_MAP[command] || 'stop';
      var speedValue = _speedLevels[_speedLevel] || 50;

      if (command === 'stop') {
        vars = { direction: 'stop', percent: 0, percent_signed: 0, speed: 0, steps: 0 };
      } else {
        vars = _buildVariables(1.0, dir, _variableType, speedValue, dir === 'left' || dir === 'down' ? -1 : 1);
      }
    }

    if (typeof SerialController !== 'undefined' && SerialController.sendCommand) {
      return SerialController.sendCommand(action, vars);
    }

    return Promise.resolve(false);
  }

  /**
   * Process auto-tracking displacement and send PTZ commands.
   * Suppresses commands when in dead-zone (Req 9.4).
   *
   * @param {number} dx - horizontal displacement from center
   * @param {number} dy - vertical displacement from center
   * @returns {Promise<boolean>}
   */
  function processAutoTracking(dx, dy) {
    if (_mode !== 'auto' || !_started) {
      return Promise.resolve(false);
    }

    // Dead-zone check
    if (isInDeadZone(dx, dy, _deadZoneRadius)) {
      return Promise.resolve(false);
    }

    var result = convertDisplacement(dx, dy, _variableType, _speedLevel);

    // Send pan and tilt commands
    var panPromise = Promise.resolve(true);
    var tiltPromise = Promise.resolve(true);

    if (typeof SerialController !== 'undefined' && SerialController.sendCommand) {
      if (Math.abs(dx) > 0) {
        panPromise = SerialController.sendCommand('pan', result.pan);
      }
      if (Math.abs(dy) > 0) {
        tiltPromise = SerialController.sendCommand('tilt', result.tilt);
      }
    }

    return Promise.all([panPromise, tiltPromise]).then(function (results) {
      return results[0] && results[1];
    });
  }

  /**
   * Send a test command with manually entered variable values (Req 9.6).
   *
   * @param {string} action - 'pan', 'tilt', 'zoom', 'stop'
   * @param {object} variables - manually entered variable values
   * @returns {Promise<boolean>}
   */
  function testCommand(action, variables) {
    if (typeof SerialController !== 'undefined' && SerialController.sendCommand) {
      return SerialController.sendCommand(action, variables || {});
    }
    return Promise.resolve(false);
  }

  /**
   * Set the active speed level.
   * @param {string} level - 'slow', 'medium', or 'fast'
   */
  function setSpeedLevel(level) {
    if (VALID_SPEED_LEVELS.indexOf(level) !== -1) {
      _speedLevel = level;
    }
  }

  /**
   * Get the current speed level.
   * @returns {string}
   */
  function getSpeedLevel() {
    return _speedLevel;
  }

  /**
   * Set the movement variable type.
   * @param {string} type
   */
  function setVariableType(type) {
    if (VALID_VARIABLE_TYPES.indexOf(type) !== -1) {
      _variableType = type;
      _persistConfig();
    }
  }

  /**
   * Get the current variable type.
   * @returns {string}
   */
  function getVariableType() {
    return _variableType;
  }

  /**
   * Set the dead-zone radius.
   * @param {number} radius
   */
  function setDeadZoneRadius(radius) {
    if (typeof radius === 'number' && radius >= 0) {
      _deadZoneRadius = radius;
      _persistConfig();
    }
  }

  /**
   * Get the dead-zone radius.
   * @returns {number}
   */
  function getDeadZoneRadius() {
    return _deadZoneRadius;
  }

  /**
   * Set the mode: 'manual' or 'auto'.
   * On switch to manual, immediately stop auto-tracking commands (Req 9.7).
   * @param {string} mode
   */
  function setMode(mode) {
    if (mode === 'manual' || mode === 'auto') {
      var wasAuto = _mode === 'auto';
      _mode = mode;

      // If switching from auto to manual, send stop command immediately
      if (wasAuto && mode === 'manual') {
        sendManualCommand('stop');
      }
    }
  }

  /**
   * Get the current mode.
   * @returns {string}
   */
  function getMode() {
    return _mode;
  }

  /**
   * Configure speed level mappings.
   * @param {object} mappings - { slow: number, medium: number, fast: number }
   */
  function setSpeedMappings(mappings) {
    if (mappings && typeof mappings === 'object') {
      if (typeof mappings.slow === 'number') _speedLevels.slow = mappings.slow;
      if (typeof mappings.medium === 'number') _speedLevels.medium = mappings.medium;
      if (typeof mappings.fast === 'number') _speedLevels.fast = mappings.fast;
      _persistConfig();
    }
  }

  /**
   * Get speed level mappings.
   * @returns {object}
   */
  function getSpeedMappings() {
    return { slow: _speedLevels.slow, medium: _speedLevels.medium, fast: _speedLevels.fast };
  }

  /**
   * Start the PTZ movement subsystem.
   */
  function start() {
    _loadConfig();
    _started = true;
  }

  /**
   * Stop the PTZ movement subsystem.
   */
  function stop() {
    _started = false;
    _mode = 'manual';
  }

  /**
   * Initialize the PTZ movement subsystem.
   */
  function init() {
    _loadConfig();
  }

  return {
    init: init,
    start: start,
    stop: stop,
    sendManualCommand: sendManualCommand,
    processAutoTracking: processAutoTracking,
    testCommand: testCommand,
    setSpeedLevel: setSpeedLevel,
    getSpeedLevel: getSpeedLevel,
    setVariableType: setVariableType,
    getVariableType: getVariableType,
    setDeadZoneRadius: setDeadZoneRadius,
    getDeadZoneRadius: getDeadZoneRadius,
    setMode: setMode,
    getMode: getMode,
    setSpeedMappings: setSpeedMappings,
    getSpeedMappings: getSpeedMappings,
    // Testable methods (exposed for property tests)
    convertDisplacement: convertDisplacement,
    isInDeadZone: isInDeadZone,
    VALID_COMMANDS: VALID_COMMANDS,
    VALID_VARIABLE_TYPES: VALID_VARIABLE_TYPES,
    VALID_SPEED_LEVELS: VALID_SPEED_LEVELS
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.PTZMovement = PTZMovement;
}
