// serial-controller.js — SerialController
// Web Serial API communication with template-based command formatting.
// Provides: init, enumeratePorts, connect, disconnect, sendCommand, onDisconnect, getStatus, start, stop
// Requirements: 8.1–8.15

/* global globalThis, ConfigManager, TemplateEngine */
var SerialController = (function () {
  'use strict';

  // ---- Internal state ----
  var _port = null;            // active SerialPort object
  var _reader = null;          // ReadableStream reader for ACK
  var _writer = null;          // WritableStream writer for commands
  var _ports = [];             // cached SerialPortInfo[]
  var _currentPortId = '';
  var _currentName = '';
  var _status = 'disconnected'; // 'connected' | 'disconnected' | 'fallback-active'
  var _started = false;
  var _disconnectCallbacks = [];
  var _reconnectTimer = null;
  var _serialConfig = {
    baudRate: 9600,
    dataBits: 8,
    stopBits: 1,
    parity: 'none'
  };
  var _ackTimeout = 500;
  var _retryCount = 3;
  var _commandTemplates = {};

  // ---- Helpers ----

  /**
   * Check if Web Serial API is available.
   */
  function _hasSerialAPI() {
    return typeof navigator !== 'undefined' &&
           navigator.serial !== undefined &&
           navigator.serial !== null;
  }

  /**
   * Persist serial config via ConfigManager.
   */
  function _persistConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.serial.lastPortId = _currentPortId || null;
        cfg.serial.baudRate = _serialConfig.baudRate;
        cfg.serial.dataBits = _serialConfig.dataBits;
        cfg.serial.stopBits = _serialConfig.stopBits;
        cfg.serial.parity = _serialConfig.parity;
        cfg.serial.ackTimeout = _ackTimeout;
        cfg.serial.retryCount = _retryCount;
        cfg.serial.commandTemplates = _commandTemplates;
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Load serial config from ConfigManager.
   */
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg.serial) {
          _serialConfig.baudRate = cfg.serial.baudRate || 9600;
          _serialConfig.dataBits = cfg.serial.dataBits || 8;
          _serialConfig.stopBits = cfg.serial.stopBits || 1;
          _serialConfig.parity = cfg.serial.parity || 'none';
          _ackTimeout = cfg.serial.ackTimeout || 500;
          _retryCount = cfg.serial.retryCount || 3;
          _commandTemplates = cfg.serial.commandTemplates || {};
          return cfg.serial.lastPortId || null;
        }
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Generate a port identifier string from a SerialPort.
   */
  function _getPortId(port) {
    if (!port) return '';
    try {
      var info = port.getInfo();
      if (info.usbVendorId !== undefined) {
        return 'usb-' + info.usbVendorId + '-' + (info.usbProductId || '0');
      }
    } catch (_) { /* ignore */ }
    // Fallback: use index in ports list
    var idx = _ports.indexOf(port);
    return idx >= 0 ? 'port-' + idx : 'port-unknown';
  }

  /**
   * Generate a display name for a SerialPort.
   */
  function _getPortName(port) {
    if (!port) return 'Unknown Port';
    try {
      var info = port.getInfo();
      if (info.usbVendorId !== undefined) {
        return 'USB Serial (' + info.usbVendorId + ':' + (info.usbProductId || '0') + ')';
      }
    } catch (_) { /* ignore */ }
    var idx = _ports.indexOf(port);
    return 'Serial Port ' + (idx >= 0 ? idx : '?');
  }

  /**
   * Close the current port connection and clean up readers/writers.
   */
  function _closePort() {
    if (_reader) {
      try { _reader.cancel(); } catch (_) { /* ignore */ }
      _reader = null;
    }
    if (_writer) {
      try { _writer.close(); } catch (_) { /* ignore */ }
      _writer = null;
    }
    if (_port) {
      try { _port.close(); } catch (_) { /* ignore */ }
      _port = null;
    }
  }

  /**
   * Open a serial port with the current config.
   */
  function _openPort(port) {
    _closePort();
    _port = port;

    return port.open({
      baudRate: _serialConfig.baudRate,
      dataBits: _serialConfig.dataBits,
      stopBits: _serialConfig.stopBits,
      parity: _serialConfig.parity
    }).then(function () {
      if (port.writable) {
        _writer = port.writable.getWriter();
      }
      if (port.readable) {
        _reader = port.readable.getReader();
      }

      _currentPortId = _getPortId(port);
      _currentName = _getPortName(port);
      _status = 'connected';
      _persistConfig();
      _clearReconnectTimer();

      // Listen for disconnect
      if (typeof port.addEventListener === 'function') {
        port.addEventListener('disconnect', _handleDisconnect);
      }
    });
  }

  /**
   * Handle port disconnect event.
   */
  function _handleDisconnect() {
    if (!_started) return;
    _status = 'disconnected';
    _closePort();
    _attemptFallback();
  }

  /**
   * Attempt to fall back to the next available port.
   */
  function _attemptFallback() {
    return enumeratePorts().then(function (ports) {
      var fallbackPortId = null;
      var fallbackPort = null;

      for (var i = 0; i < ports.length; i++) {
        var pid = ports[i].portId || _getPortId(ports[i]._port || ports[i]);
        if (pid !== _currentPortId) {
          fallbackPortId = pid;
          fallbackPort = ports[i]._port || null;
          break;
        }
      }

      // Notify callbacks
      for (var j = 0; j < _disconnectCallbacks.length; j++) {
        try { _disconnectCallbacks[j](fallbackPortId); } catch (_) { /* ignore */ }
      }

      if (fallbackPort) {
        _status = 'fallback-active';
        return _openPort(fallbackPort).catch(function () {
          _enterDisconnected();
        });
      } else {
        _enterDisconnected();
      }
    }).catch(function () {
      _enterDisconnected();
    });
  }

  /**
   * Enter disconnected state: retry every 2 seconds.
   */
  function _enterDisconnected() {
    _status = 'disconnected';
    _currentPortId = '';
    _currentName = '';
    _closePort();
    _startReconnectTimer();
  }

  /**
   * Start the reconnect timer (every 2 seconds).
   */
  function _startReconnectTimer() {
    _clearReconnectTimer();
    _reconnectTimer = setInterval(function () {
      if (!_started) {
        _clearReconnectTimer();
        return;
      }
      enumeratePorts().then(function (ports) {
        if (ports.length > 0 && _status === 'disconnected') {
          _clearReconnectTimer();
          var firstPort = ports[0]._port || null;
          if (firstPort) {
            _openPort(firstPort).catch(function () {
              // Stay disconnected, timer will restart
              _startReconnectTimer();
            });
          }
        }
      }).catch(function () { /* keep trying */ });
    }, 2000);
  }

  /**
   * Clear the reconnect timer.
   */
  function _clearReconnectTimer() {
    if (_reconnectTimer !== null) {
      clearInterval(_reconnectTimer);
      _reconnectTimer = null;
    }
  }

  /**
   * Wait for an ACK byte from the serial port within the configured timeout.
   * Returns true if ACK received, false on timeout.
   */
  function _waitForAck() {
    if (!_reader) return Promise.resolve(false);

    return new Promise(function (resolve) {
      var timer = setTimeout(function () {
        resolve(false);
      }, _ackTimeout);

      _reader.read().then(function (result) {
        clearTimeout(timer);
        if (result.done) {
          resolve(false);
        } else {
          resolve(true);
        }
      }).catch(function () {
        clearTimeout(timer);
        resolve(false);
      });
    });
  }

  /**
   * Write data to the serial port.
   */
  function _writeData(data) {
    if (!_writer) return Promise.reject(new Error('No writer available'));

    var bytes;
    if (data instanceof Uint8Array) {
      bytes = data;
    } else {
      // Encode string to bytes
      var encoder = new TextEncoder();
      bytes = encoder.encode(String(data));
    }

    return _writer.write(bytes);
  }

  // ---- Public API ----

  /**
   * Initialize SerialController: load config, set up port change detection.
   * @returns {Promise<void>}
   */
  function init() {
    var lastPortId = _loadConfig();

    if (!_hasSerialAPI()) {
      // Web Serial API not available — stay disconnected
      return Promise.resolve();
    }

    // Listen for connect/disconnect events on navigator.serial
    if (navigator.serial.addEventListener) {
      navigator.serial.addEventListener('connect', function () {
        if (_started && _status === 'disconnected') {
          enumeratePorts().then(function (ports) {
            if (ports.length > 0) {
              _clearReconnectTimer();
              var firstPort = ports[0]._port || null;
              if (firstPort) {
                _openPort(firstPort).catch(function () { /* ignore */ });
              }
            }
          });
        }
      });

      navigator.serial.addEventListener('disconnect', function () {
        if (_started && _port) {
          // Check if our port is still valid
          _handleDisconnect();
        }
      });
    }

    // Enumerate and try to reconnect to last-used port
    return enumeratePorts().then(function (ports) {
      if (lastPortId && ports.length > 0) {
        for (var i = 0; i < ports.length; i++) {
          if (ports[i].portId === lastPortId && ports[i]._port) {
            return _openPort(ports[i]._port).catch(function () {
              // Could not reconnect to last port
            });
          }
        }
      }
    }).catch(function () {
      // Enumeration failed — stay disconnected
    });
  }

  /**
   * Enumerate all available serial ports.
   * @returns {Promise<SerialPortInfo[]>}
   */
  function enumeratePorts() {
    if (!_hasSerialAPI()) {
      _ports = [];
      return Promise.resolve([]);
    }

    return navigator.serial.getPorts().then(function (ports) {
      _ports = ports;
      var result = [];
      for (var i = 0; i < ports.length; i++) {
        result.push({
          portId: _getPortId(ports[i]),
          name: _getPortName(ports[i]),
          _port: ports[i]
        });
      }
      return result;
    });
  }

  /**
   * Connect to a specific port by ID with optional config override.
   * @param {string} portId
   * @param {object} [config]
   * @returns {Promise<void>}
   */
  function connect(portId, config) {
    if (config) {
      if (config.baudRate !== undefined) _serialConfig.baudRate = config.baudRate;
      if (config.dataBits !== undefined) _serialConfig.dataBits = config.dataBits;
      if (config.stopBits !== undefined) _serialConfig.stopBits = config.stopBits;
      if (config.parity !== undefined) _serialConfig.parity = config.parity;
    }

    // Find the port by ID
    for (var i = 0; i < _ports.length; i++) {
      if (_getPortId(_ports[i]) === portId) {
        return _openPort(_ports[i]);
      }
    }

    return Promise.reject(new Error('SerialController: port not found: ' + portId));
  }

  /**
   * Disconnect from the current port.
   */
  function disconnect() {
    _closePort();
    _status = 'disconnected';
    _currentPortId = '';
    _currentName = '';
    _clearReconnectTimer();
  }

  /**
   * Send a PTZ command via the serial port.
   * Uses TemplateEngine for placeholder substitution.
   * Waits for ACK with retry logic.
   * @param {string} action - PTZ action: 'pan', 'tilt', 'zoom', 'stop'
   * @param {object} variables - Command variables for template substitution
   * @returns {Promise<boolean>} - true if ACK received, false if all retries exhausted
   */
  function sendCommand(action, variables) {
    if (_status !== 'connected' && _status !== 'fallback-active') {
      return Promise.resolve(false);
    }

    // Get the template for this action
    var template = _commandTemplates[action];
    if (!template) {
      // No template configured for this action
      return Promise.resolve(false);
    }

    // Compile and evaluate the template
    var compiled;
    var data;
    if (typeof TemplateEngine !== 'undefined' && TemplateEngine.compile && TemplateEngine.evaluate) {
      compiled = TemplateEngine.compile(template);
      data = TemplateEngine.evaluate(compiled, variables || {});
    } else {
      // Fallback: just send the raw template
      data = template;
    }

    // Retry loop
    var attempts = 0;
    var maxAttempts = _retryCount;

    function attempt() {
      attempts++;
      return _writeData(data).then(function () {
        return _waitForAck();
      }).then(function (ackReceived) {
        if (ackReceived) {
          return true;
        }
        if (attempts < maxAttempts) {
          return attempt();
        }
        // All retries exhausted
        return false;
      }).catch(function () {
        if (attempts < maxAttempts) {
          return attempt();
        }
        return false;
      });
    }

    return attempt();
  }

  /**
   * Register a callback for disconnect events.
   * Callback receives the fallback port ID (or null if none available).
   * @param {function} callback
   */
  function onDisconnect(callback) {
    if (typeof callback === 'function') {
      _disconnectCallbacks.push(callback);
    }
  }

  /**
   * Get the current status of the SerialController.
   * @returns {{ portId: string, name: string, status: string }}
   */
  function getStatus() {
    return {
      portId: _currentPortId,
      name: _currentName,
      status: _status
    };
  }

  /**
   * Start the SerialController subsystem.
   */
  function start() {
    _started = true;
  }

  /**
   * Stop the SerialController subsystem: close port, clear timers.
   */
  function stop() {
    _started = false;
    _closePort();
    _clearReconnectTimer();
    _status = 'disconnected';
    _currentPortId = '';
    _currentName = '';
  }

  // ---- Testable internals (exposed for property tests) ----

  /**
   * Send raw data and wait for ACK with retry logic.
   * Exposed for testing retry behavior without needing real serial ports.
   * @param {function} writeFn - async function that writes data
   * @param {function} ackFn - async function that returns true/false for ACK
   * @param {object} [opts] - { retryCount, ackTimeout }
   * @returns {Promise<{ success: boolean, attempts: number }>}
   */
  function _sendWithRetry(writeFn, ackFn, opts) {
    opts = opts || {};
    var maxAttempts = (opts.retryCount !== undefined) ? opts.retryCount : _retryCount;
    var attempts = 0;

    function attempt() {
      attempts++;
      return Promise.resolve().then(function () {
        return writeFn();
      }).then(function () {
        return ackFn();
      }).then(function (ackReceived) {
        if (ackReceived) {
          return { success: true, attempts: attempts };
        }
        if (attempts < maxAttempts) {
          return attempt();
        }
        return { success: false, attempts: attempts };
      }).catch(function () {
        if (attempts < maxAttempts) {
          return attempt();
        }
        return { success: false, attempts: attempts };
      });
    }

    return attempt();
  }

  /**
   * Select fallback port from a list given the current active port ID.
   * Exposed for testing fallback selection logic.
   * @param {Array} portList - array of { portId: string, ... }
   * @param {string} activePortId - the currently active port ID
   * @returns {{ fallbackPortId: string|null, newStatus: string }}
   */
  function _selectFallback(portList, activePortId) {
    if (!portList || portList.length === 0) {
      return { fallbackPortId: null, newStatus: 'disconnected' };
    }

    for (var i = 0; i < portList.length; i++) {
      if (portList[i].portId !== activePortId) {
        return { fallbackPortId: portList[i].portId, newStatus: 'fallback-active' };
      }
    }

    return { fallbackPortId: null, newStatus: 'disconnected' };
  }

  return {
    init: init,
    enumeratePorts: enumeratePorts,
    connect: connect,
    disconnect: disconnect,
    sendCommand: sendCommand,
    sendRaw: function (str) {
      if (!_writer) return Promise.resolve(false);
      var encoder = new TextEncoder();
      // Replace literal \r\n escape sequences with actual characters
      var processed = str.replace(/\\r/g, '\r').replace(/\\n/g, '\n');
      return _writer.write(encoder.encode(processed)).then(function () { return true; }).catch(function () { return false; });
    },
    onDisconnect: onDisconnect,
    getStatus: getStatus,
    start: start,
    stop: stop,
    // Testable internals
    _sendWithRetry: _sendWithRetry,
    _selectFallback: _selectFallback
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.SerialController = SerialController;
}
