// calibration-engine.js — CalibrationEngine
// Orchestrates all calibration routines: movement, light, device response, zoom, centering.
// Provides: calibrateMovement, calibrateLight, calibrateDeviceResponse, calibrateZoom, calibrateCentering, getCalibrationData, applyCalibration, start, stop
// Requirements: 12.1–12.5, 13.1–13.4, 14.1–14.4, 15.1–15.4, 16.1–16.11

/* global globalThis, ConfigManager, SerialController, PTZMovement, BlobTracker, TFDetector, VideoCapture */
var CalibrationEngine = (function () {
  'use strict';

  // ---- Internal state ----
  var _started = false;
  var _activeCalibration = null; // string name of running calibration or null
  var _lightReEvalTimer = null;

  var _calibrationData = {
    movement: null,
    light: null,
    deviceResponse: null,
    zoom: null,
    centering: {
      blob: null,
      tensorflow: null,
      tolerance: 0.05,
      maxIterations: 10
    }
  };

  var _centeringErrorIndicator = null; // { dx, dy, percentX, percentY } for HUD display

  // ---- Config persistence ----

  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg && cfg.calibration) {
          if (cfg.calibration.movement) {
            _calibrationData.movement = cfg.calibration.movement;
          }
          if (cfg.calibration.light) {
            _calibrationData.light = cfg.calibration.light;
          }
          if (cfg.calibration.deviceResponse) {
            _calibrationData.deviceResponse = cfg.calibration.deviceResponse;
          }
          if (cfg.calibration.zoom) {
            _calibrationData.zoom = cfg.calibration.zoom;
          }
          if (cfg.calibration.centering) {
            if (cfg.calibration.centering.blob) {
              _calibrationData.centering.blob = cfg.calibration.centering.blob;
            }
            if (cfg.calibration.centering.tensorflow) {
              _calibrationData.centering.tensorflow = cfg.calibration.centering.tensorflow;
            }
            if (typeof cfg.calibration.centering.tolerance === 'number') {
              _calibrationData.centering.tolerance = cfg.calibration.centering.tolerance;
            }
            if (typeof cfg.calibration.centering.maxIterations === 'number') {
              _calibrationData.centering.maxIterations = cfg.calibration.centering.maxIterations;
            }
          }
        }
      } catch (_) { /* ignore */ }
    }
  }

  function _persistConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var cfg = ConfigManager.load();
        cfg.calibration = {
          movement: _calibrationData.movement,
          light: _calibrationData.light,
          deviceResponse: _calibrationData.deviceResponse,
          zoom: _calibrationData.zoom,
          centering: {
            blob: _calibrationData.centering.blob,
            tensorflow: _calibrationData.centering.tensorflow,
            tolerance: _calibrationData.centering.tolerance,
            maxIterations: _calibrationData.centering.maxIterations
          }
        };
        ConfigManager.save(cfg);
      } catch (_) { /* ignore */ }
    }
  }

  // ---- Pure-function internals (exposed for property tests) ----

  /**
   * Compute the median of an array of numbers.
   * Property 29: Calibration median aggregation
   * @param {number[]} values
   * @returns {number}
   */
  function _computeMedian(values) {
    if (!values || values.length === 0) return 0;
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
  }

  /**
   * Compute the arithmetic mean of an array of numbers.
   * Property 30: Calibration average aggregation
   * @param {number[]} values
   * @returns {number}
   */
  function _computeAverage(values) {
    if (!values || values.length === 0) return 0;
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
    }
    return sum / values.length;
  }


  /**
   * Compute mean luminance from RGBA pixel data.
   * Luminance = 0.299*R + 0.587*G + 0.114*B for each pixel.
   * Property 31: Mean luminance computation
   * @param {Uint8Array|Uint8ClampedArray} pixelData - RGBA pixel data
   * @param {number} width
   * @param {number} height
   * @returns {number} mean luminance (0–255)
   */
  function _computeMeanLuminance(pixelData, width, height) {
    if (!pixelData || width <= 0 || height <= 0) return 0;
    var totalPixels = width * height;
    var expectedLength = totalPixels * 4;
    // Use actual pixel count based on data length if shorter
    var pixelCount = Math.min(totalPixels, Math.floor(pixelData.length / 4));
    if (pixelCount === 0) return 0;

    var sum = 0;
    for (var i = 0; i < pixelCount; i++) {
      var offset = i * 4;
      var r = pixelData[offset];
      var g = pixelData[offset + 1];
      var b = pixelData[offset + 2];
      sum += 0.299 * r + 0.587 * g + 0.114 * b;
    }
    return sum / pixelCount;
  }

  /**
   * Check if mean luminance is below a threshold (low-light condition).
   * Property 32: Low-light notification threshold
   * @param {number} meanLuminance
   * @param {number} threshold
   * @returns {boolean} true if luminance is below threshold
   */
  function _isLowLight(meanLuminance, threshold) {
    return meanLuminance < threshold;
  }

  /**
   * Compute predictive lead offset: velocity * latency.
   * Property 33: Predictive lead offset
   * @param {number} velocity - pixels per frame (or per second)
   * @param {number} latencyMs - device response latency in milliseconds
   * @returns {number} lead offset in same units as velocity * latencyMs
   */
  function _computePredictiveOffset(velocity, latencyMs) {
    return velocity * latencyMs;
  }

  /**
   * Interpolate zoom sensitivity from a lookup table.
   * Linear interpolation between the two nearest calibrated entries.
   * Property 34: Zoom sensitivity interpolation
   * @param {Array<{zoomLevel: number, sensitivityMultiplier: number}>} lookupTable - sorted by zoomLevel
   * @param {number} zoomLevel
   * @returns {number} interpolated sensitivity multiplier
   */
  function _interpolateZoomSensitivity(lookupTable, zoomLevel) {
    if (!lookupTable || lookupTable.length === 0) return 1.0;
    if (lookupTable.length === 1) return lookupTable[0].sensitivityMultiplier;

    // Sort by zoomLevel to be safe
    var sorted = lookupTable.slice().sort(function (a, b) { return a.zoomLevel - b.zoomLevel; });

    // Clamp to table bounds
    if (zoomLevel <= sorted[0].zoomLevel) return sorted[0].sensitivityMultiplier;
    if (zoomLevel >= sorted[sorted.length - 1].zoomLevel) return sorted[sorted.length - 1].sensitivityMultiplier;

    // Find the two bracketing entries
    for (var i = 0; i < sorted.length - 1; i++) {
      if (zoomLevel >= sorted[i].zoomLevel && zoomLevel <= sorted[i + 1].zoomLevel) {
        var low = sorted[i];
        var high = sorted[i + 1];
        var range = high.zoomLevel - low.zoomLevel;
        if (range === 0) return low.sensitivityMultiplier;
        var t = (zoomLevel - low.zoomLevel) / range;
        return low.sensitivityMultiplier + t * (high.sensitivityMultiplier - low.sensitivityMultiplier);
      }
    }

    return sorted[sorted.length - 1].sensitivityMultiplier;
  }

  /**
   * Compute centering offset: how much pan/tilt command to send to center an object.
   * Property 35: Centering offset computation
   * @param {{ x: number, y: number }} objectCentroid
   * @param {{ x: number, y: number }} frameCenter
   * @param {{ pixelsPerUnitPan: number, pixelsPerUnitTilt: number }} calibrationRatios
   * @returns {{ panCommand: number, tiltCommand: number, dx: number, dy: number }}
   */
  function _computeCenteringOffset(objectCentroid, frameCenter, calibrationRatios) {
    var dx = objectCentroid.x - frameCenter.x;
    var dy = objectCentroid.y - frameCenter.y;

    var panCommand = 0;
    var tiltCommand = 0;

    if (calibrationRatios && calibrationRatios.pixelsPerUnitPan !== 0) {
      panCommand = dx / calibrationRatios.pixelsPerUnitPan;
    }
    if (calibrationRatios && calibrationRatios.pixelsPerUnitTilt !== 0) {
      tiltCommand = dy / calibrationRatios.pixelsPerUnitTilt;
    }

    return {
      panCommand: panCommand,
      tiltCommand: tiltCommand,
      dx: dx,
      dy: dy
    };
  }

  /**
   * Simulate centering iteration convergence.
   * Each iteration reduces offset by correctionFactor. Stops when within tolerance or maxIterations.
   * Property 36: Centering iteration convergence
   * @param {number} initialOffset - initial pixel offset from center (absolute)
   * @param {number} correctionFactor - fraction of offset corrected per iteration (0–1)
   * @param {number} iterations - maximum iterations
   * @param {number} tolerance - acceptable remaining offset (as fraction of initial, 0–1)
   * @returns {{ finalOffset: number, iterationsUsed: number, converged: boolean }}
   */
  function _simulateCenteringIteration(initialOffset, correctionFactor, iterations, tolerance) {
    var offset = Math.abs(initialOffset);
    var toleranceAbs = Math.abs(initialOffset) * tolerance;
    var maxIter = iterations > 0 ? iterations : 10;
    var cf = Math.max(0, Math.min(1, correctionFactor));

    var i;
    for (i = 0; i < maxIter; i++) {
      if (offset <= toleranceAbs) {
        return { finalOffset: offset, iterationsUsed: i, converged: true };
      }
      offset = offset * (1 - cf);
    }

    return {
      finalOffset: offset,
      iterationsUsed: i,
      converged: offset <= toleranceAbs
    };
  }


  // ---- Luminance histogram helper ----

  /**
   * Compute a luminance histogram (256 bins) from RGBA pixel data.
   * @param {Uint8Array|Uint8ClampedArray} pixelData
   * @param {number} width
   * @param {number} height
   * @returns {number[]} histogram of 256 bins
   */
  function _computeHistogram(pixelData, width, height) {
    var histogram = new Array(256);
    for (var h = 0; h < 256; h++) histogram[h] = 0;
    var pixelCount = Math.min(width * height, Math.floor(pixelData.length / 4));
    for (var i = 0; i < pixelCount; i++) {
      var offset = i * 4;
      var lum = Math.round(0.299 * pixelData[offset] + 0.587 * pixelData[offset + 1] + 0.114 * pixelData[offset + 2]);
      lum = Math.max(0, Math.min(255, lum));
      histogram[lum]++;
    }
    return histogram;
  }

  /**
   * Compute an optimal binarization threshold from mean luminance.
   * Uses a simple heuristic: threshold = meanLuminance * 0.8 (clamped 10–245).
   * @param {number} meanLuminance
   * @returns {number}
   */
  function _computeAdaptiveThreshold(meanLuminance) {
    var threshold = Math.round(meanLuminance * 0.8);
    return Math.max(10, Math.min(245, threshold));
  }


  // ---- Capture helper ----

  /**
   * Capture a frame from VideoCapture if available.
   * Returns ImageData or null.
   */
  function _captureFrame() {
    if (typeof VideoCapture !== 'undefined' && VideoCapture.getFrame) {
      try {
        return VideoCapture.getFrame();
      } catch (_) { /* ignore */ }
    }
    return null;
  }

  /**
   * Measure pixel displacement between two frames by comparing a reference region.
   * Simple approach: compute centroid of bright pixels in both frames and return delta.
   * @param {ImageData} frameBefore
   * @param {ImageData} frameAfter
   * @returns {{ dx: number, dy: number }}
   */
  function _measureDisplacement(frameBefore, frameAfter) {
    if (!frameBefore || !frameAfter) return { dx: 0, dy: 0 };
    var centroidBefore = _frameCentroid(frameBefore);
    var centroidAfter = _frameCentroid(frameAfter);
    return {
      dx: centroidAfter.x - centroidBefore.x,
      dy: centroidAfter.y - centroidBefore.y
    };
  }

  /**
   * Compute centroid of bright pixels (luminance > 128) in an ImageData.
   */
  function _frameCentroid(imageData) {
    var data = imageData.data;
    var w = imageData.width;
    var h = imageData.height;
    var sumX = 0, sumY = 0, count = 0;
    var pixelCount = w * h;
    for (var i = 0; i < pixelCount; i++) {
      var off = i * 4;
      var lum = 0.299 * data[off] + 0.587 * data[off + 1] + 0.114 * data[off + 2];
      if (lum > 128) {
        sumX += (i % w);
        sumY += Math.floor(i / w);
        count++;
      }
    }
    if (count === 0) return { x: w / 2, y: h / 2 };
    return { x: sumX / count, y: sumY / count };
  }


  // ---- Calibration routines ----

  /**
   * Movement calibration (Req 12.1–12.5):
   * Send known pan command, measure pixel displacement, compute pixels-per-command-unit.
   * Repeat 3+ times, use median. Report failure if zero displacement.
   * @returns {Promise<{pixelsPerUnitPan: number, pixelsPerUnitTilt: number}>}
   */
  function calibrateMovement() {
    _activeCalibration = 'movement';
    var panMeasurements = [];
    var tiltMeasurements = [];
    var repetitions = 5;

    function measureAxis(axis, measurements) {
      var chain = Promise.resolve();
      for (var r = 0; r < repetitions; r++) {
        chain = chain.then(function () {
          var frameBefore = _captureFrame();
          var command = axis === 'pan' ? 'pan-right' : 'tilt-down';
          var sendPromise = Promise.resolve(false);
          if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
            sendPromise = PTZMovement.sendManualCommand(command);
          }
          return sendPromise.then(function () {
            return new Promise(function (resolve) { setTimeout(resolve, 200); });
          }).then(function () {
            var frameAfter = _captureFrame();
            var disp = _measureDisplacement(frameBefore, frameAfter);
            var val = axis === 'pan' ? Math.abs(disp.dx) : Math.abs(disp.dy);
            measurements.push(val);
            // Send stop
            if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
              return PTZMovement.sendManualCommand('stop');
            }
          }).then(function () {
            return new Promise(function (resolve) { setTimeout(resolve, 100); });
          });
        });
      }
      return chain;
    }

    return measureAxis('pan', panMeasurements)
      .then(function () { return measureAxis('tilt', tiltMeasurements); })
      .then(function () {
        var medianPan = _computeMedian(panMeasurements);
        var medianTilt = _computeMedian(tiltMeasurements);

        if (medianPan === 0 && medianTilt === 0) {
          _activeCalibration = null;
          return Promise.reject(new Error('Movement calibration failed: zero displacement detected. Verify serial connection and camera movement.'));
        }

        var result = {
          pixelsPerUnitPan: medianPan,
          pixelsPerUnitTilt: medianTilt
        };
        _calibrationData.movement = result;
        _persistConfig();
        _activeCalibration = null;
        return result;
      })
      .catch(function (err) {
        _activeCalibration = null;
        throw err;
      });
  }


  /**
   * Light calibration (Req 13.1–13.4):
   * Capture sample frames, compute mean luminance and histogram,
   * adjust binarization threshold, set up periodic re-evaluation.
   * @param {object} [opts] - { minLuminanceThreshold, autoExposure, sampleCount }
   * @returns {Promise<{meanLuminance: number, adjustedThreshold: number, histogram: number[], lowLightWarning: boolean}>}
   */
  function calibrateLight(opts) {
    _activeCalibration = 'light';
    opts = opts || {};
    var minThreshold = typeof opts.minLuminanceThreshold === 'number' ? opts.minLuminanceThreshold : 30;
    var autoExposure = opts.autoExposure !== false;
    var sampleCount = typeof opts.sampleCount === 'number' ? opts.sampleCount : 5;

    var luminanceValues = [];
    var lastHistogram = null;

    function captureSamples(count) {
      var chain = Promise.resolve();
      for (var s = 0; s < count; s++) {
        chain = chain.then(function () {
          var frame = _captureFrame();
          if (frame && frame.data) {
            var lum = _computeMeanLuminance(frame.data, frame.width, frame.height);
            luminanceValues.push(lum);
            lastHistogram = _computeHistogram(frame.data, frame.width, frame.height);
          }
          return new Promise(function (resolve) { setTimeout(resolve, 100); });
        });
      }
      return chain;
    }

    return captureSamples(sampleCount).then(function () {
      var meanLum = _computeAverage(luminanceValues);
      var threshold = _computeAdaptiveThreshold(meanLum);
      var lowLight = _isLowLight(meanLum, minThreshold);

      var result = {
        meanLuminance: meanLum,
        adjustedThreshold: threshold,
        histogram: lastHistogram || [],
        lowLightWarning: lowLight
      };

      _calibrationData.light = {
        meanLuminance: meanLum,
        adjustedThreshold: threshold
      };
      _persistConfig();

      // Set up periodic re-evaluation if auto-exposure active
      if (autoExposure) {
        _startLightReEval(minThreshold);
      }

      _activeCalibration = null;
      return result;
    }).catch(function (err) {
      _activeCalibration = null;
      throw err;
    });
  }

  /**
   * Start periodic light re-evaluation every 5 seconds.
   */
  function _startLightReEval(minThreshold) {
    _stopLightReEval();
    _lightReEvalTimer = setInterval(function () {
      var frame = _captureFrame();
      if (frame && frame.data) {
        var lum = _computeMeanLuminance(frame.data, frame.width, frame.height);
        if (_calibrationData.light) {
          var prevLum = _calibrationData.light.meanLuminance;
          var change = Math.abs(lum - prevLum) / (prevLum || 1);
          if (change > 0.10) {
            _calibrationData.light.meanLuminance = lum;
            _calibrationData.light.adjustedThreshold = _computeAdaptiveThreshold(lum);
            _persistConfig();
          }
        }
        if (_isLowLight(lum, minThreshold)) {
          // Low-light warning — could emit event in full system
        }
      }
    }, 5000);
  }

  function _stopLightReEval() {
    if (_lightReEvalTimer !== null) {
      clearInterval(_lightReEvalTimer);
      _lightReEvalTimer = null;
    }
  }


  /**
   * Device response calibration (Req 14.1–14.4):
   * Send movement command, measure time to first frame displacement,
   * average over 5+ cycles, apply predictive lead offset.
   * @param {object} [opts] - { cycles, overrideLatencyMs }
   * @returns {Promise<{latencyMs: number, predictiveOffsetFn: function}>}
   */
  function calibrateDeviceResponse(opts) {
    _activeCalibration = 'deviceResponse';
    opts = opts || {};
    var cycles = typeof opts.cycles === 'number' && opts.cycles >= 5 ? opts.cycles : 5;
    var latencyMeasurements = [];

    function measureCycle() {
      var chain = Promise.resolve();
      for (var c = 0; c < cycles; c++) {
        chain = chain.then(function () {
          var startTime = Date.now();
          var frameBefore = _captureFrame();
          var sendPromise = Promise.resolve(false);
          if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
            sendPromise = PTZMovement.sendManualCommand('pan-right');
          }
          return sendPromise.then(function () {
            // Poll for displacement
            return _pollForDisplacement(frameBefore, startTime, 2000);
          }).then(function (latency) {
            latencyMeasurements.push(latency);
            if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
              return PTZMovement.sendManualCommand('stop');
            }
          }).then(function () {
            return new Promise(function (resolve) { setTimeout(resolve, 200); });
          });
        });
      }
      return chain;
    }

    return measureCycle().then(function () {
      var avgLatency = _computeAverage(latencyMeasurements);

      // Allow operator override
      if (typeof opts.overrideLatencyMs === 'number') {
        avgLatency = opts.overrideLatencyMs;
      }

      var result = {
        latencyMs: avgLatency
      };

      _calibrationData.deviceResponse = { latencyMs: avgLatency };
      _persistConfig();
      _activeCalibration = null;
      return result;
    }).catch(function (err) {
      _activeCalibration = null;
      throw err;
    });
  }

  /**
   * Poll for frame displacement after a command, return latency in ms.
   */
  function _pollForDisplacement(frameBefore, startTime, timeoutMs) {
    return new Promise(function (resolve) {
      var pollInterval = setInterval(function () {
        var elapsed = Date.now() - startTime;
        if (elapsed > timeoutMs) {
          clearInterval(pollInterval);
          resolve(timeoutMs); // timeout — use max as fallback
          return;
        }
        var frameNow = _captureFrame();
        var disp = _measureDisplacement(frameBefore, frameNow);
        if (Math.abs(disp.dx) > 2 || Math.abs(disp.dy) > 2) {
          clearInterval(pollInterval);
          resolve(elapsed);
        }
      }, 16); // ~60Hz polling
    });
  }


  /**
   * Zoom calibration (Req 15.1–15.4):
   * Measure pixel displacement per command at current zoom,
   * build lookup table mapping zoom levels to sensitivity multipliers.
   * @param {object} [opts] - { zoomLevels: number[] }
   * @returns {Promise<{lookupTable: Array<{zoomLevel: number, sensitivityMultiplier: number}>}>}
   */
  function calibrateZoom(opts) {
    _activeCalibration = 'zoom';
    opts = opts || {};
    var zoomLevels = opts.zoomLevels || [1, 2, 4, 8, 16];
    var lookupTable = [];
    var baseDisplacement = null;

    function measureAtZoom(zoomIdx) {
      if (zoomIdx >= zoomLevels.length) return Promise.resolve();

      var zoomLevel = zoomLevels[zoomIdx];
      // Send zoom command to reach this level (simplified — real impl would set zoom)
      return Promise.resolve().then(function () {
        // Measure displacement at this zoom
        var frameBefore = _captureFrame();
        var sendPromise = Promise.resolve(false);
        if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
          sendPromise = PTZMovement.sendManualCommand('pan-right');
        }
        return sendPromise.then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 200); });
        }).then(function () {
          var frameAfter = _captureFrame();
          var disp = _measureDisplacement(frameBefore, frameAfter);
          var displacement = Math.sqrt(disp.dx * disp.dx + disp.dy * disp.dy);

          if (baseDisplacement === null) {
            baseDisplacement = displacement || 1;
          }

          var sensitivity = displacement / baseDisplacement;
          lookupTable.push({
            zoomLevel: zoomLevel,
            sensitivityMultiplier: sensitivity || 1.0
          });

          if (typeof PTZMovement !== 'undefined' && PTZMovement.sendManualCommand) {
            return PTZMovement.sendManualCommand('stop');
          }
        }).then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 100); });
        }).then(function () {
          return measureAtZoom(zoomIdx + 1);
        });
      });
    }

    return measureAtZoom(0).then(function () {
      lookupTable.sort(function (a, b) { return a.zoomLevel - b.zoomLevel; });

      _calibrationData.zoom = { lookupTable: lookupTable };
      _persistConfig();
      _activeCalibration = null;
      return { lookupTable: lookupTable };
    }).catch(function (err) {
      _activeCalibration = null;
      throw err;
    });
  }


  /**
   * Object centering calibration (Req 16.1–16.11):
   * Detect reference object, compute offset from center, send pan/tilt,
   * re-detect, iterate until within tolerance or max iterations.
   * @param {'blob'|'tensorflow'} method
   * @param {object} [opts] - { tolerance, maxIterations }
   * @returns {Promise<{correctionX: number, correctionY: number, iterations: number, converged: boolean, convergenceRate: number}>}
   */
  function calibrateCentering(method, opts) {
    _activeCalibration = 'centering-' + method;
    opts = opts || {};
    var tolerance = typeof opts.tolerance === 'number' ? opts.tolerance : _calibrationData.centering.tolerance;
    var maxIter = typeof opts.maxIterations === 'number' ? opts.maxIterations : _calibrationData.centering.maxIterations;

    var correctionFactors = { x: 1.0, y: 1.0 };
    var iterCount = 0;
    var converged = false;

    function detectObject() {
      if (method === 'tensorflow' && typeof TFDetector !== 'undefined' && TFDetector.detect) {
        var frame = _captureFrame();
        if (!frame) return Promise.resolve(null);
        return TFDetector.detect(frame).then(function (detections) {
          if (detections && detections.length > 0) {
            var d = detections[0];
            return {
              centroid: { x: d.bbox.x + d.bbox.w / 2, y: d.bbox.y + d.bbox.h / 2 },
              frameWidth: frame.width,
              frameHeight: frame.height
            };
          }
          return null;
        });
      }
      // Blob method
      if (typeof BlobTracker !== 'undefined' && BlobTracker.getPrimaryTarget) {
        var target = BlobTracker.getPrimaryTarget();
        var frame2 = _captureFrame();
        if (target && frame2) {
          return Promise.resolve({
            centroid: { x: target.centroid.x, y: target.centroid.y },
            frameWidth: frame2.width,
            frameHeight: frame2.height
          });
        }
      }
      return Promise.resolve(null);
    }

    function iterate() {
      if (iterCount >= maxIter) return Promise.resolve();

      return detectObject().then(function (detection) {
        if (!detection) return;

        var frameCenter = {
          x: detection.frameWidth / 2,
          y: detection.frameHeight / 2
        };

        var ratios = _calibrationData.movement || { pixelsPerUnitPan: 1, pixelsPerUnitTilt: 1 };
        var offset = _computeCenteringOffset(detection.centroid, frameCenter, ratios);

        // Update centering error indicator for HUD display
        _centeringErrorIndicator = {
          dx: offset.dx,
          dy: offset.dy,
          percentX: detection.frameWidth > 0 ? Math.abs(offset.dx) / detection.frameWidth : 0,
          percentY: detection.frameHeight > 0 ? Math.abs(offset.dy) / detection.frameHeight : 0
        };

        // Check if within tolerance
        var errorX = detection.frameWidth > 0 ? Math.abs(offset.dx) / detection.frameWidth : 0;
        var errorY = detection.frameHeight > 0 ? Math.abs(offset.dy) / detection.frameHeight : 0;

        if (errorX <= tolerance && errorY <= tolerance) {
          converged = true;
          return;
        }

        iterCount++;

        // Send corrective command
        var panCmd = offset.panCommand * correctionFactors.x;
        var tiltCmd = offset.tiltCommand * correctionFactors.y;

        var sendPromise = Promise.resolve();
        if (typeof PTZMovement !== 'undefined' && PTZMovement.testCommand) {
          sendPromise = PTZMovement.testCommand('pan', { percent_signed: Math.round(panCmd) })
            .then(function () {
              return PTZMovement.testCommand('tilt', { percent_signed: Math.round(tiltCmd) });
            });
        }

        return sendPromise.then(function () {
          return new Promise(function (resolve) { setTimeout(resolve, 300); });
        }).then(function () {
          // Re-detect and measure remaining offset to update correction factors
          return detectObject();
        }).then(function (newDetection) {
          if (newDetection) {
            var newCenter = { x: newDetection.frameWidth / 2, y: newDetection.frameHeight / 2 };
            var newOffset = _computeCenteringOffset(newDetection.centroid, newCenter,
              _calibrationData.movement || { pixelsPerUnitPan: 1, pixelsPerUnitTilt: 1 });

            // Adjust correction factors based on actual vs expected movement
            if (Math.abs(offset.dx) > 1) {
              var actualCorrectionX = 1 - (Math.abs(newOffset.dx) / Math.abs(offset.dx));
              if (actualCorrectionX > 0 && actualCorrectionX < 2) {
                correctionFactors.x = correctionFactors.x * (1 / Math.max(0.1, actualCorrectionX));
              }
            }
            if (Math.abs(offset.dy) > 1) {
              var actualCorrectionY = 1 - (Math.abs(newOffset.dy) / Math.abs(offset.dy));
              if (actualCorrectionY > 0 && actualCorrectionY < 2) {
                correctionFactors.y = correctionFactors.y * (1 / Math.max(0.1, actualCorrectionY));
              }
            }
          }
          return iterate();
        });
      });
    }

    return iterate().then(function () {
      var result = {
        correctionX: correctionFactors.x,
        correctionY: correctionFactors.y,
        iterations: iterCount,
        converged: converged,
        convergenceRate: maxIter > 0 ? iterCount / maxIter : 0
      };

      _calibrationData.centering[method] = {
        correctionX: correctionFactors.x,
        correctionY: correctionFactors.y
      };
      _persistConfig();
      _activeCalibration = null;
      return result;
    }).catch(function (err) {
      _activeCalibration = null;
      throw err;
    });
  }


  // ---- Data access ----

  /**
   * Get all calibration data.
   * @returns {object} CalibrationData
   */
  function getCalibrationData() {
    return {
      movement: _calibrationData.movement ? {
        pixelsPerUnitPan: _calibrationData.movement.pixelsPerUnitPan,
        pixelsPerUnitTilt: _calibrationData.movement.pixelsPerUnitTilt
      } : null,
      light: _calibrationData.light ? {
        meanLuminance: _calibrationData.light.meanLuminance,
        adjustedThreshold: _calibrationData.light.adjustedThreshold
      } : null,
      deviceResponse: _calibrationData.deviceResponse ? {
        latencyMs: _calibrationData.deviceResponse.latencyMs
      } : null,
      zoom: _calibrationData.zoom ? {
        lookupTable: _calibrationData.zoom.lookupTable.slice()
      } : null,
      centering: {
        blob: _calibrationData.centering.blob ? {
          correctionX: _calibrationData.centering.blob.correctionX,
          correctionY: _calibrationData.centering.blob.correctionY
        } : null,
        tensorflow: _calibrationData.centering.tensorflow ? {
          correctionX: _calibrationData.centering.tensorflow.correctionX,
          correctionY: _calibrationData.centering.tensorflow.correctionY
        } : null,
        tolerance: _calibrationData.centering.tolerance,
        maxIterations: _calibrationData.centering.maxIterations
      }
    };
  }

  /**
   * Apply externally provided calibration data.
   * @param {object} data - CalibrationData
   */
  function applyCalibration(data) {
    if (!data || typeof data !== 'object') return;
    if (data.movement) _calibrationData.movement = data.movement;
    if (data.light) _calibrationData.light = data.light;
    if (data.deviceResponse) _calibrationData.deviceResponse = data.deviceResponse;
    if (data.zoom) _calibrationData.zoom = data.zoom;
    if (data.centering) {
      if (data.centering.blob) _calibrationData.centering.blob = data.centering.blob;
      if (data.centering.tensorflow) _calibrationData.centering.tensorflow = data.centering.tensorflow;
      if (typeof data.centering.tolerance === 'number') _calibrationData.centering.tolerance = data.centering.tolerance;
      if (typeof data.centering.maxIterations === 'number') _calibrationData.centering.maxIterations = data.centering.maxIterations;
    }
    _persistConfig();
  }

  /**
   * Get the current centering error indicator for HUD display.
   * @returns {{ dx: number, dy: number, percentX: number, percentY: number }|null}
   */
  function getCenteringError() {
    return _centeringErrorIndicator;
  }

  /**
   * Get the name of the currently active calibration, or null.
   * @returns {string|null}
   */
  function getActiveCalibration() {
    return _activeCalibration;
  }


  // ---- Lifecycle ----

  /**
   * Start the calibration engine subsystem.
   */
  function start() {
    _loadConfig();
    _started = true;
  }

  /**
   * Stop the calibration engine subsystem.
   */
  function stop() {
    _started = false;
    _activeCalibration = null;
    _stopLightReEval();
    _centeringErrorIndicator = null;
  }

  return {
    // Public API
    calibrateMovement: calibrateMovement,
    calibrateLight: calibrateLight,
    calibrateDeviceResponse: calibrateDeviceResponse,
    calibrateZoom: calibrateZoom,
    calibrateCentering: calibrateCentering,
    getCalibrationData: getCalibrationData,
    applyCalibration: applyCalibration,
    getCenteringError: getCenteringError,
    getActiveCalibration: getActiveCalibration,
    start: start,
    stop: stop,
    // Testable pure-function internals (for property tests)
    _computeMedian: _computeMedian,
    _computeAverage: _computeAverage,
    _computeMeanLuminance: _computeMeanLuminance,
    _isLowLight: _isLowLight,
    _computePredictiveOffset: _computePredictiveOffset,
    _interpolateZoomSensitivity: _interpolateZoomSensitivity,
    _computeCenteringOffset: _computeCenteringOffset,
    _simulateCenteringIteration: _simulateCenteringIteration
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.CalibrationEngine = CalibrationEngine;
}
