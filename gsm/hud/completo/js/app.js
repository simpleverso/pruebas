// app.js — Main Orchestrator
// Initializes and wires all subsystems together. Sets up the main render loop:
// capture frame → skip check → process → detect blobs → match → TF.js → displacement → PTZ → render HUD → recorder
// Provides: init, start, stop (entry point)
// Requirements: 22.2, 22.3, 7.7, 11.10–11.14, 4.3, 4.4

/* global globalThis, ConfigManager, BufferPool, VideoCapture, FrameSkipper, FrameProcessor,
   BlobTracker, ObjectMatcher, TFDetector, SerialController, TemplateEngine, PTZMovement,
   MultiDeviceRules, GamepadInput, CalibrationEngine, HUDRenderer, VideoRecorder, LifecycleManager */

var App = (function () {
  'use strict';

  // ---- State ----
  var _running = false;
  var _rafId = null;
  var _frameIndex = 0;
  var _lastFrameTime = 0;
  var _fps = 0;
  var _fpsCounter = 0;
  var _fpsTimer = 0;
  var _autoTrackEnabled = false;
  var _trackedBlobs = [];
  var _detections = [];
  var _lastProcessedFrame = null;
  var _displayFrame = null;
  var _primaryTargetId = null;

  // Multi-ROI tracking
  var _manualTargets = [];       // Array of manual ROI targets (each has id, boundingBox, centroid, velocity, _template, _color)
  var _focusedTargetIndex = 0;   // Index into _manualTargets for the currently focused target
  var _templateMode = 'color';   // 'color' or 'grayscale'
  var _templateSize = 16;        // 16, 32, 42, 64, or 0 (original)
  var _cameraTransform = null;   // { mirrorH, mirrorV, angle } when camera-only mode

  // ROI selection state
  var _roiSelecting = false;
  var _roiMode = false;
  var _roiStart = null;
  var _roiRect = null;

  // TF.js offscreen canvas for inference at native resolution
  var _tfCanvas = null;
  var _tfCtx = null;

  // Gamepad button → RS232 command mappings
  var _buttonMappings = []; // Array of { buttonIndex, command, portId, enabled }
  var _showMovementData = false;

  // ---- DOM element references ----
  var _canvas = null;

  // ---- Template matching helpers ----

  /**
   * Extract a grayscale patch from RGBA ImageData.
   */
  function _extractGrayPatch(imageData, px, py, pw, ph) {
    var data = imageData.data;
    var fw = imageData.width;
    var patch = new Float32Array(pw * ph);
    for (var y = 0; y < ph; y++) {
      for (var x = 0; x < pw; x++) {
        var si = ((py + y) * fw + (px + x)) * 4;
        patch[y * pw + x] = 0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2];
      }
    }
    return patch;
  }

  /**
   * Extract a color (RGB) patch from RGBA ImageData. 3 values per pixel.
   */
  function _extractColorPatch(imageData, px, py, pw, ph) {
    var data = imageData.data;
    var fw = imageData.width;
    var patch = new Float32Array(pw * ph * 3);
    for (var y = 0; y < ph; y++) {
      for (var x = 0; x < pw; x++) {
        var si = ((py + y) * fw + (px + x)) * 4;
        var di = (y * pw + x) * 3;
        patch[di] = data[si];
        patch[di + 1] = data[si + 1];
        patch[di + 2] = data[si + 2];
      }
    }
    return patch;
  }

  /**
   * Extract a patch based on current template mode.
   */
  function _extractPatch(imageData, px, py, pw, ph) {
    if (_templateMode === 'color') {
      return _extractColorPatch(imageData, px, py, pw, ph);
    }
    return _extractGrayPatch(imageData, px, py, pw, ph);
  }

  /**
   * NCC score for grayscale template.
   */
  function _nccScore(fdata, fw, rx, ry, tpl, tw, th) {
    var n = tw * th;
    var sumF = 0, sumT = 0, sumFF = 0, sumTT = 0, sumFT = 0;
    for (var y = 0; y < th; y++) {
      for (var x = 0; x < tw; x++) {
        var si = ((ry + y) * fw + (rx + x)) * 4;
        var f = 0.299 * fdata[si] + 0.587 * fdata[si + 1] + 0.114 * fdata[si + 2];
        var t = tpl[y * tw + x];
        sumF += f; sumT += t; sumFF += f * f; sumTT += t * t; sumFT += f * t;
      }
    }
    var meanF = sumF / n, meanT = sumT / n;
    var varF = sumFF / n - meanF * meanF;
    var varT = sumTT / n - meanT * meanT;
    if (varF < 1 || varT < 1) return 0;
    return (sumFT / n - meanF * meanT) / (Math.sqrt(varF) * Math.sqrt(varT));
  }

  /**
   * NCC score for color (RGB) template. Averages NCC across 3 channels.
   */
  function _nccScoreColor(fdata, fw, rx, ry, tpl, tw, th) {
    var n = tw * th;
    var scores = [0, 0, 0];
    for (var c = 0; c < 3; c++) {
      var sumF = 0, sumT = 0, sumFF = 0, sumTT = 0, sumFT = 0;
      for (var y = 0; y < th; y++) {
        for (var x = 0; x < tw; x++) {
          var si = ((ry + y) * fw + (rx + x)) * 4 + c;
          var f = fdata[si];
          var t = tpl[(y * tw + x) * 3 + c];
          sumF += f; sumT += t; sumFF += f * f; sumTT += t * t; sumFT += f * t;
        }
      }
      var meanF = sumF / n, meanT = sumT / n;
      var varF = sumFF / n - meanF * meanF;
      var varT = sumTT / n - meanT * meanT;
      if (varF < 1 || varT < 1) { scores[c] = 0; continue; }
      scores[c] = (sumFT / n - meanF * meanT) / (Math.sqrt(varF) * Math.sqrt(varT));
    }
    return (scores[0] + scores[1] + scores[2]) / 3;
  }

  /**
   * Compute NCC based on template mode.
   */
  function _matchScore(fdata, fw, rx, ry, target, tw, th) {
    if (target._color) {
      return _nccScoreColor(fdata, fw, rx, ry, target._template, tw, th);
    }
    return _nccScore(fdata, fw, rx, ry, target._template, tw, th);
  }

  /**
   * Fast downsampled NCC — samples every 2nd pixel in both x and y (4x fewer samples).
   */
  function _matchScoreFast(fdata, fw, rx, ry, target, tw, th) {
    var tpl = target._template;
    var isColor = target._color;
    var n = 0;
    var sumF = 0, sumT = 0, sumFF = 0, sumTT = 0, sumFT = 0;

    if (isColor) {
      for (var y = 0; y < th; y += 2) {
        for (var x = 0; x < tw; x += 2) {
          for (var c = 0; c < 3; c++) {
            var si = ((ry + y) * fw + (rx + x)) * 4 + c;
            var f = fdata[si];
            var t = tpl[(y * tw + x) * 3 + c];
            sumF += f; sumT += t; sumFF += f * f; sumTT += t * t; sumFT += f * t;
            n++;
          }
        }
      }
    } else {
      for (var y2 = 0; y2 < th; y2 += 2) {
        for (var x2 = 0; x2 < tw; x2 += 2) {
          var si2 = ((ry + y2) * fw + (rx + x2)) * 4;
          var f2 = 0.299 * fdata[si2] + 0.587 * fdata[si2 + 1] + 0.114 * fdata[si2 + 2];
          var t2 = tpl[y2 * tw + x2];
          sumF += f2; sumT += t2; sumFF += f2 * f2; sumTT += t2 * t2; sumFT += f2 * t2;
          n++;
        }
      }
    }

    if (n < 4) return 0;
    var meanF = sumF / n, meanT = sumT / n;
    var varF = sumFF / n - meanF * meanF;
    var varT = sumTT / n - meanT * meanT;
    if (varF < 1 || varT < 1) return 0;
    return (sumFT / n - meanF * meanT) / (Math.sqrt(varF) * Math.sqrt(varT));
  }

  /**
   * Extract a downsampled NxN patch from a region of the frame.
   * Samples N×N evenly spaced points from the tw×th region.
   */
  function _extractDownsampled(imageData, px, py, tw, th, N, isColor) {
    var data = imageData.data;
    var fw = imageData.width;
    var channels = isColor ? 3 : 1;
    var patch = new Float32Array(N * N * channels);
    var stepX = tw / N;
    var stepY = th / N;
    for (var y = 0; y < N; y++) {
      var srcY = Math.min(Math.round(py + y * stepY), imageData.height - 1);
      for (var x = 0; x < N; x++) {
        var srcX = Math.min(Math.round(px + x * stepX), fw - 1);
        var si = (srcY * fw + srcX) * 4;
        if (isColor) {
          var di = (y * N + x) * 3;
          patch[di] = data[si];
          patch[di + 1] = data[si + 1];
          patch[di + 2] = data[si + 2];
        } else {
          patch[y * N + x] = 0.299 * data[si] + 0.587 * data[si + 1] + 0.114 * data[si + 2];
        }
      }
    }
    return patch;
  }

  /**
   * NCC between a fixed NxN template and a downsampled NxN region of the frame.
   * Cost is always N*N*channels — independent of ROI size.
   */
  function _ncc16(fdata, fw, rx, ry, tw, th, tpl, N, isColor) {
    var channels = isColor ? 3 : 1;
    var n = N * N * channels;
    var sumF = 0, sumT = 0, sumFF = 0, sumTT = 0, sumFT = 0;
    var stepX = tw / N;
    var stepY = th / N;
    for (var y = 0; y < N; y++) {
      var srcY = ry + Math.round(y * stepY);
      for (var x = 0; x < N; x++) {
        var srcX = rx + Math.round(x * stepX);
        var si = (srcY * fw + srcX) * 4;
        if (isColor) {
          for (var c = 0; c < 3; c++) {
            var f = fdata[si + c];
            var t = tpl[(y * N + x) * 3 + c];
            sumF += f; sumT += t; sumFF += f * f; sumTT += t * t; sumFT += f * t;
          }
        } else {
          var fg = 0.299 * fdata[si] + 0.587 * fdata[si + 1] + 0.114 * fdata[si + 2];
          var tg = tpl[y * N + x];
          sumF += fg; sumT += tg; sumFF += fg * fg; sumTT += tg * tg; sumFT += fg * tg;
        }
      }
    }
    if (n < 4) return 0;
    var meanF = sumF / n, meanT = sumT / n;
    var varF = sumFF / n - meanF * meanF;
    var varT = sumTT / n - meanT * meanT;
    if (varF < 1 || varT < 1) return 0;
    return (sumFT / n - meanF * meanT) / (Math.sqrt(varF) * Math.sqrt(varT));
  }

  // ---- Helpers ----

  /**
   * Safely call a function, catching and logging errors.
   */
  function _safe(fn, context) {
    try {
      return fn();
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[App] Error in ' + (context || 'unknown') + ':', e);
      }
      return undefined;
    }
  }

  /**
   * Safely call an async function, catching and logging errors.
   */
  function _safeAsync(fn, context) {
    try {
      return Promise.resolve(fn()).catch(function (e) {
        if (typeof console !== 'undefined' && console.error) {
          console.error('[App] Async error in ' + (context || 'unknown') + ':', e);
        }
      });
    } catch (e) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[App] Error in ' + (context || 'unknown') + ':', e);
      }
      return Promise.resolve();
    }
  }


  // ---- UI Wiring ----

  /**
   * Wire webcam device selection UI.
   */
  function _wireWebcamUI() {
    var select = document.getElementById('webcam-select');
    if (!select) return;

    VideoCapture.enumerateDevices().then(function (devices) {
      // Clear existing options beyond the placeholder
      while (select.options.length > 1) select.remove(1);
      for (var i = 0; i < devices.length; i++) {
        var opt = document.createElement('option');
        opt.value = devices[i].deviceId;
        opt.textContent = devices[i].label || ('Camera ' + i);
        select.appendChild(opt);
      }
      // Select current device
      var status = VideoCapture.getStatus();
      if (status.deviceId) select.value = status.deviceId;
    });

    select.addEventListener('change', function () {
      if (select.value) {
        _safeAsync(function () { return VideoCapture.selectDevice(select.value); }, 'webcam-select');
      }
    });
  }

  /**
   * Wire serial port selection UI.
   */
  function _wireSerialUI() {
    var select = document.getElementById('serial-select');
    var connectBtn = document.getElementById('serial-connect-btn');
    if (!select) return;

    SerialController.enumeratePorts().then(function (ports) {
      while (select.options.length > 1) select.remove(1);
      for (var i = 0; i < ports.length; i++) {
        var opt = document.createElement('option');
        opt.value = ports[i].portId;
        opt.textContent = ports[i].name || ('Port ' + i);
        select.appendChild(opt);
      }
    });

    if (connectBtn) {
      connectBtn.addEventListener('click', function () {
        if (select.value) {
          _safeAsync(function () { return SerialController.connect(select.value); }, 'serial-connect');
        }
      });
    }
  }

  /**
   * Wire processing pipeline UI controls.
   */
  function _wirePipelineUI() {
    var ops = [];
    var checkboxes = {
      'op-grayscale': 'grayscale',
      'op-binarize': 'binarize',
      'op-sobel': 'sobel',
      'op-canny': 'canny'
    };

    function updatePipeline() {
      ops = [];
      var keys = Object.keys(checkboxes);
      for (var i = 0; i < keys.length; i++) {
        var el = document.getElementById(keys[i]);
        if (el && el.checked) {
          ops.push({ type: checkboxes[keys[i]], params: _getPipelineParams() });
        }
      }
      FrameProcessor.setPipeline(ops);
    }

    var keys = Object.keys(checkboxes);
    for (var i = 0; i < keys.length; i++) {
      var el = document.getElementById(keys[i]);
      if (el) el.addEventListener('change', updatePipeline);
    }

    // Parameter sliders
    var thresholdEl = document.getElementById('threshold-input');
    if (thresholdEl) {
      thresholdEl.addEventListener('input', function () {
        FrameProcessor.updateParameter('binarize', 'threshold', parseInt(thresholdEl.value, 10));
      });
    }

    var cannyLowEl = document.getElementById('canny-low');
    if (cannyLowEl) {
      cannyLowEl.addEventListener('input', function () {
        FrameProcessor.updateParameter('canny', 'lowThreshold', parseInt(cannyLowEl.value, 10));
      });
    }

    var cannyHighEl = document.getElementById('canny-high');
    if (cannyHighEl) {
      cannyHighEl.addEventListener('input', function () {
        FrameProcessor.updateParameter('canny', 'highThreshold', parseInt(cannyHighEl.value, 10));
      });
    }

    // Frame skip toggle and interval
    var skipToggle = document.getElementById('frame-skip-toggle');
    if (skipToggle) {
      skipToggle.addEventListener('change', function () {
        FrameSkipper.setEnabled(skipToggle.checked);
      });
    }

    var skipInterval = document.getElementById('frame-skip-interval');
    if (skipInterval) {
      skipInterval.addEventListener('change', function () {
        FrameSkipper.setInterval(parseInt(skipInterval.value, 10));
      });
    }
  }

  function _getPipelineParams() {
    var params = {};
    var thresholdEl = document.getElementById('threshold-input');
    if (thresholdEl) params.threshold = parseInt(thresholdEl.value, 10);
    var cannyLowEl = document.getElementById('canny-low');
    if (cannyLowEl) params.lowThreshold = parseInt(cannyLowEl.value, 10);
    var cannyHighEl = document.getElementById('canny-high');
    if (cannyHighEl) params.highThreshold = parseInt(cannyHighEl.value, 10);
    return params;
  }

  /**
   * Wire tracking panel UI.
   */
  function _wireTrackingUI() {
    // Template mode selector
    var templateModeEl = document.getElementById('template-mode');
    if (templateModeEl) {
      templateModeEl.addEventListener('change', function () {
        _templateMode = templateModeEl.value;
      });
    }

    // Template resolution selector
    var templateSizeEl = document.getElementById('template-size');
    if (templateSizeEl) {
      templateSizeEl.addEventListener('change', function () {
        _templateSize = parseInt(templateSizeEl.value, 10);
        // Force re-capture of templates at new size
        for (var i = 0; i < _manualTargets.length; i++) {
          _manualTargets[i]._tpl16 = null;
          _manualTargets[i]._tplSize = null;
        }
      });
    }

    var deadZoneEl = document.getElementById('dead-zone');
    if (deadZoneEl) {
      deadZoneEl.addEventListener('change', function () {
        PTZMovement.setDeadZoneRadius(parseInt(deadZoneEl.value, 10));
      });
    }

    // TF.js toggle — sync checkbox to actual state on load
    var tfToggle = document.getElementById('tf-toggle');
    if (tfToggle) {
      // Force disabled on startup (Req: disabled by default)
      TFDetector.stop();
      _detections.length = 0;
      tfToggle.checked = false;

      tfToggle.addEventListener('change', function () {
        if (tfToggle.checked) {
          TFDetector.start();
        } else {
          TFDetector.stop();
          _detections.length = 0; // Clear overlays immediately
        }
      });
    }

    var tfConfidence = document.getElementById('tf-confidence');
    if (tfConfidence) {
      tfConfidence.addEventListener('change', function () {
        TFDetector.setConfidenceThreshold(parseInt(tfConfidence.value, 10) / 100);
      });
    }

    var tfInterval = document.getElementById('tf-interval');
    if (tfInterval) {
      tfInterval.addEventListener('change', function () {
        TFDetector.setInferenceInterval(parseInt(tfInterval.value, 10));
      });
    }

    // Show movement data toggle
    var showMovEl = document.getElementById('show-movement-data');
    if (showMovEl) {
      showMovEl.addEventListener('change', function () {
        _showMovementData = showMovEl.checked;
      });
    }

    // Auto-track toggle (checkbox in PTZ panel)
    var autoTrackToggle = document.getElementById('auto-track-toggle');
    if (autoTrackToggle) {
      autoTrackToggle.addEventListener('change', function () {
        _autoTrackEnabled = autoTrackToggle.checked;
        PTZMovement.setMode(_autoTrackEnabled ? 'auto' : 'manual');
        _syncTrackingButtons();
      });
    }

    // Start/Stop tracking buttons
    var startBtn = document.getElementById('tracking-start');
    var stopBtn = document.getElementById('tracking-stop');

    if (startBtn) {
      startBtn.addEventListener('click', function () {
        _autoTrackEnabled = true;
        PTZMovement.setMode('auto');
        BlobTracker.start();
        _syncTrackingButtons();
        if (autoTrackToggle) autoTrackToggle.checked = true;
      });
    }

    if (stopBtn) {
      stopBtn.addEventListener('click', function () {
        _autoTrackEnabled = false;
        _primaryTargetId = null;
        _manualTargets = [];
        _focusedTargetIndex = 0;
        _trackedBlobs = [];
        PTZMovement.setMode('manual');
        _syncTrackingButtons();
        _updateTargetCountDisplay();
        if (autoTrackToggle) autoTrackToggle.checked = false;
      });
    }
  }


  /**
   * Wire on-screen manual PTZ controls.
   */
  function _wirePTZControls() {
    var commands = {
      'ptz-up': 'tilt-up',
      'ptz-down': 'tilt-down',
      'ptz-left': 'pan-left',
      'ptz-right': 'pan-right',
      'ptz-stop': 'stop',
      'ptz-zoom-in': 'zoom-in',
      'ptz-zoom-out': 'zoom-out'
    };

    var ids = Object.keys(commands);
    for (var i = 0; i < ids.length; i++) {
      (function (id, cmd) {
        var btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener('mousedown', function () {
            _safeAsync(function () { return PTZMovement.sendManualCommand(cmd); }, 'ptz-' + cmd);
          });
          btn.addEventListener('mouseup', function () {
            if (cmd !== 'stop') {
              _safeAsync(function () { return PTZMovement.sendManualCommand('stop'); }, 'ptz-stop');
            }
          });
        }
      })(ids[i], commands[ids[i]]);
    }

    // Speed level selector
    var speedEl = document.getElementById('speed-level');
    if (speedEl) {
      speedEl.addEventListener('change', function () {
        PTZMovement.setSpeedLevel(speedEl.value);
      });
    }
  }

  /**
   * Wire RS232 command template configuration panel.
   */
  function _wireSerialConfigUI() {
    var varTypeEl = document.getElementById('var-type');
    var tplPan = document.getElementById('tpl-pan');
    var tplTilt = document.getElementById('tpl-tilt');
    var tplZoom = document.getElementById('tpl-zoom');
    var tplStop = document.getElementById('tpl-stop');
    var saveBtn = document.getElementById('tpl-save');
    var testVal = document.getElementById('tpl-test-val');

    // Load current config into fields
    var config = ConfigManager.load();
    if (varTypeEl && config.ptz) varTypeEl.value = config.ptz.variableType || 'percent';
    if (tplPan && config.serial && config.serial.commandTemplates) tplPan.value = config.serial.commandTemplates.pan || '';
    if (tplTilt && config.serial && config.serial.commandTemplates) tplTilt.value = config.serial.commandTemplates.tilt || '';
    if (tplZoom && config.serial && config.serial.commandTemplates) tplZoom.value = config.serial.commandTemplates.zoom || '';
    if (tplStop && config.serial && config.serial.commandTemplates) tplStop.value = config.serial.commandTemplates.stop || '';

    if (varTypeEl) {
      varTypeEl.addEventListener('change', function () {
        var cfg = ConfigManager.load();
        cfg.ptz.variableType = varTypeEl.value;
        ConfigManager.save(cfg);
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var cfg = ConfigManager.load();
        if (!cfg.serial.commandTemplates) cfg.serial.commandTemplates = {};
        cfg.serial.commandTemplates.pan = tplPan ? tplPan.value : '';
        cfg.serial.commandTemplates.tilt = tplTilt ? tplTilt.value : '';
        cfg.serial.commandTemplates.zoom = tplZoom ? tplZoom.value : '';
        cfg.serial.commandTemplates.stop = tplStop ? tplStop.value : '';
        ConfigManager.save(cfg);
      });
    }

    // Test buttons
    var testActions = { 'tpl-test-pan': 'pan', 'tpl-test-tilt': 'tilt', 'tpl-test-zoom': 'zoom' };
    var actionKeys = Object.keys(testActions);
    for (var i = 0; i < actionKeys.length; i++) {
      (function (btnId, action) {
        var btn = document.getElementById(btnId);
        if (btn) {
          btn.addEventListener('click', function () {
            var val = testVal ? parseInt(testVal.value, 10) : 50;
            var vars = { percent: val, percent_signed: val, angle: val, angle_delta: val, steps: val, speed: Math.min(val, 255), direction: action === 'zoom' ? 'in' : 'right' };
            _safeAsync(function () {
              return PTZMovement.sendTestCommand(action, vars);
            }, 'testCommand');
          });
        }
      })(actionKeys[i], testActions[actionKeys[i]]);
    }
  }

  /**
   * Wire gamepad button → RS232 command mappings panel.
   */
  function _wireButtonMappingsUI() {
    var listEl = document.getElementById('btn-mapping-list');
    var addBtn = document.getElementById('btn-mapping-add');
    var tpl = document.getElementById('btn-mapping-template');
    if (!listEl || !addBtn || !tpl) return;

    // Load saved mappings from config
    var config = ConfigManager.load();
    if (config.buttonMappings && Array.isArray(config.buttonMappings)) {
      _buttonMappings = config.buttonMappings;
      for (var i = 0; i < _buttonMappings.length; i++) {
        _addMappingRow(_buttonMappings[i], i);
      }
    }

    addBtn.addEventListener('click', function () {
      var mapping = { buttonIndex: -1, command: '', portId: '', enabled: true };
      _buttonMappings.push(mapping);
      _addMappingRow(mapping, _buttonMappings.length - 1);
      _saveButtonMappings();
    });

    function _addMappingRow(mapping, idx) {
      var clone = tpl.content.cloneNode(true);
      var row = clone.querySelector('.btn-mapping-row');
      var idxSpan = row.querySelector('.btn-idx');
      var detectBtn = row.querySelector('.btn-detect');
      var cmdInput = row.querySelector('.btn-cmd');
      var portSelect = row.querySelector('.btn-port');
      var enabledCb = row.querySelector('.btn-enabled');
      var removeBtn = row.querySelector('.btn-remove');

      idxSpan.textContent = mapping.buttonIndex >= 0 ? String(mapping.buttonIndex) : '--';
      cmdInput.value = mapping.command || '';
      enabledCb.checked = mapping.enabled !== false;

      // Detect button press
      var detecting = false;
      detectBtn.addEventListener('click', function () {
        if (detecting) return;
        detecting = true;
        detectBtn.textContent = 'PRESS...';
        var pollId = setInterval(function () {
          var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
          for (var g = 0; g < gamepads.length; g++) {
            if (!gamepads[g]) continue;
            for (var b = 0; b < gamepads[g].buttons.length; b++) {
              if (gamepads[g].buttons[b].pressed) {
                mapping.buttonIndex = b;
                idxSpan.textContent = String(b);
                detectBtn.textContent = 'DETECT';
                detecting = false;
                clearInterval(pollId);
                _saveButtonMappings();
                return;
              }
            }
          }
        }, 50);
        // Timeout after 5 seconds
        setTimeout(function () {
          if (detecting) {
            detecting = false;
            detectBtn.textContent = 'DETECT';
            clearInterval(pollId);
          }
        }, 5000);
      });

      cmdInput.addEventListener('change', function () {
        mapping.command = cmdInput.value;
        _saveButtonMappings();
      });

      enabledCb.addEventListener('change', function () {
        mapping.enabled = enabledCb.checked;
        _saveButtonMappings();
      });

      removeBtn.addEventListener('click', function () {
        var mIdx = _buttonMappings.indexOf(mapping);
        if (mIdx !== -1) _buttonMappings.splice(mIdx, 1);
        row.remove();
        _saveButtonMappings();
      });

      listEl.appendChild(clone);
    }

    function _saveButtonMappings() {
      var cfg = ConfigManager.load();
      cfg.buttonMappings = _buttonMappings.map(function (m) {
        return { buttonIndex: m.buttonIndex, command: m.command, portId: m.portId, enabled: m.enabled };
      });
      ConfigManager.save(cfg);
    }
  }

  /**
   * Process button mappings each frame — send RS232 commands on button press (rising edge).
   */
  var _prevMappedButtons = {};
  function _processButtonMappings() {
    if (_buttonMappings.length === 0) return;
    var gamepads = navigator.getGamepads ? navigator.getGamepads() : [];
    var gp = null;
    for (var g = 0; g < gamepads.length; g++) {
      if (gamepads[g]) { gp = gamepads[g]; break; }
    }
    if (!gp) return;

    for (var i = 0; i < _buttonMappings.length; i++) {
      var m = _buttonMappings[i];
      if (!m.enabled || m.buttonIndex < 0 || !m.command) continue;
      var pressed = gp.buttons[m.buttonIndex] && gp.buttons[m.buttonIndex].pressed;
      var prevKey = 'btn_' + m.buttonIndex + '_' + i;
      var wasPressed = _prevMappedButtons[prevKey] || false;

      if (pressed && !wasPressed) {
        // Rising edge — send the command
        _safeAsync(function () {
          return SerialController.sendRaw(m.command);
        }, 'btnMapping_' + m.buttonIndex);
      }
      _prevMappedButtons[prevKey] = pressed;
    }
  }

  /**
   * Wire calibration panel controls.
   */
  function _wireCalibrationUI() {
    var calButtons = {
      'cal-movement': function () { return CalibrationEngine.calibrateMovement(); },
      'cal-light': function () { return CalibrationEngine.calibrateLight(); },
      'cal-response': function () { return CalibrationEngine.calibrateDeviceResponse(); },
      'cal-zoom': function () { return CalibrationEngine.calibrateZoom(); },
      'cal-centering-blob': function () { return CalibrationEngine.calibrateCentering('blob'); },
      'cal-centering-tf': function () { return CalibrationEngine.calibrateCentering('tensorflow'); }
    };

    var ids = Object.keys(calButtons);
    for (var i = 0; i < ids.length; i++) {
      (function (id, fn) {
        var btn = document.getElementById(id);
        if (btn) {
          btn.addEventListener('click', function () {
            var statusEl = document.getElementById('cal-status');
            if (statusEl) statusEl.textContent = 'RUNNING...';
            _safeAsync(fn, 'calibration-' + id).then(function () {
              if (statusEl) statusEl.textContent = 'DONE';
            });
          });
        }
      })(ids[i], calButtons[ids[i]]);
    }
  }

  /**
   * Wire recording panel controls.
   */
  function _wireRecordingUI() {
    var recStartBtn = document.getElementById('rec-start');
    var recStopBtn = document.getElementById('rec-stop');
    var recFormatEl = document.getElementById('rec-format');

    if (recFormatEl) {
      recFormatEl.addEventListener('change', function () {
        VideoRecorder.setFormat(recFormatEl.value.replace('/', '-'));
      });
    }

    if (recStartBtn) {
      recStartBtn.addEventListener('click', function () {
        _startRecording();
      });
    }

    if (recStopBtn) {
      recStopBtn.addEventListener('click', function () {
        _stopRecording();
      });
    }
  }

  function _startRecording() {
    VideoRecorder.startRecording('processed');
    var recStartBtn = document.getElementById('rec-start');
    var recStopBtn = document.getElementById('rec-stop');
    var recIndicator = document.getElementById('rec-indicator');
    if (recStartBtn) recStartBtn.disabled = true;
    if (recStopBtn) recStopBtn.disabled = false;
    if (recIndicator) recIndicator.style.display = 'inline';
  }

  function _stopRecording() {
    VideoRecorder.stopRecording();
    var recStartBtn = document.getElementById('rec-start');
    var recStopBtn = document.getElementById('rec-stop');
    var recIndicator = document.getElementById('rec-indicator');
    if (recStartBtn) recStartBtn.disabled = false;
    if (recStopBtn) recStopBtn.disabled = true;
    if (recIndicator) recIndicator.style.display = 'none';
  }

  /**
   * Wire HUD display controls (reticle style, grid preset, opacity, thickness).
   */
  function _wireDisplayUI() {
    var reticleStyle = document.getElementById('reticle-style');
    var reticleOpacity = document.getElementById('reticle-opacity');
    var reticleThickness = document.getElementById('reticle-thickness');
    var gridPreset = document.getElementById('grid-preset');
    var gridN = document.getElementById('grid-n');
    var gridOpacity = document.getElementById('grid-opacity');
    var gridThickness = document.getElementById('grid-thickness');

    if (reticleStyle) {
      reticleStyle.addEventListener('change', function () {
        HUDRenderer.setReticleStyle(reticleStyle.value);
      });
    }
    if (reticleOpacity) {
      reticleOpacity.addEventListener('input', function () {
        HUDRenderer.setReticleConfig({ opacity: parseInt(reticleOpacity.value, 10) });
      });
    }
    if (reticleThickness) {
      reticleThickness.addEventListener('input', function () {
        HUDRenderer.setReticleConfig({ thickness: parseInt(reticleThickness.value, 10) });
      });
    }
    if (gridPreset) {
      gridPreset.addEventListener('change', function () {
        HUDRenderer.setGridPreset(gridPreset.value);
      });
    }
    if (gridN) {
      gridN.addEventListener('change', function () {
        HUDRenderer.setGridConfig({ gridN: parseInt(gridN.value, 10) });
      });
    }
    if (gridOpacity) {
      gridOpacity.addEventListener('input', function () {
        HUDRenderer.setGridConfig({ opacity: parseInt(gridOpacity.value, 10) });
      });
    }
    if (gridThickness) {
      gridThickness.addEventListener('input', function () {
        HUDRenderer.setGridConfig({ thickness: parseInt(gridThickness.value, 10) });
      });
    }

    var reticleColor = document.getElementById('reticle-color');
    if (reticleColor) {
      reticleColor.addEventListener('input', function () {
        HUDRenderer.setReticleConfig({ color: reticleColor.value });
      });
    }

    var gridColor = document.getElementById('grid-color');
    if (gridColor) {
      gridColor.addEventListener('input', function () {
        HUDRenderer.setGridConfig({ color: gridColor.value });
      });
    }

    // Mirror and rotate controls
    var mirrorH = document.getElementById('mirror-h');
    var mirrorV = document.getElementById('mirror-v');
    var rotateAngle = document.getElementById('rotate-angle');
    var cameraOnlyCb = document.getElementById('transform-camera-only');

    function _applyTransform() {
      if (!_canvas) return;
      var isCameraOnly = cameraOnlyCb && cameraOnlyCb.checked;

      if (isCameraOnly) {
        // Camera-only mode: clear CSS transform, store settings for render loop
        _canvas.style.transform = '';
        _cameraTransform = {
          mirrorH: mirrorH && mirrorH.checked,
          mirrorV: mirrorV && mirrorV.checked,
          angle: rotateAngle ? parseInt(rotateAngle.value, 10) : 0
        };
      } else {
        // Full mode: apply CSS transform to entire canvas (video + overlays)
        _cameraTransform = null;
        var transforms = [];
        if (mirrorH && mirrorH.checked) transforms.push('scaleX(-1)');
        if (mirrorV && mirrorV.checked) transforms.push('scaleY(-1)');
        var angle = rotateAngle ? parseInt(rotateAngle.value, 10) : 0;
        if (angle) transforms.push('rotate(' + angle + 'deg)');
        _canvas.style.transform = transforms.length > 0 ? transforms.join(' ') : '';
      }
    }

    if (mirrorH) mirrorH.addEventListener('change', _applyTransform);
    if (mirrorV) mirrorV.addEventListener('change', _applyTransform);
    if (rotateAngle) rotateAngle.addEventListener('change', _applyTransform);
    if (cameraOnlyCb) cameraOnlyCb.addEventListener('change', _applyTransform);
  }

  /**
   * Wire config import/export buttons.
   */
  function _wireConfigUI() {
    var exportBtn = document.getElementById('config-export');
    if (exportBtn) {
      exportBtn.addEventListener('click', function () {
        _safe(function () { ConfigManager.exportToFile(); }, 'config-export');
      });
    }

    var importBtn = document.getElementById('config-import-btn');
    var importFile = document.getElementById('config-import-file');
    if (importBtn && importFile) {
      importBtn.addEventListener('click', function () { importFile.click(); });
      importFile.addEventListener('change', function () {
        if (importFile.files && importFile.files[0]) {
          _safeAsync(function () {
            return ConfigManager.importFromFile(importFile.files[0]);
          }, 'config-import');
        }
      });
    }
  }


  // ---- Gamepad Wiring ----

  /**
   * Wire gamepad button mappings and override logic.
   * LB → toggle tracking, RB → lock nearest target, A → start/stop recording
   */
  function _wireGamepad() {
    var selectEl = document.getElementById('gamepad-select');
    var statusEl = document.getElementById('gamepad-status');

    // Populate dropdown with detected gamepads
    function refreshGamepadList() {
      if (!selectEl) return;
      var gamepads = GamepadInput.enumerateGamepads();
      // Keep current selection
      var currentVal = selectEl.value;
      selectEl.innerHTML = '<option value="">-- Auto --</option>';
      for (var i = 0; i < gamepads.length; i++) {
        var opt = document.createElement('option');
        opt.value = String(gamepads[i].index);
        opt.textContent = gamepads[i].name;
        selectEl.appendChild(opt);
      }
      if (currentVal) selectEl.value = currentVal;

      // Update status
      if (statusEl) {
        var state = GamepadInput.getStatus ? GamepadInput.getStatus() : {};
        statusEl.textContent = (state.status || 'none').toUpperCase();
        statusEl.className = 'telemetry-item ' + (state.status === 'connected' ? 'status-nominal' : 'status-warning');
      }
    }

    // Refresh on gamepad connect/disconnect events
    if (typeof window !== 'undefined') {
      window.addEventListener('gamepadconnected', function () {
        setTimeout(refreshGamepadList, 100); // slight delay for API to update
      });
      window.addEventListener('gamepaddisconnected', function () {
        setTimeout(refreshGamepadList, 100);
      });
    }

    // Select a specific gamepad
    if (selectEl) {
      selectEl.addEventListener('change', function () {
        var val = selectEl.value;
        if (val) {
          GamepadInput.selectGamepad(parseInt(val, 10));
        }
      });
    }

    // Initial populate
    refreshGamepadList();

    // Also poll periodically since gamepads may not fire events until a button is pressed
    setInterval(refreshGamepadList, 3000);

    // Override logic: suspend auto-tracking on stick input, resume after hold delay
    GamepadInput.onOverrideStart(function () {
      PTZMovement.setMode('manual');
    });

    GamepadInput.onOverrideEnd(function () {
      if (_autoTrackEnabled) {
        PTZMovement.setMode('auto');
      }
    });
  }

  /**
   * Process gamepad state each frame for button presses and stick commands.
   */
  var _prevGamepadButtons = { toggleTracking: false, lockTarget: false, record: false };

  function _processGamepadFrame() {
    var state = GamepadInput.poll();

    // Edge-detect button presses (rising edge only)
    // LB → cycle focus to previous target
    if (state.buttons.toggleTracking && !_prevGamepadButtons.toggleTracking) {
      if (_manualTargets.length > 1) {
        _focusedTargetIndex = (_focusedTargetIndex - 1 + _manualTargets.length) % _manualTargets.length;
        _setPrimaryTarget(_manualTargets[_focusedTargetIndex].id);
        _updateTargetCountDisplay();
      } else {
        // Fallback: toggle tracking if only 0-1 targets
        _autoTrackEnabled = !_autoTrackEnabled;
        PTZMovement.setMode(_autoTrackEnabled ? 'auto' : 'manual');
        _syncTrackingButtons();
      }
    }

    // RB → cycle focus to next target
    if (state.buttons.lockTarget && !_prevGamepadButtons.lockTarget) {
      if (_manualTargets.length > 1) {
        _focusedTargetIndex = (_focusedTargetIndex + 1) % _manualTargets.length;
        _setPrimaryTarget(_manualTargets[_focusedTargetIndex].id);
        _updateTargetCountDisplay();
      } else {
        _lockNearestTarget();
      }
    }

    // A → start/stop recording
    if (state.buttons.record && !_prevGamepadButtons.record) {
      if (VideoRecorder.isRecording && VideoRecorder.isRecording()) {
        _stopRecording();
      } else {
        _startRecording();
      }
    }

    _prevGamepadButtons.toggleTracking = state.buttons.toggleTracking;
    _prevGamepadButtons.lockTarget = state.buttons.lockTarget;
    _prevGamepadButtons.record = state.buttons.record;

    // If gamepad is overriding, send stick commands as PTZ
    if (GamepadInput.isOverriding()) {
      if (Math.abs(state.panAxis) > 0 || Math.abs(state.tiltAxis) > 0) {
        var cmd = state.panAxis >= 0 ? 'pan-right' : 'pan-left';
        _safeAsync(function () { return PTZMovement.sendManualCommand(cmd); }, 'gamepad-pan');
      }
      if (Math.abs(state.zoomAxis) > 0) {
        var zoomCmd = state.zoomAxis > 0 ? 'zoom-out' : 'zoom-in';
        _safeAsync(function () { return PTZMovement.sendManualCommand(zoomCmd); }, 'gamepad-zoom');
      }
    }
  }

  /**
   * Lock onto the nearest detected blob or TF.js detection as primary target.
   */
  function _lockNearestTarget() {
    // Prefer TF.js detections if available
    if (_detections.length > 0) {
      var d = _detections[0]; // nearest/highest confidence
      // Find the blob closest to this detection's center
      var cx = d.bbox.x + d.bbox.w / 2;
      var cy = d.bbox.y + d.bbox.h / 2;
      var bestBlob = _findNearestBlob(cx, cy);
      if (bestBlob) {
        _setPrimaryTarget(bestBlob.id);
        _autoTrackEnabled = true;
        PTZMovement.setMode('auto');
      }
      return;
    }

    // Fall back to nearest blob to frame center
    if (_trackedBlobs.length > 0 && _canvas) {
      var fcx = _canvas.width / 2;
      var fcy = _canvas.height / 2;
      var nearest = _findNearestBlob(fcx, fcy);
      if (nearest) {
        _setPrimaryTarget(nearest.id);
        _autoTrackEnabled = true;
        PTZMovement.setMode('auto');
      }
    }
  }

  function _findNearestBlob(x, y) {
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < _trackedBlobs.length; i++) {
      var b = _trackedBlobs[i];
      if (!b.centroid) continue;
      var dx = b.centroid.x - x;
      var dy = b.centroid.y - y;
      var dist = dx * dx + dy * dy;
      if (dist < bestDist) {
        bestDist = dist;
        best = b;
      }
    }
    return best;
  }

  // ---- TF.js Detection Click → Adopt as Primary Target ----

  /**
   * Wire ROI (Region of Interest) selection on the canvas.
   * Click-and-drag draws a rectangle; on release, the nearest blob
   * inside the rectangle is set as the primary tracking target.
   */
  function _wireROISelection() {
    if (!_canvas) return;

    var selectBtn = document.getElementById('roi-select-btn');
    var cancelBtn = document.getElementById('roi-cancel-btn');
    var clearAllBtn = document.getElementById('roi-clear-all');
    var templateModeEl = document.getElementById('template-mode');

    // Template mode selector
    if (templateModeEl) {
      templateModeEl.addEventListener('change', function () {
        _templateMode = templateModeEl.value;
      });
    }

    // Clear all ROI targets
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        _manualTargets.length = 0;
        _trackedBlobs.length = 0;
        _primaryTargetId = null;
        _focusedTargetIndex = 0;
        _autoTrackEnabled = false;
        PTZMovement.setMode('manual');
        _syncTrackingButtons();
        _updateTargetCountDisplay();
      });
    }

    if (selectBtn) {
      selectBtn.addEventListener('click', function () {
        _roiMode = true;
        _canvas.style.cursor = 'crosshair';
        selectBtn.disabled = true;
        if (cancelBtn) cancelBtn.disabled = false;
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        _roiMode = false;
        _roiSelecting = false;
        _roiStart = null;
        _roiRect = null;
        _canvas.style.cursor = '';
        if (selectBtn) selectBtn.disabled = false;
        cancelBtn.disabled = true;
      });
    }

    function _canvasCoords(e) {
      var rect = _canvas.getBoundingClientRect();
      var scaleX = _canvas.width / rect.width;
      var scaleY = _canvas.height / rect.height;
      return {
        x: (e.clientX - rect.left) * scaleX,
        y: (e.clientY - rect.top) * scaleY
      };
    }

    _canvas.addEventListener('mousedown', function (e) {
      if (!_roiMode) return;
      e.preventDefault();
      _roiSelecting = true;
      _roiStart = _canvasCoords(e);
      _roiRect = { x: _roiStart.x, y: _roiStart.y, w: 0, h: 0 };
    });

    _canvas.addEventListener('mousemove', function (e) {
      if (!_roiSelecting || !_roiStart) return;
      var pos = _canvasCoords(e);
      _roiRect = {
        x: Math.min(_roiStart.x, pos.x),
        y: Math.min(_roiStart.y, pos.y),
        w: Math.abs(pos.x - _roiStart.x),
        h: Math.abs(pos.y - _roiStart.y)
      };
    });

    _canvas.addEventListener('mouseup', function (e) {
      if (!_roiSelecting || !_roiRect) return;
      _roiSelecting = false;

      // Only process if the rectangle is big enough (at least 10x10 px)
      if (_roiRect.w >= 10 && _roiRect.h >= 10) {
        var cx = _roiRect.x + _roiRect.w / 2;
        var cy = _roiRect.y + _roiRect.h / 2;

        // Try to find an existing blob inside the ROI
        var bestBlob = null;
        var bestDist = Infinity;
        for (var i = 0; i < _trackedBlobs.length; i++) {
          var b = _trackedBlobs[i];
          if (b.centroid.x >= _roiRect.x && b.centroid.x <= _roiRect.x + _roiRect.w &&
              b.centroid.y >= _roiRect.y && b.centroid.y <= _roiRect.y + _roiRect.h) {
            var dx = b.centroid.x - cx;
            var dy = b.centroid.y - cy;
            var dist = dx * dx + dy * dy;
            if (dist < bestDist) {
              bestDist = dist;
              bestBlob = b;
            }
          }
        }

        if (!bestBlob) {
          bestBlob = _findNearestBlob(cx, cy);
        }

        // Always create a new manual ROI target (supports N targets)
        var manualId = Date.now() + Math.random();
        var isColor = (_templateMode === 'color');
        var manualBlob = {
          id: manualId,
          centroid: { x: cx, y: cy },
          boundingBox: { x: _roiRect.x, y: _roiRect.y, w: _roiRect.w, h: _roiRect.h },
          area: _roiRect.w * _roiRect.h,
          velocity: { vx: 0, vy: 0 },
          framesLost: 0,
          descriptor: new Float32Array(0),
          referenceDescriptor: new Float32Array(0),
          pixels: new Uint8Array(0),
          _template: null,
          _color: isColor,
          _roiTarget: true
        };

        // Capture initial template from current frame
        var currentFrame = _displayFrame || _lastProcessedFrame;
        if (currentFrame && currentFrame.data) {
          var rx = Math.max(0, Math.round(_roiRect.x));
          var ry = Math.max(0, Math.round(_roiRect.y));
          var rw = Math.round(_roiRect.w);
          var rh = Math.round(_roiRect.h);
          if (rx + rw <= currentFrame.width && ry + rh <= currentFrame.height) {
            manualBlob._template = _extractPatch(currentFrame, rx, ry, rw, rh);
          }
        }

        _manualTargets.push(manualBlob);
        _trackedBlobs.push(manualBlob);
        _focusedTargetIndex = _manualTargets.length - 1;
        _setPrimaryTarget(manualId);

        _autoTrackEnabled = true;
        PTZMovement.setMode('auto');
        _syncTrackingButtons();
        _updateTargetCountDisplay();
      }

      // Exit ROI mode — but stay in ROI mode if user wants to add more
      _roiRect = null;
      _roiStart = null;
      _roiMode = false;
      _canvas.style.cursor = '';
      if (selectBtn) selectBtn.disabled = false;
      if (cancelBtn) cancelBtn.disabled = true;
    });
  }

  /**
   * Sync tracking start/stop buttons (called from multiple places).
   */
  function _syncTrackingButtons() {
    var startBtn = document.getElementById('tracking-start');
    var stopBtn = document.getElementById('tracking-stop');
    var autoTrackToggle = document.getElementById('auto-track-toggle');
    if (startBtn) startBtn.disabled = _autoTrackEnabled;
    if (stopBtn) stopBtn.disabled = !_autoTrackEnabled;
    if (autoTrackToggle) autoTrackToggle.checked = _autoTrackEnabled;
  }

  function _updateROIStatus() {
    var el = document.getElementById('roi-count');
    if (el) {
      var focusLabel = _manualTargets.length > 0 ? (_focusedTargetIndex + 1) + '/' + _manualTargets.length : '--';
      el.textContent = 'ROI: ' + _manualTargets.length + ' | Focus: ' + focusLabel;
    }
  }

  function _cycleFocus(direction) {
    if (_manualTargets.length === 0) return;
    _focusedTargetIndex = (_focusedTargetIndex + direction + _manualTargets.length) % _manualTargets.length;
    _setPrimaryTarget(_manualTargets[_focusedTargetIndex].id);
    _updateROIStatus();
  }

  /**
   * Set the primary tracking target and track the ID locally.
   */
  function _setPrimaryTarget(id) {
    _primaryTargetId = id;
    BlobTracker.setPrimaryTarget(id);
  }

  function _updateTargetCountDisplay() {
    var total = _manualTargets.length;
    var focused = total > 0 ? (_focusedTargetIndex + 1) : 0;
    var label = total > 0 ? focused + '/' + total : '--';

    var el1 = document.getElementById('target-count');
    if (el1) el1.textContent = 'TARGET: ' + focused + '/' + total;

    var el2 = document.getElementById('roi-count');
    if (el2) el2.textContent = 'ROI: ' + total + ' | Focus: ' + label;
  }

  function _wireTFDetectionClick() {
    if (!_canvas) return;
    _canvas.addEventListener('click', function (e) {
      if (_detections.length === 0) return;
      var rect = _canvas.getBoundingClientRect();
      var scaleX = _canvas.width / rect.width;
      var scaleY = _canvas.height / rect.height;
      var clickX = (e.clientX - rect.left) * scaleX;
      var clickY = (e.clientY - rect.top) * scaleY;

      // Find which detection was clicked
      for (var i = 0; i < _detections.length; i++) {
        var d = _detections[i];
        if (clickX >= d.bbox.x && clickX <= d.bbox.x + d.bbox.w &&
            clickY >= d.bbox.y && clickY <= d.bbox.y + d.bbox.h) {
          // Adopt this detection as primary tracking target
          var cx = d.bbox.x + d.bbox.w / 2;
          var cy = d.bbox.y + d.bbox.h / 2;
          var nearest = _findNearestBlob(cx, cy);
          if (nearest) {
            _setPrimaryTarget(nearest.id);
            _autoTrackEnabled = true;
            PTZMovement.setMode('auto');
          }
          break;
        }
      }
    });
  }


  // ---- Telemetry ----

  /**
   * Build telemetry data object from all subsystem states.
   */
  function _buildTelemetry() {
    var webcamStatus = _safe(function () { return VideoCapture.getStatus(); }, 'telemetry-webcam') || {};
    var serialStatus = _safe(function () { return SerialController.getStatus(); }, 'telemetry-serial') || {};
    var gamepadStatus = _safe(function () { return GamepadInput.getStatus(); }, 'telemetry-gamepad') || {};
    var memInfo = _safe(function () { return LifecycleManager.getMemoryUsage(); }, 'telemetry-memory') || {};

    return {
      fps: _fps,
      processingLatencyMs: 0,
      effectiveProcessingRate: _safe(function () { return FrameSkipper.getEffectiveRate(); }) || 0,
      skipRatio: _safe(function () { return FrameSkipper.getSkipRatio(); }) || '1/1',
      panAngle: 0,
      tiltAngle: 0,
      zoomLevel: 1,
      trackingStatus: _autoTrackEnabled ? (BlobTracker.getPrimaryTarget() ? 'tracking' : 'lost') : 'idle',
      serialStatus: serialStatus.status || 'disconnected',
      webcamStatus: webcamStatus.status || 'disconnected',
      gamepadStatus: gamepadStatus.status || 'none',
      gamepadOverride: _safe(function () { return GamepadInput.isOverriding(); }) || false,
      memoryUsageMB: memInfo.usageMB || 0,
      recordingActive: _safe(function () { return VideoRecorder.isRecording && VideoRecorder.isRecording(); }) || false,
      recordingDuration: _safe(function () { return VideoRecorder.getDuration(); }) || 0,
      recordingSize: _safe(function () { return VideoRecorder.getEstimatedSize(); }) || 0,
      inferenceLatencyMs: _safe(function () { return TFDetector.getLatency(); }) || 0,
      activeRuleCount: _safe(function () { return MultiDeviceRules.getActiveRuleCount(); }) || 0,
      calibrationActive: _safe(function () { return CalibrationEngine.getActiveCalibration(); }) || null,
      // Movement calculation data (shown when toggle is on)
      showMovementData: _showMovementData,
      movementData: _showMovementData ? _buildMovementData() : null
    };
  }

  function _buildMovementData() {
    // Compute displacement from the focused manual target (or BlobTracker fallback)
    var dx = 0, dy = 0;
    var focusedTarget = (_manualTargets.length > 0 && _focusedTargetIndex < _manualTargets.length)
      ? _manualTargets[_focusedTargetIndex] : null;

    if (focusedTarget && focusedTarget.centroid && _canvas) {
      dx = focusedTarget.centroid.x - _canvas.width / 2;
      dy = focusedTarget.centroid.y - _canvas.height / 2;
    } else {
      var displacement = _safe(function () { return BlobTracker.getDisplacement(); }) || null;
      if (displacement) { dx = displacement.dx; dy = displacement.dy; }
    }

    var dist = Math.sqrt(dx * dx + dy * dy);
    var calData = _safe(function () { return CalibrationEngine.getCalibrationData(); }) || {};
    var movCal = calData.movement || null;
    var devCal = calData.deviceResponse || null;
    var zoomCal = calData.zoom || null;
    var centerCal = calData.centering || null;

    // Also show velocity if available
    var vx = focusedTarget ? (focusedTarget.velocity ? focusedTarget.velocity.vx : 0) : 0;
    var vy = focusedTarget ? (focusedTarget.velocity ? focusedTarget.velocity.vy : 0) : 0;

    return {
      dx: dx,
      dy: dy,
      distance: dist,
      vx: vx,
      vy: vy,
      pxPerUnitPan: movCal ? movCal.pixelsPerUnitPan : '--',
      pxPerUnitTilt: movCal ? movCal.pixelsPerUnitTilt : '--',
      latencyMs: devCal ? devCal.latencyMs : '--',
      zoomMultiplier: zoomCal && zoomCal.lookupTable && zoomCal.lookupTable.length > 0 ? zoomCal.lookupTable[0].sensitivityMultiplier : '--',
      centerCorrX: centerCal && centerCal.blob ? centerCal.blob.correctionX : '--',
      centerCorrY: centerCal && centerCal.blob ? centerCal.blob.correctionY : '--',
      targetCount: _manualTargets.length,
      focusedIndex: _manualTargets.length > 0 ? _focusedTargetIndex + 1 : 0
    };
  }

  /**
   * Build status indicators for HUD.
   */
  function _buildStatus() {
    var webcamStatus = _safe(function () { return VideoCapture.getStatus(); }) || {};
    var serialStatus = _safe(function () { return SerialController.getStatus(); }) || {};
    var gamepadStatus = _safe(function () { return GamepadInput.getStatus(); }) || {};

    return {
      serialStatus: serialStatus.status || 'disconnected',
      webcamStatus: webcamStatus.status || 'disconnected',
      gamepadStatus: gamepadStatus.status || 'none'
    };
  }

  /**
   * Update the HTML telemetry bar elements.
   */
  function _updateTelemetryBar(telemetry) {
    _setTextById('tel-fps', 'FPS: ' + telemetry.fps);
    _setTextById('tel-latency', 'LAT: ' + telemetry.processingLatencyMs.toFixed(0) + ' ms');
    _setTextById('tel-skip', 'SKIP: ' + (telemetry.skipRatio === '1/1' ? 'OFF' : telemetry.skipRatio));
    _setTextById('tel-tracking', 'TRK: ' + telemetry.trackingStatus.toUpperCase());
    _setTextById('tel-webcam', 'CAM: ' + telemetry.webcamStatus.toUpperCase());
    _setTextById('tel-serial', 'SER: ' + telemetry.serialStatus.toUpperCase());
    _setTextById('tel-gamepad', 'PAD: ' + telemetry.gamepadStatus.toUpperCase());
    _setTextById('tel-memory', 'MEM: ' + telemetry.memoryUsageMB.toFixed(0) + ' MB');
    _setTextById('tel-inference', 'INF: ' + telemetry.inferenceLatencyMs.toFixed(0) + ' ms');
    _setTextById('tel-rules', 'RULES: ' + telemetry.activeRuleCount);

    var recIndicator = document.getElementById('rec-indicator');
    if (recIndicator) recIndicator.style.display = telemetry.recordingActive ? 'inline' : 'none';

    var gpOverride = document.getElementById('gamepad-override');
    if (gpOverride) gpOverride.style.display = telemetry.gamepadOverride ? 'inline' : 'none';

    // Update recording duration/size
    if (telemetry.recordingActive) {
      _setTextById('rec-duration', _formatDuration(telemetry.recordingDuration));
      _setTextById('rec-size', (telemetry.recordingSize / (1024 * 1024)).toFixed(1) + ' MB');
    }
  }

  function _setTextById(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function _formatDuration(seconds) {
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }


  // ---- Main Render Loop ----

  /**
   * Main render loop: capture frame → skip check → process → detect blobs →
   * match → TF.js → compute displacement → send PTZ commands → render HUD → feed recorder
   */
  function _renderLoop() {
    if (!_running) return;

    _rafId = requestAnimationFrame(_renderLoop);

    // FPS calculation
    var now = performance.now();
    _fpsCounter++;
    if (now - _fpsTimer >= 1000) {
      _fps = _fpsCounter;
      _fpsCounter = 0;
      _fpsTimer = now;
    }

    _frameIndex++;

    // 1. Capture frame from video
    var frame = _safe(function () { return VideoCapture.getFrame(); }, 'getFrame');
    if (!frame || !frame.data || frame.width <= 1) return;

    var width = frame.width;
    var height = frame.height;

    // 2. Frame skip check
    var shouldProcess = FrameSkipper.shouldProcess(_frameIndex);

    if (shouldProcess) {
      // 3. Process frame through pipeline
      var processStart = performance.now();
      var inputBuffer = frame.data.buffer.slice(0);
      var outputSize = width * height; // single-channel output
      var outputBuffer;

      try {
        outputBuffer = BufferPool.acquire();
      } catch (e) {
        // Pool exhausted — skip processing this frame
        outputBuffer = new ArrayBuffer(outputSize);
      }

      var pipelineActive = FrameProcessor.getPipeline && FrameProcessor.getPipeline().length > 0;

      _safe(function () {
        FrameProcessor.processFrame(inputBuffer, outputBuffer, width, height);
      }, 'processFrame');

      var processEnd = performance.now();

      // Convert single-channel processed output to RGBA ImageData for display
      if (pipelineActive) {
        _safe(function () {
          var processed = new Uint8Array(outputBuffer);
          var displayData = new ImageData(width, height);
          var rgba = displayData.data;
          var totalPixels = width * height;
          for (var p = 0; p < totalPixels; p++) {
            var val = processed[p];
            var idx = p * 4;
            rgba[idx]     = val; // R
            rgba[idx + 1] = val; // G
            rgba[idx + 2] = val; // B
            rgba[idx + 3] = 255; // A
          }
          _displayFrame = displayData;
        }, 'convertProcessed');
      } else {
        _displayFrame = frame;
      }

      // Release buffer back to pool
      try { BufferPool.release(outputBuffer); } catch (e) { /* ignore non-pool buffers */ }

      _lastProcessedFrame = _displayFrame || frame;

      // 7. TF.js detection (if enabled, at configured interval)
      _safe(function () {
        if (TFDetector.getState && TFDetector.getState().enabled) {
          // Draw video to an offscreen canvas at native resolution for TF.js
          // This ensures bbox coords match the canvas dimensions exactly
          if (!_tfCanvas) {
            _tfCanvas = document.createElement('canvas');
            _tfCtx = _tfCanvas.getContext('2d');
          }
          var videoEl = document.getElementById('video-source');
          if (videoEl && videoEl.videoWidth > 0) {
            _tfCanvas.width = videoEl.videoWidth;
            _tfCanvas.height = videoEl.videoHeight;
            _tfCtx.drawImage(videoEl, 0, 0, videoEl.videoWidth, videoEl.videoHeight);
            TFDetector.detect(_tfCanvas).then(function (dets) {
              // Only apply if still enabled (user may have toggled off while inference was running)
              if (TFDetector.getState && TFDetector.getState().enabled) {
                _detections = dets || [];
              }
            }).catch(function () {
              // Inference error — continue with blob tracking only
            });
          }
        }
      }, 'tfDetect');

      // 8. Compute displacement and send PTZ commands (auto-tracking)
      if (_autoTrackEnabled && !GamepadInput.isOverriding()) {
        var displacement = _safe(function () { return BlobTracker.getDisplacement(); }, 'getDisplacement');
        if (displacement) {
          _safeAsync(function () {
            return PTZMovement.processAutoTracking(displacement.dx, displacement.dy);
          }, 'autoTracking');

          // Also execute multi-device rules
          _safeAsync(function () {
            var vars = PTZMovement.convertDisplacement(
              displacement.dx, displacement.dy,
              PTZMovement.getVariableType(), PTZMovement.getSpeedLevel()
            );
            return MultiDeviceRules.executeRules('pan', vars.pan).then(function () {
              return MultiDeviceRules.executeRules('tilt', vars.tilt);
            });
          }, 'multiDeviceRules');
        }
      }
    } else {
      // Skipped frame — show raw feed
      _displayFrame = frame;
    }

    // ROI template matching runs EVERY frame regardless of frame skip
    var associatedBlobs = [];
    var TSIZE = _templateSize;
    if (_manualTargets.length > 0 && frame && frame.data) {
      _safe(function () {
        var fdata = frame.data;
        var fw = frame.width;
        var fh = frame.height;

        for (var mti = 0; mti < _manualTargets.length; mti++) {
          var target = _manualTargets[mti];
          var bb = target.boundingBox;
          var tw = Math.round(bb.w);
          var th = Math.round(bb.h);
          if (tw < 4 || th < 4) { associatedBlobs.push(target); continue; }

          var isOriginal = (TSIZE === 0);

          if (!target._tpl16 || target._tplSize !== TSIZE) {
            if (isOriginal) {
              target._tpl16 = _extractPatch(frame, Math.max(0, Math.round(bb.x)), Math.max(0, Math.round(bb.y)), tw, th);
            } else {
              target._tpl16 = _extractDownsampled(frame, Math.round(bb.x), Math.round(bb.y), tw, th, TSIZE, target._color);
            }
            target._tplSize = TSIZE;
          }

          var predX = Math.round(bb.x + (target.velocity.vx || 0));
          var predY = Math.round(bb.y + (target.velocity.vy || 0));
          var margin = Math.max(10, Math.round(Math.max(tw, th) * 0.3));
          var sx = Math.max(0, predX - margin);
          var sy = Math.max(0, predY - margin);
          var sx2 = Math.min(fw - tw, predX + margin);
          var sy2 = Math.min(fh - th, predY + margin);

          var bestScore = -Infinity;
          var bestX = Math.round(bb.x);
          var bestY = Math.round(bb.y);

          if (isOriginal) {
            for (var iy = sy; iy <= sy2; iy += 2) {
              for (var ix = sx; ix <= sx2; ix += 2) {
                var score = _matchScoreFast(fdata, fw, ix, iy, target, tw, th);
                if (score > bestScore) { bestScore = score; bestX = ix; bestY = iy; }
              }
            }
          } else {
            var stepX = Math.max(2, Math.round(tw / TSIZE));
            var stepY = Math.max(2, Math.round(th / TSIZE));
            for (var iy2 = sy; iy2 <= sy2; iy2 += stepY) {
              for (var ix2 = sx; ix2 <= sx2; ix2 += stepX) {
                var score2 = _ncc16(fdata, fw, ix2, iy2, tw, th, target._tpl16, TSIZE, target._color);
                if (score2 > bestScore) { bestScore = score2; bestX = ix2; bestY = iy2; }
              }
            }
          }

          if (bestScore > 0.25) {
            var oldCx = target.centroid.x;
            var oldCy = target.centroid.y;
            var newCx = bestX + tw / 2;
            var newCy = bestY + th / 2;
            target.velocity.vx = newCx - oldCx;
            target.velocity.vy = newCy - oldCy;
            target.centroid.x = newCx;
            target.centroid.y = newCy;
            target.boundingBox.x = bestX;
            target.boundingBox.y = bestY;

            var newTpl;
            if (isOriginal) {
              newTpl = _extractPatch(frame, bestX, bestY, tw, th);
            } else {
              newTpl = _extractDownsampled(frame, bestX, bestY, tw, th, TSIZE, target._color);
            }
            var tpl = target._tpl16;
            for (var ti = 0; ti < tpl.length; ti++) {
              tpl[ti] = 0.85 * tpl[ti] + 0.15 * newTpl[ti];
            }
          }

          associatedBlobs.push(target);
        }
      }, 'templateMatchAll');
    }
    _trackedBlobs = associatedBlobs;

    // 9. Process gamepad input
    _processGamepadFrame();
    _processButtonMappings();

    // 10. Render HUD
    _safe(function () {
      var renderFrame = _displayFrame || frame;

      // Sync canvas dimensions to video frame
      if (_canvas && (renderFrame.width !== _canvas.width || renderFrame.height !== _canvas.height)) {
        _canvas.width = renderFrame.width;
        _canvas.height = renderFrame.height;
      }

      var telemetry = _buildTelemetry();
      var status = _buildStatus();
      var lockOnTarget = BlobTracker.getPrimaryTarget();

      // Mark focused target for highlighted rendering
      var focusedId = (_manualTargets.length > 0 && _focusedTargetIndex < _manualTargets.length)
        ? _manualTargets[_focusedTargetIndex].id : _primaryTargetId;
      for (var bi = 0; bi < _trackedBlobs.length; bi++) {
        _trackedBlobs[bi]._focused = (_trackedBlobs[bi].id === focusedId);
        // Add label showing target index
        for (var mi = 0; mi < _manualTargets.length; mi++) {
          if (_manualTargets[mi].id === _trackedBlobs[bi].id) {
            _trackedBlobs[bi]._label = 'TGT ' + (mi + 1);
            break;
          }
        }
      }

      HUDRenderer.renderFrame(renderFrame, {
        blobs: _trackedBlobs,
        detections: _detections,
        telemetry: telemetry,
        status: status,
        lockOnTarget: lockOnTarget,
        cameraTransform: _cameraTransform
      });

      // Update HTML telemetry bar
      _updateTelemetryBar(telemetry);

      // Draw ROI selection rectangle if dragging
      if (_roiSelecting && _roiRect && _roiRect.w > 0 && _roiRect.h > 0) {
        var ctx = _canvas.getContext('2d');
        ctx.save();
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(_roiRect.x, _roiRect.y, _roiRect.w, _roiRect.h);
        // Draw corner brackets
        var bLen = Math.min(15, _roiRect.w / 4, _roiRect.h / 4);
        ctx.setLineDash([]);
        ctx.lineWidth = 2;
        // Top-left
        ctx.beginPath();
        ctx.moveTo(_roiRect.x, _roiRect.y + bLen);
        ctx.lineTo(_roiRect.x, _roiRect.y);
        ctx.lineTo(_roiRect.x + bLen, _roiRect.y);
        ctx.stroke();
        // Top-right
        ctx.beginPath();
        ctx.moveTo(_roiRect.x + _roiRect.w - bLen, _roiRect.y);
        ctx.lineTo(_roiRect.x + _roiRect.w, _roiRect.y);
        ctx.lineTo(_roiRect.x + _roiRect.w, _roiRect.y + bLen);
        ctx.stroke();
        // Bottom-left
        ctx.beginPath();
        ctx.moveTo(_roiRect.x, _roiRect.y + _roiRect.h - bLen);
        ctx.lineTo(_roiRect.x, _roiRect.y + _roiRect.h);
        ctx.lineTo(_roiRect.x + bLen, _roiRect.y + _roiRect.h);
        ctx.stroke();
        // Bottom-right
        ctx.beginPath();
        ctx.moveTo(_roiRect.x + _roiRect.w - bLen, _roiRect.y + _roiRect.h);
        ctx.lineTo(_roiRect.x + _roiRect.w, _roiRect.y + _roiRect.h);
        ctx.lineTo(_roiRect.x + _roiRect.w, _roiRect.y + _roiRect.h - bLen);
        ctx.stroke();
        ctx.restore();
      }
    }, 'renderHUD');
  }


  // ---- Public API ----

  /**
   * Initialize all subsystems and wire them together.
   * @returns {Promise<void>}
   */
  function init() {
    // 1. Initialize ConfigManager first, load persisted config
    var config = ConfigManager.load();

    // 2. Initialize BufferPool with configured size
    var bufferSize = 1280 * 720 * 4; // RGBA for max expected resolution
    _safe(function () { BufferPool.init(bufferSize, 8); }, 'BufferPool.init');

    // 3. Get canvas reference
    _canvas = document.getElementById('hud-canvas');

    // 4. Initialize FrameSkipper (synchronous)
    // FrameSkipper loads its own config on module init

    // 5. Initialize FrameProcessor with JS fallback (WASM loaded separately if available)
    _safe(function () { FrameProcessor.init(null); }, 'FrameProcessor.init');

    // 6. Initialize BlobTracker
    _safe(function () {
      BlobTracker.init({
        minArea: config.tracker.minArea,
        lostFrameThreshold: config.tracker.lostFrameThreshold,
        spatialWeight: config.tracker.spatialWeight,
        areaWeight: config.tracker.areaWeight
      });
    }, 'BlobTracker.init');

    // 7. Initialize ObjectMatcher
    _safe(function () { ObjectMatcher.configure(config.tracker); }, 'ObjectMatcher.configure');

    // 8. Initialize PTZMovement
    _safe(function () { PTZMovement.init(); }, 'PTZMovement.init');

    // 9. Initialize MultiDeviceRules
    _safe(function () { MultiDeviceRules.init(); }, 'MultiDeviceRules.init');

    // 10. Initialize GamepadInput
    _safe(function () { GamepadInput.init(); }, 'GamepadInput.init');

    // 11. Initialize CalibrationEngine (loads config internally)

    // 12. Initialize HUDRenderer
    if (_canvas) {
      _safe(function () { HUDRenderer.init(_canvas); }, 'HUDRenderer.init');
    }

    // 13. Initialize VideoRecorder
    if (_canvas) {
      _safe(function () { VideoRecorder.init(_canvas); }, 'VideoRecorder.init');
    }

    // 14. Initialize LifecycleManager
    _safe(function () { LifecycleManager.init(); }, 'LifecycleManager.init');

    // Chain async initializations
    return _safeAsync(function () {
      return VideoCapture.init();
    }, 'VideoCapture.init')
    .then(function () {
      return _safeAsync(function () { return SerialController.init(); }, 'SerialController.init');
    })
    .then(function () {
      return _safeAsync(function () { return TFDetector.init(config.tensorflow.backendPreference); }, 'TFDetector.init');
    })
    .then(function () {
      // Wire all UI controls
      _safe(function () { _wireWebcamUI(); }, 'wireWebcamUI');
      _safe(function () { _wireSerialUI(); }, 'wireSerialUI');
      _safe(function () { _wirePipelineUI(); }, 'wirePipelineUI');
      _safe(function () { _wireTrackingUI(); }, 'wireTrackingUI');
      _safe(function () { _wirePTZControls(); }, 'wirePTZControls');
      _safe(function () { _wireCalibrationUI(); }, 'wireCalibrationUI');
      _safe(function () { _wireSerialConfigUI(); }, 'wireSerialConfigUI');
      _safe(function () { _wireButtonMappingsUI(); }, 'wireButtonMappingsUI');
      _safe(function () { _wireRecordingUI(); }, 'wireRecordingUI');
      _safe(function () { _wireConfigUI(); }, 'wireConfigUI');
      _safe(function () { _wireDisplayUI(); }, 'wireDisplayUI');
      _safe(function () { _wireGamepad(); }, 'wireGamepad');
      _safe(function () { _wireTFDetectionClick(); }, 'wireTFDetectionClick');
      _safe(function () { _wireROISelection(); }, 'wireROISelection');
    });
  }

  /**
   * Start all subsystems and begin the main render loop.
   */
  function start() {
    _running = true;
    _frameIndex = 0;
    _fpsTimer = performance.now();
    _fpsCounter = 0;

    // Start all subsystems
    _safe(function () { VideoCapture.start(); }, 'VideoCapture.start');
    _safe(function () { FrameProcessor.start(); }, 'FrameProcessor.start');
    _safe(function () { BlobTracker.start(); }, 'BlobTracker.start');
    _safe(function () { SerialController.start(); }, 'SerialController.start');
    _safe(function () { PTZMovement.start(); }, 'PTZMovement.start');
    _safe(function () { GamepadInput.start(); }, 'GamepadInput.start');
    _safe(function () { CalibrationEngine.start(); }, 'CalibrationEngine.start');
    _safe(function () { HUDRenderer.start(); }, 'HUDRenderer.start');
    _safe(function () { VideoRecorder.start(); }, 'VideoRecorder.start');

    // Start lifecycle manager subsystems
    _safe(function () { LifecycleManager.startSubsystem('Pipeline'); }, 'LM.Pipeline');
    _safe(function () { LifecycleManager.startSubsystem('Tracker'); }, 'LM.Tracker');
    _safe(function () { LifecycleManager.startSubsystem('Serial'); }, 'LM.Serial');

    // Begin render loop
    _renderLoop();
  }

  /**
   * Stop all subsystems and halt the render loop.
   */
  function stop() {
    _running = false;

    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }

    // Stop all subsystems
    _safe(function () { VideoCapture.stop(); }, 'VideoCapture.stop');
    _safe(function () { FrameProcessor.stop(); }, 'FrameProcessor.stop');
    _safe(function () { BlobTracker.stop(); }, 'BlobTracker.stop');
    _safe(function () { TFDetector.stop(); }, 'TFDetector.stop');
    _safe(function () { SerialController.stop(); }, 'SerialController.stop');
    _safe(function () { PTZMovement.stop(); }, 'PTZMovement.stop');
    _safe(function () { GamepadInput.stop(); }, 'GamepadInput.stop');
    _safe(function () { CalibrationEngine.stop(); }, 'CalibrationEngine.stop');
    _safe(function () { HUDRenderer.stop(); }, 'HUDRenderer.stop');
    _safe(function () { VideoRecorder.stop(); }, 'VideoRecorder.stop');

    // Stop all lifecycle-managed subsystems
    _safe(function () { LifecycleManager.stopAll(); }, 'LM.stopAll');

    // Dispose buffer pool
    _safe(function () { BufferPool.dispose(); }, 'BufferPool.dispose');

    _trackedBlobs = [];
    _detections = [];
    _autoTrackEnabled = false;
  }

  return {
    init: init,
    start: start,
    stop: stop
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.App = App;
}

// Auto-initialize when DOM is ready (browser context)
if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', function () {
    App.init().then(function () {
      App.start();
    });
  });
}
