// video-capture.js — VideoCapture
// Webcam enumeration, stream acquisition, device fallback, frame capture.
// Provides: init, enumerateDevices, selectDevice, getFrame, onDeviceLost, start, stop, getStatus
// Requirements: 1.1–1.10

/* global globalThis, ConfigManager */
var VideoCapture = (function () {
  // ---- Internal state ----
  var _videoEl = null;          // <video id="video-source">
  var _offscreenCanvas = null;  // offscreen canvas for getFrame()
  var _offscreenCtx = null;
  var _stream = null;           // active MediaStream
  var _devices = [];            // cached MediaDeviceInfo[]
  var _currentDeviceId = '';
  var _currentLabel = '';
  var _status = 'disconnected'; // 'connected' | 'disconnected' | 'fallback-active' | 'no-signal'
  var _started = false;
  var _deviceLostCallbacks = [];
  var _reEnumerateTimer = null;
  var _deviceChangeHandler = null;

  // ---- Helpers ----

  /**
   * Persist last-used device ID via ConfigManager.
   */
  function _persistDeviceId(deviceId) {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.video.lastDeviceId = deviceId;
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Load last-used device ID from ConfigManager.
   * @returns {string|null}
   */
  function _loadLastDeviceId() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        return cfg.video.lastDeviceId || null;
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Stop the current stream tracks and clean up.
   */
  function _stopCurrentStream() {
    if (_stream) {
      var tracks = _stream.getTracks();
      for (var i = 0; i < tracks.length; i++) {
        tracks[i].removeEventListener('ended', _handleTrackEnded);
        tracks[i].stop();
      }
      _stream = null;
    }
    if (_videoEl) {
      _videoEl.srcObject = null;
    }
  }

  /**
   * Open a device stream by deviceId and attach to the video element.
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  function _openStream(deviceId) {
    _stopCurrentStream();

    var constraints = {
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false
    };

    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      _stream = stream;
      _videoEl.srcObject = stream;

      // Extract device info from the track
      var videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        _currentDeviceId = videoTrack.getSettings().deviceId || deviceId || '';
        _currentLabel = videoTrack.label || 'Unknown Camera';

        // Listen for track ending (device disconnected)
        videoTrack.addEventListener('ended', _handleTrackEnded);
      }

      _status = 'connected';
      _persistDeviceId(_currentDeviceId);
      _clearReEnumerateTimer();

      return _videoEl.play().catch(function () {
        // autoplay may be blocked; video element has autoplay attribute so this is best-effort
      });
    });
  }

  /**
   * Handle a video track ending (device lost).
   */
  function _handleTrackEnded() {
    if (!_started) return;
    _status = 'disconnected';
    _attemptFallback();
  }

  /**
   * Attempt to fall back to the next available device.
   */
  function _attemptFallback() {
    enumerateDevices().then(function (devices) {
      // Find a device that isn't the one we just lost
      var fallbackId = null;
      for (var i = 0; i < devices.length; i++) {
        if (devices[i].deviceId !== _currentDeviceId) {
          fallbackId = devices[i].deviceId;
          break;
        }
      }

      // Notify callbacks
      for (var j = 0; j < _deviceLostCallbacks.length; j++) {
        try { _deviceLostCallbacks[j](fallbackId); } catch (_) { /* ignore */ }
      }

      if (fallbackId) {
        _status = 'fallback-active';
        _openStream(fallbackId).catch(function () {
          _enterNoSignal();
        });
      } else {
        _enterNoSignal();
      }
    }).catch(function () {
      _enterNoSignal();
    });
  }

  /**
   * Enter "No Signal" state: re-enumerate every 3 seconds.
   */
  function _enterNoSignal() {
    _status = 'no-signal';
    _currentDeviceId = '';
    _currentLabel = '';
    _stopCurrentStream();
    _startReEnumerateTimer();
  }

  /**
   * Start the re-enumerate timer (every 3 seconds).
   */
  function _startReEnumerateTimer() {
    _clearReEnumerateTimer();
    _reEnumerateTimer = setInterval(function () {
      if (!_started) {
        _clearReEnumerateTimer();
        return;
      }
      enumerateDevices().then(function (devices) {
        if (devices.length > 0 && _status === 'no-signal') {
          _clearReEnumerateTimer();
          // Auto-connect to first available
          _openStream(devices[0].deviceId).catch(function () {
            // Stay in no-signal
          });
        }
      }).catch(function () { /* keep trying */ });
    }, 3000);
  }

  /**
   * Clear the re-enumerate timer.
   */
  function _clearReEnumerateTimer() {
    if (_reEnumerateTimer !== null) {
      clearInterval(_reEnumerateTimer);
      _reEnumerateTimer = null;
    }
  }

  /**
   * Handle devicechange events (new device plugged in).
   */
  function _onDeviceChange() {
    if (!_started) return;

    enumerateDevices().then(function (devices) {
      if (_status === 'no-signal' && devices.length > 0) {
        // Auto-connect to newly detected device
        _clearReEnumerateTimer();
        _openStream(devices[0].deviceId).catch(function () { /* ignore */ });
      }
    }).catch(function () { /* ignore */ });
  }

  // ---- Public API ----

  /**
   * Initialize VideoCapture: locate DOM elements, set up offscreen canvas,
   * listen for device changes, and auto-connect to last-used or default device.
   * @returns {Promise<void>}
   */
  function init() {
    _videoEl = document.getElementById('video-source');
    if (!_videoEl) {
      return Promise.reject(new Error('VideoCapture: <video id="video-source"> not found'));
    }

    // Create offscreen canvas for getFrame()
    _offscreenCanvas = document.createElement('canvas');
    _offscreenCtx = _offscreenCanvas.getContext('2d');

    // Listen for device changes (plug/unplug)
    _deviceChangeHandler = _onDeviceChange;
    if (typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener('devicechange', _deviceChangeHandler);
    }

    // Enumerate and auto-connect
    return enumerateDevices().then(function (devices) {
      if (devices.length === 0) {
        _enterNoSignal();
        return;
      }

      // Try last-used device first
      var lastId = _loadLastDeviceId();
      var targetId = null;

      if (lastId) {
        for (var i = 0; i < devices.length; i++) {
          if (devices[i].deviceId === lastId) {
            targetId = lastId;
            break;
          }
        }
      }

      // Fall back to first available if last-used not found
      if (!targetId) {
        targetId = devices[0].deviceId;
      }

      return _openStream(targetId).catch(function () {
        // If specific device fails, try default
        return _openStream('').catch(function () {
          _enterNoSignal();
        });
      });
    });
  }

  /**
   * Enumerate all available video input devices.
   * @returns {Promise<MediaDeviceInfo[]>}
   */
  function enumerateDevices() {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
      _devices = [];
      return Promise.resolve([]);
    }

    return navigator.mediaDevices.enumerateDevices().then(function (allDevices) {
      _devices = [];
      for (var i = 0; i < allDevices.length; i++) {
        if (allDevices[i].kind === 'videoinput') {
          _devices.push(allDevices[i]);
        }
      }
      return _devices;
    });
  }

  /**
   * Select and switch to a specific device by ID.
   * Switches within 1 second (Req 1.8).
   * @param {string} deviceId
   * @returns {Promise<void>}
   */
  function selectDevice(deviceId) {
    if (!deviceId) {
      return Promise.reject(new Error('VideoCapture: deviceId is required'));
    }
    return _openStream(deviceId);
  }

  /**
   * Capture the current video frame as ImageData.
   * Draws the video element onto the offscreen canvas and returns the pixel data.
   * @returns {ImageData}
   */
  function getFrame() {
    if (!_videoEl || !_offscreenCanvas || !_offscreenCtx) {
      return new ImageData(1, 1);
    }

    var w = _videoEl.videoWidth || 640;
    var h = _videoEl.videoHeight || 480;

    if (_offscreenCanvas.width !== w || _offscreenCanvas.height !== h) {
      _offscreenCanvas.width = w;
      _offscreenCanvas.height = h;
    }

    _offscreenCtx.drawImage(_videoEl, 0, 0, w, h);
    return _offscreenCtx.getImageData(0, 0, w, h);
  }

  /**
   * Register a callback for device-lost events.
   * Callback receives the fallback device ID (or null if none available).
   * @param {function} callback
   */
  function onDeviceLost(callback) {
    if (typeof callback === 'function') {
      _deviceLostCallbacks.push(callback);
    }
  }

  /**
   * Start the VideoCapture subsystem.
   */
  function start() {
    _started = true;
  }

  /**
   * Stop the VideoCapture subsystem: stop stream, clear timers, remove listeners.
   */
  function stop() {
    _started = false;
    _stopCurrentStream();
    _clearReEnumerateTimer();
    _status = 'disconnected';
    _currentDeviceId = '';
    _currentLabel = '';

    if (_deviceChangeHandler && typeof navigator !== 'undefined' && navigator.mediaDevices) {
      navigator.mediaDevices.removeEventListener('devicechange', _deviceChangeHandler);
    }
  }

  /**
   * Get the current status of the VideoCapture subsystem.
   * @returns {{ deviceId: string, label: string, status: string }}
   */
  function getStatus() {
    return {
      deviceId: _currentDeviceId,
      label: _currentLabel,
      status: _status
    };
  }

  return {
    init: init,
    enumerateDevices: enumerateDevices,
    selectDevice: selectDevice,
    getFrame: getFrame,
    onDeviceLost: onDeviceLost,
    start: start,
    stop: stop,
    getStatus: getStatus
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.VideoCapture = VideoCapture;
}
