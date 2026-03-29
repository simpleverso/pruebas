// video-recorder.js — VideoRecorder
// MediaRecorder-based capture of the composite canvas output.
// Provides: init, setFormat, setQuality, startRecording, stopRecording, getDuration, getEstimatedSize, start, stop
// Requirements: 19.1–19.9

/* global globalThis, ConfigManager */
var VideoRecorder = (function () {
  // ---- Constants ----
  var SUPPORTED_FORMATS = ['webm-vp8', 'webm-vp9', 'mp4-h264'];

  var FORMAT_MIME_MAP = {
    'webm-vp8': 'video/webm;codecs=vp8',
    'webm-vp9': 'video/webm;codecs=vp9',
    'mp4-h264': 'video/mp4;codecs=h264'
  };

  // Fallback order when a format is not supported
  var FALLBACK_ORDER = ['webm-vp9', 'webm-vp8', 'mp4-h264'];

  // ---- State ----
  var _canvas = null;
  var _stream = null;
  var _mediaRecorder = null;
  var _chunks = [];
  var _recording = false;
  var _startTime = 0;
  var _format = 'webm-vp9';
  var _resolution = '640x480';
  var _bitrate = 2500000;
  var _source = 'processed'; // 'processed' | 'raw'
  var _running = false;
  var _resolveStop = null;

  // ---- Pure helper: format to MIME type ----
  /**
   * Maps a format string to its MIME type.
   * Exposed as _formatToMimeType for property testing (Property 39).
   * @param {string} format - 'webm-vp8' | 'webm-vp9' | 'mp4-h264'
   * @returns {string} MIME type string
   */
  function _formatToMimeType(format) {
    if (typeof format === 'string' && FORMAT_MIME_MAP.hasOwnProperty(format)) {
      return FORMAT_MIME_MAP[format];
    }
    return '';
  }

  // ---- Pure helper: validate MIME type structure ----
  /**
   * Checks if a MIME type string is structurally valid.
   * A valid MIME type has the form "type/subtype" optionally followed by ";params".
   * Exposed as _isValidMimeType for property testing (Property 39).
   * @param {string} mimeType
   * @returns {boolean}
   */
  function _isValidMimeType(mimeType) {
    if (typeof mimeType !== 'string' || mimeType.length === 0) return false;
    // Split on semicolon to separate type/subtype from parameters
    var parts = mimeType.split(';');
    var typeSubtype = parts[0].trim();
    // Must have exactly one slash separating type and subtype
    var slashParts = typeSubtype.split('/');
    if (slashParts.length !== 2) return false;
    var type = slashParts[0].trim();
    var subtype = slashParts[1].trim();
    // Both type and subtype must be non-empty and contain only valid chars
    if (type.length === 0 || subtype.length === 0) return false;
    // Valid MIME type/subtype chars: alphanumeric, hyphen, dot, plus, underscore
    var validPattern = /^[a-zA-Z0-9\-\.\+_]+$/;
    return validPattern.test(type) && validPattern.test(subtype);
  }

  // ---- Config persistence helpers ----
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var config = ConfigManager.load();
        if (config && config.recording) {
          var r = config.recording;
          if (SUPPORTED_FORMATS.indexOf(r.format) !== -1) _format = r.format;
          if (typeof r.resolution === 'string' && r.resolution.length > 0) _resolution = r.resolution;
          if (typeof r.bitrate === 'number' && r.bitrate > 0) _bitrate = r.bitrate;
        }
      } catch (e) { /* ignore */ }
    }
  }

  function _saveConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var config = ConfigManager.load();
        config.recording = config.recording || {};
        config.recording.format = _format;
        config.recording.resolution = _resolution;
        config.recording.bitrate = _bitrate;
        ConfigManager.save(config);
      } catch (e) { /* ignore */ }
    }
  }

  // ---- Internal helpers ----

  /**
   * Resolve the best supported MIME type, starting from the preferred format
   * and falling back through the fallback order.
   * @param {string} preferredFormat
   * @returns {{ format: string, mimeType: string } | null}
   */
  function _resolveSupportedFormat(preferredFormat) {
    // Try preferred first
    var mime = _formatToMimeType(preferredFormat);
    if (mime && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return { format: preferredFormat, mimeType: mime };
    }
    // Fallback through order
    for (var i = 0; i < FALLBACK_ORDER.length; i++) {
      var fmt = FALLBACK_ORDER[i];
      if (fmt === preferredFormat) continue; // already tried
      var m = _formatToMimeType(fmt);
      if (m && typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
        return { format: fmt, mimeType: m };
      }
    }
    return null;
  }

  /**
   * Trigger a file download from a Blob.
   * @param {Blob} blob
   * @param {string} filename
   */
  function _downloadBlob(blob, filename) {
    if (typeof document === 'undefined') return;
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Generate a filename for the recording.
   * @returns {string}
   */
  function _generateFilename() {
    var ext = _format.startsWith('mp4') ? 'mp4' : 'webm';
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    return 'recording-' + ts + '.' + ext;
  }

  // ---- Public API ----

  /**
   * Initialize the video recorder with a canvas element.
   * @param {HTMLCanvasElement} canvas
   */
  function init(canvas) {
    _canvas = canvas;
    _loadConfig();
  }

  /**
   * Set the recording format.
   * @param {'webm-vp8' | 'webm-vp9' | 'mp4-h264'} format
   */
  function setFormat(format) {
    if (SUPPORTED_FORMATS.indexOf(format) !== -1) {
      _format = format;
      _saveConfig();
    }
  }

  /**
   * Set the recording quality.
   * @param {{ resolution: string, bitrate: number }} config
   */
  function setQuality(config) {
    if (config) {
      if (typeof config.resolution === 'string' && config.resolution.length > 0) {
        _resolution = config.resolution;
      }
      if (typeof config.bitrate === 'number' && config.bitrate > 0) {
        _bitrate = config.bitrate;
      }
      _saveConfig();
    }
  }

  /**
   * Start recording from the canvas.
   * @param {'processed' | 'raw'} source - 'processed' captures composite canvas, 'raw' captures unprocessed feed
   */
  function startRecording(source) {
    if (_recording) return;
    if (!_canvas) return;

    _source = source || 'processed';

    // Capture stream from canvas at ≥15 FPS
    _stream = _canvas.captureStream(15);

    // Resolve supported format
    var resolved = _resolveSupportedFormat(_format);
    if (!resolved) {
      // No supported format — cannot record
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('VideoRecorder: No supported recording format available');
      }
      return;
    }

    // If fallback was used, update format and notify
    if (resolved.format !== _format) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('VideoRecorder: Format "' + _format + '" not supported, falling back to "' + resolved.format + '"');
      }
      _format = resolved.format;
      _saveConfig();
    }

    _chunks = [];

    try {
      _mediaRecorder = new MediaRecorder(_stream, {
        mimeType: resolved.mimeType,
        videoBitsPerSecond: _bitrate
      });
    } catch (e) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn('VideoRecorder: Failed to create MediaRecorder', e);
      }
      return;
    }

    _mediaRecorder.ondataavailable = function (event) {
      if (event.data && event.data.size > 0) {
        _chunks.push(event.data);
      }
    };

    _mediaRecorder.onstop = function () {
      var blob = new Blob(_chunks, { type: resolved.mimeType });
      // Prompt download
      _downloadBlob(blob, _generateFilename());

      // Resolve the stop promise
      if (_resolveStop) {
        _resolveStop(blob);
        _resolveStop = null;
      }

      // Cleanup
      _chunks = [];
    };

    _mediaRecorder.start(1000); // collect data every 1s
    _startTime = Date.now();
    _recording = true;
  }

  /**
   * Stop recording and return the recorded Blob.
   * @returns {Promise<Blob>}
   */
  function stopRecording() {
    return new Promise(function (resolve) {
      if (!_recording || !_mediaRecorder) {
        resolve(new Blob([]));
        return;
      }

      _resolveStop = resolve;
      _mediaRecorder.stop();
      _recording = false;

      // Release stream tracks
      if (_stream) {
        var tracks = _stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
        _stream = null;
      }

      _mediaRecorder = null;
    });
  }

  /**
   * Get the current recording duration in seconds.
   * @returns {number}
   */
  function getDuration() {
    if (!_recording) return 0;
    return (Date.now() - _startTime) / 1000;
  }

  /**
   * Get the estimated file size in bytes based on bitrate and duration.
   * @returns {number}
   */
  function getEstimatedSize() {
    var durationSec = getDuration();
    // bitrate is in bits per second, convert to bytes
    return Math.floor((_bitrate * durationSec) / 8);
  }

  /**
   * Start the recorder subsystem. Loads config.
   */
  function start() {
    _running = true;
    _loadConfig();
  }

  /**
   * Stop the recorder subsystem. Stops any active recording and cleans up.
   */
  function stop() {
    _running = false;
    if (_recording) {
      // Force stop without waiting for promise
      if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
        try { _mediaRecorder.stop(); } catch (e) { /* ignore */ }
      }
      _recording = false;
    }
    if (_stream) {
      try {
        var tracks = _stream.getTracks();
        for (var i = 0; i < tracks.length; i++) {
          tracks[i].stop();
        }
      } catch (e) { /* ignore */ }
      _stream = null;
    }
    _mediaRecorder = null;
    _chunks = [];
    _resolveStop = null;
  }

  /**
   * Check if currently recording.
   * @returns {boolean}
   */
  function isRecording() {
    return _recording;
  }

  /**
   * Get current state (for testing/debugging).
   */
  function getState() {
    return {
      running: _running,
      recording: _recording,
      format: _format,
      resolution: _resolution,
      bitrate: _bitrate,
      source: _source
    };
  }

  return {
    init: init,
    setFormat: setFormat,
    setQuality: setQuality,
    startRecording: startRecording,
    stopRecording: stopRecording,
    getDuration: getDuration,
    getEstimatedSize: getEstimatedSize,
    start: start,
    stop: stop,
    isRecording: isRecording,
    getState: getState,
    // Exposed for property testing (Property 39)
    _formatToMimeType: _formatToMimeType,
    _isValidMimeType: _isValidMimeType
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.VideoRecorder = VideoRecorder;
}
