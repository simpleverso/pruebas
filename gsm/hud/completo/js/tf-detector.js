// tf-detector.js — TFDetector
// TensorFlow.js COCO-SSD object detection wrapper.
// Provides: init, loadModel, detect, setCategories, setConfidenceThreshold, setInferenceInterval, getLatency, start, stop, dispose
// Requirements: 7.1–7.11

/* global globalThis, cocoSsd, tf */
var TFDetector = (function () {
  // ---- State ----
  var _model = null;
  var _enabled = false;
  var _categories = [];
  var _confidenceThreshold = 0.5;
  var _inferenceInterval = 3;
  var _backendPreference = ['webgl', 'wasm', 'cpu'];
  var _latencyMs = 0;
  var _frameCount = 0;
  var _modelLoaded = false;
  var _disposed = false;

  // ---- Helpers ----

  /**
   * Load persisted settings from ConfigManager if available.
   */
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var config = ConfigManager.load();
        if (config && config.tensorflow) {
          var tf = config.tensorflow;
          _enabled = !!tf.enabled;
          _categories = Array.isArray(tf.categories) ? tf.categories.slice() : [];
          _confidenceThreshold = typeof tf.confidenceThreshold === 'number' ? tf.confidenceThreshold : 0.5;
          _inferenceInterval = typeof tf.inferenceInterval === 'number' ? tf.inferenceInterval : 5;
          _backendPreference = Array.isArray(tf.backendPreference) ? tf.backendPreference.slice() : ['webgl', 'wasm', 'cpu'];
        }
      } catch (e) {
        // Ignore config load errors
      }
    }
  }

  /**
   * Persist current settings to ConfigManager if available.
   */
  function _saveConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var config = ConfigManager.load();
        config.tensorflow = {
          enabled: _enabled,
          categories: _categories.slice(),
          confidenceThreshold: _confidenceThreshold,
          inferenceInterval: _inferenceInterval,
          backendPreference: _backendPreference.slice()
        };
        ConfigManager.save(config);
      } catch (e) {
        // Ignore config save errors
      }
    }
  }

  /**
   * Try to set the TensorFlow.js backend in preference order.
   * @param {string[]} preferences - e.g. ['webgl', 'wasm', 'cpu']
   * @returns {Promise<string>} The backend that was successfully set.
   */
  function _setBackend(preferences) {
    if (typeof tf === 'undefined' || !tf.setBackend) {
      return Promise.resolve('none');
    }

    var idx = 0;

    function tryNext() {
      if (idx >= preferences.length) {
        return Promise.resolve('cpu');
      }
      var backend = preferences[idx];
      idx++;
      return tf.setBackend(backend).then(function () {
        return tf.ready().then(function () {
          return backend;
        });
      }).catch(function () {
        return tryNext();
      });
    }

    return tryNext();
  }

  /**
   * Filter raw model detections by categories and confidence threshold.
   * @param {Array} rawDetections - Array of { class, score, bbox }
   * @returns {Array} Filtered detections in our Detection format.
   */
  function _filterDetections(rawDetections) {
    var results = [];
    for (var i = 0; i < rawDetections.length; i++) {
      var d = rawDetections[i];
      var score = typeof d.score === 'number' ? d.score : 0;

      // Filter by confidence threshold
      if (score < _confidenceThreshold) {
        continue;
      }

      // Filter by categories (if list is non-empty)
      if (_categories.length > 0) {
        var className = d.class || '';
        var found = false;
        for (var j = 0; j < _categories.length; j++) {
          if (_categories[j] === className) {
            found = true;
            break;
          }
        }
        if (!found) {
          continue;
        }
      }

      // Convert bbox format: COCO-SSD returns [x, y, width, height]
      var bbox = d.bbox || [0, 0, 0, 0];
      results.push({
        class: d.class || 'unknown',
        score: score,
        bbox: {
          x: bbox[0] || 0,
          y: bbox[1] || 0,
          w: bbox[2] || 0,
          h: bbox[3] || 0
        }
      });
    }
    return results;
  }

  // ---- Public API ----

  /**
   * Initialize the TFDetector with backend preference.
   * Sets up the TF.js backend but does NOT load the model yet (lazy loading).
   * @param {string[]} [backendPreference] - e.g. ['webgl', 'wasm', 'cpu']
   * @returns {Promise<void>}
   */
  function init(backendPreference) {
    _disposed = false;
    _loadConfig();

    if (Array.isArray(backendPreference) && backendPreference.length > 0) {
      _backendPreference = backendPreference.slice();
    }

    return _setBackend(_backendPreference).then(function () {
      _saveConfig();
    });
  }

  /**
   * Load the COCO-SSD model. Called lazily on first enable/detect.
   * @returns {Promise<void>}
   */
  function loadModel() {
    if (_modelLoaded && _model) {
      return Promise.resolve();
    }

    // Check if cocoSsd is available (loaded from CDN)
    if (typeof cocoSsd === 'undefined' || !cocoSsd.load) {
      // No TF.js / COCO-SSD available — gracefully degrade
      _model = null;
      _modelLoaded = false;
      return Promise.resolve();
    }

    return cocoSsd.load().then(function (model) {
      _model = model;
      _modelLoaded = true;
    }).catch(function () {
      _model = null;
      _modelLoaded = false;
    });
  }

  /**
   * Run detection on a frame. Filters by categories and confidence threshold.
   * Tracks inference latency. Respects inference interval (every Nth call).
   * @param {ImageData|HTMLVideoElement|HTMLCanvasElement} input
   * @returns {Promise<Detection[]>}
   */
  function detect(input) {
    _frameCount++;

    // Respect inference interval: only run on every Nth frame
    if (_inferenceInterval > 1 && (_frameCount % _inferenceInterval) !== 1) {
      return Promise.resolve([]);
    }

    // If model not loaded, attempt lazy load
    if (!_modelLoaded || !_model) {
      return loadModel().then(function () {
        if (!_model) {
          return [];
        }
        return _runInference(input);
      });
    }

    return _runInference(input);
  }

  /**
   * Internal: run model inference and filter results.
   * @param {ImageData|HTMLVideoElement|HTMLCanvasElement} input
   * @returns {Promise<Detection[]>}
   */
  function _runInference(input) {
    if (!_model || !_model.detect) {
      return Promise.resolve([]);
    }

    var startTime = (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();

    return _model.detect(input).then(function (rawDetections) {
      var endTime = (typeof performance !== 'undefined' && performance.now)
        ? performance.now()
        : Date.now();

      _latencyMs = endTime - startTime;

      return _filterDetections(rawDetections || []);
    }).catch(function () {
      return [];
    });
  }

  /**
   * Set which object categories to detect. Empty array = all categories.
   * @param {string[]} categories
   */
  function setCategories(categories) {
    _categories = Array.isArray(categories) ? categories.slice() : [];
    _saveConfig();
  }

  /**
   * Set minimum confidence threshold (0–1). Default 0.5.
   * @param {number} threshold
   */
  function setConfidenceThreshold(threshold) {
    if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) {
      _confidenceThreshold = threshold;
    }
    _saveConfig();
  }

  /**
   * Set inference interval (run every Nth frame). Default 5.
   * @param {number} n
   */
  function setInferenceInterval(n) {
    if (typeof n === 'number' && n >= 1) {
      _inferenceInterval = Math.floor(n);
    }
    _saveConfig();
  }

  /**
   * Get the last inference latency in milliseconds.
   * @returns {number}
   */
  function getLatency() {
    return _latencyMs;
  }

  /**
   * Enable detection. Triggers lazy model loading.
   */
  function start() {
    _enabled = true;
    _disposed = false;
    _frameCount = 0;
    _saveConfig();

    // Lazy load model on first enable
    if (!_modelLoaded) {
      loadModel();
    }
  }

  /**
   * Disable detection. Disposes model and frees GPU/WebGL textures.
   */
  function stop() {
    _enabled = false;
    _saveConfig();
    dispose();
  }

  /**
   * Dispose model and free GPU/WebGL textures.
   */
  function dispose() {
    if (_model && typeof _model.dispose === 'function') {
      try {
        _model.dispose();
      } catch (e) {
        // Ignore dispose errors
      }
    }
    _model = null;
    _modelLoaded = false;
    _disposed = true;
    _latencyMs = 0;
    _frameCount = 0;
  }

  // ---- Expose internal filter for testing ----

  /**
   * Exposed for testing: filter detections by current categories and threshold.
   * @param {Array} rawDetections - Array of { class, score, bbox }
   * @returns {Array} Filtered Detection[]
   */
  function filterDetections(rawDetections) {
    return _filterDetections(rawDetections);
  }

  /**
   * Get current state (for testing/debugging).
   */
  function getState() {
    return {
      enabled: _enabled,
      modelLoaded: _modelLoaded,
      categories: _categories.slice(),
      confidenceThreshold: _confidenceThreshold,
      inferenceInterval: _inferenceInterval,
      backendPreference: _backendPreference.slice(),
      disposed: _disposed
    };
  }

  return {
    init: init,
    loadModel: loadModel,
    detect: detect,
    setCategories: setCategories,
    setConfidenceThreshold: setConfidenceThreshold,
    setInferenceInterval: setInferenceInterval,
    getLatency: getLatency,
    start: start,
    stop: stop,
    dispose: dispose,
    // Exposed for testing
    filterDetections: filterDetections,
    getState: getState
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.TFDetector = TFDetector;
}
