// hud-renderer.js — HUDRenderer
// Renders all overlay elements: reticle styles, grid presets, blob bounding boxes,
// TF.js detection labels, telemetry, compass, pitch ladder, scan-line effects.
// Provides: init, setReticleStyle, setGridPreset, renderFrame, setReticleConfig, setGridConfig, start, stop
// Requirements: 17.1–17.16, 18.1–18.7

/* global globalThis, ConfigManager */
var HUDRenderer = (function () {
  // ---- Constants ----
  var HUD_GREEN = '#00FF00';
  var HUD_AMBER = '#FFAA00';
  var HUD_RED = '#FF3333';
  var HUD_FONT = '10px "Courier New", monospace';
  var HUD_FONT_LARGE = '12px "Courier New", monospace';

  var VALID_RETICLE_STYLES = ['none', 'crosshair', 'tactical-circle', 'mil-dot', 'bracket'];
  var VALID_GRID_PRESETS = ['thirds', 'center-cross', 'quadrants', 'fine-grid', 'golden-ratio', 'crosshair-only', 'none'];

  // ---- State ----
  var _canvas = null;
  var _ctx = null;
  var _running = false;
  var _rafId = null;

  var _reticleStyle = 'tactical-circle';
  var _reticleOpacity = 80;   // 0–100
  var _reticleThickness = 1;  // 1–3
  var _reticleColor = '#00FF00';

  var _gridPreset = 'none';
  var _gridOpacity = 30;      // 0–100
  var _gridThickness = 1;     // 1–3
  var _gridN = 8;             // 4–16 for fine-grid
  var _gridColor = '#00FF00';

  // Lock-on animation state
  var _lockOnAnim = null;

  // Temp canvas for camera-only transforms
  var _transformCanvas = null;
  var _transformCtx = null; // { startTime, targetBlob, duration }

  // Fade-in animation state for reticle and grid
  var _reticleFade = { active: false, startTime: 0, duration: 800 }; // ms — longer for bracket fly-in
  var _gridFade = { active: false, startTime: 0, duration: 500 };
  var LOCK_ON_DURATION = 400; // ms

  // ---- Config persistence helpers ----
  function _loadConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var config = ConfigManager.load();
        if (config && config.hud) {
          var h = config.hud;
          if (VALID_RETICLE_STYLES.indexOf(h.reticleStyle) !== -1) _reticleStyle = h.reticleStyle;
          if (typeof h.reticleOpacity === 'number') _reticleOpacity = Math.max(0, Math.min(100, h.reticleOpacity));
          if (typeof h.reticleThickness === 'number') _reticleThickness = Math.max(1, Math.min(3, h.reticleThickness));
          if (VALID_GRID_PRESETS.indexOf(h.gridPreset) !== -1) _gridPreset = h.gridPreset;
          if (typeof h.gridOpacity === 'number') _gridOpacity = Math.max(0, Math.min(100, h.gridOpacity));
          if (typeof h.gridThickness === 'number') _gridThickness = Math.max(1, Math.min(3, h.gridThickness));
          if (typeof h.gridN === 'number') _gridN = Math.max(4, Math.min(16, Math.floor(h.gridN)));
        }
      } catch (e) { /* ignore */ }
    }
  }

  function _saveConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load && ConfigManager.save) {
      try {
        var config = ConfigManager.load();
        config.hud = config.hud || {};
        config.hud.reticleStyle = _reticleStyle;
        config.hud.reticleOpacity = _reticleOpacity;
        config.hud.reticleThickness = _reticleThickness;
        config.hud.gridPreset = _gridPreset;
        config.hud.gridOpacity = _gridOpacity;
        config.hud.gridThickness = _gridThickness;
        config.hud.gridN = _gridN;
        ConfigManager.save(config);
      } catch (e) { /* ignore */ }
    }
  }

  // ---- Pure helper: status to color ----
  /**
   * Maps a status string to its HUD color.
   * 'nominal' → green, 'warning' → amber, 'error' → red.
   * Exposed as _statusToColor for property testing (Property 37).
   * @param {string} status
   * @returns {string} CSS color string
   */
  function _statusToColor(status) {
    if (status === 'nominal') return HUD_GREEN;
    if (status === 'warning') return HUD_AMBER;
    if (status === 'error') return HUD_RED;
    return HUD_GREEN; // default to nominal
  }

  // ---- Pure helper: grid preset line count ----
  /**
   * Returns the number of grid lines for a given preset.
   * Exposed as _gridPresetLineCount for property testing (Property 38).
   * thirds=4, center-cross=2, quadrants=2, fine-grid=2*(N-1),
   * golden-ratio=4, crosshair-only=0, none=0.
   * @param {string} preset
   * @param {number} [gridN] - N for fine-grid (4–16)
   * @returns {number}
   */
  function _gridPresetLineCount(preset, gridN) {
    switch (preset) {
      case 'thirds': return 4;
      case 'center-cross': return 2;
      case 'quadrants': return 2;
      case 'fine-grid':
        var n = (typeof gridN === 'number' && gridN >= 4 && gridN <= 16) ? Math.floor(gridN) : 8;
        return 2 * (n - 1);
      case 'golden-ratio': return 4;
      case 'crosshair-only': return 0;
      case 'none': return 0;
      default: return 0;
    }
  }

  // ---- Drawing helpers ----

  /**
   * Set stroke style with opacity (0–100).
   */
  function _setStroke(color, opacity, thickness) {
    _ctx.strokeStyle = color;
    _ctx.globalAlpha = Math.max(0, Math.min(1, opacity / 100));
    _ctx.lineWidth = thickness;
  }

  function _setFill(color, opacity) {
    _ctx.fillStyle = color;
    _ctx.globalAlpha = Math.max(0, Math.min(1, opacity / 100));
  }

  /**
   * Draw L-shaped corner brackets around a bounding box.
   * @param {number} x
   * @param {number} y
   * @param {number} w
   * @param {number} h
   * @param {number} bracketLen - length of each bracket arm
   * @param {string} color
   * @param {number} opacity - 0–100
   * @param {number} thickness
   */
  function _drawCornerBrackets(x, y, w, h, bracketLen, color, opacity, thickness) {
    _setStroke(color, opacity, thickness);
    _ctx.beginPath();
    // Top-left
    _ctx.moveTo(x, y + bracketLen); _ctx.lineTo(x, y); _ctx.lineTo(x + bracketLen, y);
    // Top-right
    _ctx.moveTo(x + w - bracketLen, y); _ctx.lineTo(x + w, y); _ctx.lineTo(x + w, y + bracketLen);
    // Bottom-right
    _ctx.moveTo(x + w, y + h - bracketLen); _ctx.lineTo(x + w, y + h); _ctx.lineTo(x + w - bracketLen, y + h);
    // Bottom-left
    _ctx.moveTo(x + bracketLen, y + h); _ctx.lineTo(x, y + h); _ctx.lineTo(x, y + h - bracketLen);
    _ctx.stroke();
    _ctx.globalAlpha = 1;
  }

  // ---- Reticle renderers ----

  function _renderReticle(w, h) {
    if (_reticleStyle === 'none') return;
    var cx = w / 2;
    var cy = h / 2;

    // Fade-in animation
    var opacityMul = 1;
    if (_reticleFade.active) {
      var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      var elapsed = now - _reticleFade.startTime;
      opacityMul = Math.min(1, elapsed / _reticleFade.duration);
      if (opacityMul >= 1) _reticleFade.active = false;
    }

    _setStroke(_reticleColor, _reticleOpacity * opacityMul, _reticleThickness);

    switch (_reticleStyle) {
      case 'crosshair': _drawCrosshair(cx, cy, w, h); break;
      case 'tactical-circle': _drawTacticalCircle(cx, cy, w, h); break;
      case 'mil-dot': _drawMilDot(cx, cy, w, h); break;
      case 'bracket': _drawBracketReticle(cx, cy, w, h); break;
    }
    _ctx.globalAlpha = 1;
  }

  /** Standard Crosshair: full-width lines + tick marks */
  function _drawCrosshair(cx, cy, w, h) {
    _ctx.beginPath();
    // Horizontal full-width line
    _ctx.moveTo(0, cy); _ctx.lineTo(w, cy);
    // Vertical full-height line
    _ctx.moveTo(cx, 0); _ctx.lineTo(cx, h);
    _ctx.stroke();

    // Tick marks every 40px along each axis
    var tickLen = 6;
    var tickSpacing = 40;
    _ctx.beginPath();
    for (var tx = tickSpacing; tx < w; tx += tickSpacing) {
      _ctx.moveTo(tx, cy - tickLen); _ctx.lineTo(tx, cy + tickLen);
    }
    for (var ty = tickSpacing; ty < h; ty += tickSpacing) {
      _ctx.moveTo(cx - tickLen, ty); _ctx.lineTo(cx + tickLen, ty);
    }
    _ctx.stroke();
  }

  /** Tactical Circle: center dot + circle + cardinal lines */
  function _drawTacticalCircle(cx, cy, w, h) {
    var radius = Math.min(w, h) * 0.08;
    var lineLen = radius * 0.6;

    // Center dot
    _setFill(HUD_GREEN, _reticleOpacity);
    _ctx.beginPath();
    _ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    _ctx.fill();

    // Circle
    _setStroke(HUD_GREEN, _reticleOpacity, _reticleThickness);
    _ctx.beginPath();
    _ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    _ctx.stroke();

    // Cardinal lines extending outward from circle
    _ctx.beginPath();
    _ctx.moveTo(cx, cy - radius); _ctx.lineTo(cx, cy - radius - lineLen);       // N
    _ctx.moveTo(cx, cy + radius); _ctx.lineTo(cx, cy + radius + lineLen);       // S
    _ctx.moveTo(cx - radius, cy); _ctx.lineTo(cx - radius - lineLen, cy);       // W
    _ctx.moveTo(cx + radius, cy); _ctx.lineTo(cx + radius + lineLen, cy);       // E
    _ctx.stroke();
  }

  /** Mil-Dot: center dot + spaced dots on axes */
  function _drawMilDot(cx, cy, w, h) {
    var dotRadius = 2;
    var spacing = 20;
    var numDots = 8;

    _setFill(HUD_GREEN, _reticleOpacity);
    // Center dot
    _ctx.beginPath();
    _ctx.arc(cx, cy, dotRadius + 1, 0, Math.PI * 2);
    _ctx.fill();

    // Dots along horizontal axis
    for (var i = 1; i <= numDots; i++) {
      _ctx.beginPath();
      _ctx.arc(cx + i * spacing, cy, dotRadius, 0, Math.PI * 2);
      _ctx.fill();
      _ctx.beginPath();
      _ctx.arc(cx - i * spacing, cy, dotRadius, 0, Math.PI * 2);
      _ctx.fill();
    }
    // Dots along vertical axis
    for (var j = 1; j <= numDots; j++) {
      _ctx.beginPath();
      _ctx.arc(cx, cy + j * spacing, dotRadius, 0, Math.PI * 2);
      _ctx.fill();
      _ctx.beginPath();
      _ctx.arc(cx, cy - j * spacing, dotRadius, 0, Math.PI * 2);
      _ctx.fill();
    }
  }

  /** Bracket Reticle: 4 L-shaped corners + center dot */
  function _drawBracketReticle(cx, cy, w, h) {
    var size = Math.min(w, h) * 0.06;
    var arm = size * 0.5;

    // Animation progress: 0 = corners of canvas, 1 = final position
    var t = 1;
    if (_reticleFade.active) {
      var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      var elapsed = now - _reticleFade.startTime;
      t = Math.min(1, elapsed / _reticleFade.duration);
      // Ease-out cubic for smooth deceleration
      t = 1 - Math.pow(1 - t, 3);
    }

    // Final bracket corner positions (center of canvas)
    var finalTLx = cx - size, finalTLy = cy - size;
    var finalTRx = cx + size, finalTRy = cy - size;
    var finalBLx = cx - size, finalBLy = cy + size;
    var finalBRx = cx + size, finalBRy = cy + size;

    // Start positions: canvas corners
    var startTLx = 0, startTLy = 0;
    var startTRx = w, startTRy = 0;
    var startBLx = 0, startBLy = h;
    var startBRx = w, startBRy = h;

    // Interpolate
    var tlx = startTLx + (finalTLx - startTLx) * t;
    var tly = startTLy + (finalTLy - startTLy) * t;
    var trx = startTRx + (finalTRx - startTRx) * t;
    var try_ = startTRy + (finalTRy - startTRy) * t;
    var blx = startBLx + (finalBLx - startBLx) * t;
    var bly = startBLy + (finalBLy - startBLy) * t;
    var brx = startBRx + (finalBRx - startBRx) * t;
    var bry = startBRy + (finalBRy - startBRy) * t;

    // Center dot (fades in)
    _setFill(_reticleColor, _reticleOpacity * t);
    _ctx.beginPath();
    _ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    _ctx.fill();

    // Draw each bracket individually at its interpolated position
    _setStroke(_reticleColor, _reticleOpacity, _reticleThickness);

    // Top-left bracket (L-shape: down + right)
    _ctx.beginPath();
    _ctx.moveTo(tlx, tly + arm);
    _ctx.lineTo(tlx, tly);
    _ctx.lineTo(tlx + arm, tly);
    _ctx.stroke();

    // Top-right bracket (L-shape: down + left)
    _ctx.beginPath();
    _ctx.moveTo(trx - arm, try_);
    _ctx.lineTo(trx, try_);
    _ctx.lineTo(trx, try_ + arm);
    _ctx.stroke();

    // Bottom-left bracket (L-shape: up + right)
    _ctx.beginPath();
    _ctx.moveTo(blx, bly - arm);
    _ctx.lineTo(blx, bly);
    _ctx.lineTo(blx + arm, bly);
    _ctx.stroke();

    // Bottom-right bracket (L-shape: up + left)
    _ctx.beginPath();
    _ctx.moveTo(brx - arm, bry);
    _ctx.lineTo(brx, bry);
    _ctx.lineTo(brx, bry - arm);
    _ctx.stroke();
  }

  // ---- Grid renderers ----

  function _renderGrid(w, h) {
    if (_gridPreset === 'none' || _gridPreset === 'crosshair-only') return;

    // Fade-in animation
    var opacityMul = 1;
    if (_gridFade.active) {
      var now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      var elapsed = now - _gridFade.startTime;
      opacityMul = Math.min(1, elapsed / _gridFade.duration);
      if (opacityMul >= 1) _gridFade.active = false;
    }

    _setStroke(_gridColor, _gridOpacity * opacityMul, _gridThickness);

    switch (_gridPreset) {
      case 'thirds': _drawThirds(w, h); break;
      case 'center-cross': _drawCenterCross(w, h); break;
      case 'quadrants': _drawQuadrants(w, h); break;
      case 'fine-grid': _drawFineGrid(w, h); break;
      case 'golden-ratio': _drawGoldenRatio(w, h); break;
    }
    _ctx.globalAlpha = 1;
  }

  /** Thirds: 2 vertical + 2 horizontal = 4 lines */
  function _drawThirds(w, h) {
    _ctx.beginPath();
    _ctx.moveTo(w / 3, 0); _ctx.lineTo(w / 3, h);
    _ctx.moveTo(2 * w / 3, 0); _ctx.lineTo(2 * w / 3, h);
    _ctx.moveTo(0, h / 3); _ctx.lineTo(w, h / 3);
    _ctx.moveTo(0, 2 * h / 3); _ctx.lineTo(w, 2 * h / 3);
    _ctx.stroke();
  }

  /** Center Cross: 1 horizontal + 1 vertical = 2 lines */
  function _drawCenterCross(w, h) {
    _ctx.beginPath();
    _ctx.moveTo(w / 2, 0); _ctx.lineTo(w / 2, h);
    _ctx.moveTo(0, h / 2); _ctx.lineTo(w, h / 2);
    _ctx.stroke();
  }

  /** Quadrants: same as center cross = 2 lines */
  function _drawQuadrants(w, h) {
    _drawCenterCross(w, h);
  }

  /** Fine Grid: (N-1) vertical + (N-1) horizontal = 2*(N-1) lines */
  function _drawFineGrid(w, h) {
    var n = _gridN;
    _ctx.beginPath();
    for (var i = 1; i < n; i++) {
      var xPos = (w * i) / n;
      _ctx.moveTo(xPos, 0); _ctx.lineTo(xPos, h);
    }
    for (var j = 1; j < n; j++) {
      var yPos = (h * j) / n;
      _ctx.moveTo(0, yPos); _ctx.lineTo(w, yPos);
    }
    _ctx.stroke();
  }

  /** Golden Ratio: 2 vertical + 2 horizontal = 4 lines */
  function _drawGoldenRatio(w, h) {
    var phi = 1.618033988749895;
    var r = 1 / (1 + phi); // ~0.382
    _ctx.beginPath();
    _ctx.moveTo(w * r, 0); _ctx.lineTo(w * r, h);
    _ctx.moveTo(w * (1 - r), 0); _ctx.lineTo(w * (1 - r), h);
    _ctx.moveTo(0, h * r); _ctx.lineTo(w, h * r);
    _ctx.moveTo(0, h * (1 - r)); _ctx.lineTo(w, h * (1 - r));
    _ctx.stroke();
  }

  // ---- Blob overlay rendering ----

  /**
   * Render corner-bracket bounding boxes on tracked blobs.
   * @param {Array} blobs - TrackedBlob[]
   */
  function _renderBlobs(blobs, w, h) {
    if (!blobs || blobs.length === 0) return;
    for (var i = 0; i < blobs.length; i++) {
      var b = blobs[i];
      if (!b || !b.boundingBox) continue;
      var bb = b.boundingBox;
      var isFocused = b._focused === true;
      var bracketLen = Math.max(8, Math.min(bb.w, bb.h) * 0.2);
      var opacity = isFocused ? 100 : 50;
      var thickness = isFocused ? 2 : 1;
      var color = isFocused ? '#00FF00' : HUD_GREEN;
      _drawCornerBrackets(bb.x, bb.y, bb.w, bb.h, bracketLen, color, opacity, thickness);

      // Centroid marker
      if (b.centroid) {
        _setFill(color, opacity);
        _ctx.beginPath();
        _ctx.arc(b.centroid.x, b.centroid.y, isFocused ? 5 : 3, 0, Math.PI * 2);
        _ctx.fill();
        _ctx.globalAlpha = 1;
      }

      // Label for focused target
      if (isFocused && b._label) {
        _setFill(color, opacity);
        _ctx.font = HUD_FONT;
        _ctx.fillText(b._label, bb.x, bb.y - 4);
        _ctx.globalAlpha = 1;
      }
    }
  }

  // ---- TF.js detection overlay rendering ----

  /**
   * Render labeled bounding boxes on TF.js detections with confidence scores.
   * Military corner-bracket style.
   * @param {Array} detections - Detection[]
   */
  function _renderDetections(detections, w, h) {
    if (!detections || detections.length === 0) return;
    for (var i = 0; i < detections.length; i++) {
      var d = detections[i];
      if (!d || !d.bbox) continue;
      var bb = d.bbox;
      var bracketLen = Math.max(10, Math.min(bb.w, bb.h) * 0.25);
      _drawCornerBrackets(bb.x, bb.y, bb.w, bb.h, bracketLen, '#00FF00', 100, 2);

      // Label with confidence
      var label = (d.class || 'OBJ').toUpperCase();
      var conf = typeof d.score === 'number' ? Math.round(d.score * 100) : 0;
      var text = label + ' ' + conf + '%';
      _setFill('#00FF00', 100);
      _ctx.font = HUD_FONT_LARGE;
      _ctx.fillText(text, bb.x, bb.y - 6);
      _ctx.globalAlpha = 1;
    }
  }

  // ---- Telemetry panel rendering ----

  /**
   * Render telemetry data at screen edges.
   * @param {object} telemetry - TelemetryData
   * @param {object} status - StatusIndicators
   * @param {number} w - canvas width
   * @param {number} h - canvas height
   */
  function _renderTelemetry(telemetry, status, w, h) {
    if (!telemetry) return;
    _ctx.font = HUD_FONT;
    var lineH = 13;
    var margin = 8;

    // Top-left: FPS, processing latency, inference latency
    var topLeftLines = [];
    topLeftLines.push('FPS: ' + (typeof telemetry.fps === 'number' ? telemetry.fps : '--'));
    topLeftLines.push('PROC: ' + (typeof telemetry.processingLatencyMs === 'number' ? telemetry.processingLatencyMs.toFixed(1) : '--') + 'MS');
    if (typeof telemetry.inferenceLatencyMs === 'number' && telemetry.inferenceLatencyMs > 0) {
      topLeftLines.push('INFER: ' + telemetry.inferenceLatencyMs.toFixed(1) + 'MS');
    }
    if (typeof telemetry.activeRuleCount === 'number') {
      topLeftLines.push('RULES: ' + telemetry.activeRuleCount);
    }

    _setFill(HUD_GREEN, 70);
    for (var i = 0; i < topLeftLines.length; i++) {
      _ctx.fillText(topLeftLines[i], margin, margin + lineH * (i + 1));
    }

    // Top-right: PTZ angles, tracking status
    var topRightLines = [];
    topRightLines.push('PAN: ' + (typeof telemetry.panAngle === 'number' ? telemetry.panAngle.toFixed(1) : '--') + '°');
    topRightLines.push('TILT: ' + (typeof telemetry.tiltAngle === 'number' ? telemetry.tiltAngle.toFixed(1) : '--') + '°');
    topRightLines.push('ZOOM: ' + (typeof telemetry.zoomLevel === 'number' ? telemetry.zoomLevel.toFixed(1) : '--') + 'X');
    if (telemetry.trackingStatus) {
      topRightLines.push('TRK: ' + telemetry.trackingStatus.toUpperCase());
    }

    for (var j = 0; j < topRightLines.length; j++) {
      var tw = _ctx.measureText(topRightLines[j]).width;
      _ctx.fillText(topRightLines[j], w - margin - tw, margin + lineH * (j + 1));
    }

    // Bottom-left: device statuses
    var bottomLeftLines = [];
    if (status) {
      var serialSt = status.serialStatus || 'disconnected';
      var webcamSt = status.webcamStatus || 'disconnected';
      var gamepadSt = status.gamepadStatus || 'none';
      var bottomY = h - margin - lineH * 3;

      _setFill(_statusToColor(_deviceStatusToLevel(serialSt)), 70);
      _ctx.fillText('SER: ' + serialSt.toUpperCase(), margin, bottomY);

      _setFill(_statusToColor(_deviceStatusToLevel(webcamSt)), 70);
      _ctx.fillText('CAM: ' + webcamSt.toUpperCase(), margin, bottomY + lineH);

      _setFill(_statusToColor(_deviceStatusToLevel(gamepadSt)), 70);
      _ctx.fillText('PAD: ' + gamepadSt.toUpperCase(), margin, bottomY + lineH * 2);
    }

    // Bottom-right: memory, recording
    _setFill(HUD_GREEN, 70);
    var brLines = [];
    if (typeof telemetry.memoryUsageMB === 'number') {
      var memColor = telemetry.memoryUsageMB > 500 ? HUD_AMBER : HUD_GREEN;
      _setFill(memColor, 70);
      _ctx.fillText('MEM: ' + telemetry.memoryUsageMB.toFixed(0) + 'MB', w - margin - 80, h - margin - lineH * 2);
    }
    if (telemetry.recordingActive) {
      _setFill(HUD_RED, 90);
      _ctx.fillText('● REC ' + _formatDuration(telemetry.recordingDuration || 0), w - margin - 100, h - margin - lineH);
    }

    // Bottom-center: movement calculation data
    if (telemetry.showMovementData && telemetry.movementData) {
      var md = telemetry.movementData;
      var movLines = [
        'DX: ' + md.dx.toFixed(1) + 'PX  DY: ' + md.dy.toFixed(1) + 'PX  DIST: ' + md.distance.toFixed(1) + 'PX',
        'VX: ' + (md.vx || 0).toFixed(1) + '  VY: ' + (md.vy || 0).toFixed(1),
        'PX/U PAN: ' + (typeof md.pxPerUnitPan === 'number' ? md.pxPerUnitPan.toFixed(2) : md.pxPerUnitPan) +
        '  TILT: ' + (typeof md.pxPerUnitTilt === 'number' ? md.pxPerUnitTilt.toFixed(2) : md.pxPerUnitTilt),
        'LATENCY: ' + (typeof md.latencyMs === 'number' ? md.latencyMs.toFixed(0) + 'MS' : md.latencyMs) +
        '  ZOOM MUL: ' + (typeof md.zoomMultiplier === 'number' ? md.zoomMultiplier.toFixed(2) : md.zoomMultiplier),
        'TARGETS: ' + md.targetCount + '  FOCUS: ' + (md.focusedIndex > 0 ? md.focusedIndex + '/' + md.targetCount : '--')
      ];

      _ctx.font = HUD_FONT;
      _setFill(HUD_GREEN, 70);
      var blockH = movLines.length * lineH;
      var startY = h - margin - blockH; // flush to bottom edge
      for (var ml = 0; ml < movLines.length; ml++) {
        var tw = _ctx.measureText(movLines[ml]).width;
        _ctx.fillText(movLines[ml], (w - tw) / 2, startY + ml * lineH);
      }
    }

    _ctx.globalAlpha = 1;
  }

  /** Map device status strings to status levels */
  function _deviceStatusToLevel(st) {
    if (st === 'connected') return 'nominal';
    if (st === 'fallback-active') return 'warning';
    if (st === 'disconnected' || st === 'no-signal' || st === 'none') return 'error';
    return 'nominal';
  }

  function _formatDuration(seconds) {
    var m = Math.floor(seconds / 60);
    var s = Math.floor(seconds % 60);
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  // ---- Compass / bearing indicator ----

  /**
   * Render compass/bearing indicator along top edge showing pan angle.
   * @param {number} panAngle - current pan angle in degrees
   * @param {number} w - canvas width
   */
  function _renderCompass(panAngle, w) {
    if (typeof panAngle !== 'number') return;
    var y = 20;
    var centerX = w / 2;
    var degreesVisible = 60; // degrees visible across the width
    var pixelsPerDeg = w / degreesVisible;

    _setStroke(HUD_GREEN, 50, 1);
    _ctx.beginPath();
    _ctx.moveTo(0, y); _ctx.lineTo(w, y);
    _ctx.stroke();

    _setFill(HUD_GREEN, 60);
    _ctx.font = HUD_FONT;

    // Draw tick marks and labels
    var startDeg = panAngle - degreesVisible / 2;
    var endDeg = panAngle + degreesVisible / 2;
    for (var deg = Math.ceil(startDeg / 10) * 10; deg <= endDeg; deg += 10) {
      var xPos = centerX + (deg - panAngle) * pixelsPerDeg;
      if (xPos < 0 || xPos > w) continue;

      _ctx.beginPath();
      var tickH = (deg % 30 === 0) ? 8 : 4;
      _ctx.moveTo(xPos, y - tickH); _ctx.lineTo(xPos, y + tickH);
      _ctx.stroke();

      if (deg % 30 === 0) {
        var label = _compassLabel(((deg % 360) + 360) % 360);
        var tw = _ctx.measureText(label).width;
        _ctx.fillText(label, xPos - tw / 2, y - 10);
      }
    }

    // Center indicator
    _setStroke(HUD_GREEN, 80, 2);
    _ctx.beginPath();
    _ctx.moveTo(centerX, y - 10); _ctx.lineTo(centerX, y + 10);
    _ctx.stroke();
    _ctx.globalAlpha = 1;
  }

  function _compassLabel(deg) {
    if (deg === 0 || deg === 360) return 'N';
    if (deg === 90) return 'E';
    if (deg === 180) return 'S';
    if (deg === 270) return 'W';
    return deg + '°';
  }

  // ---- Pitch ladder / tilt indicator ----

  /**
   * Render pitch ladder along left edge showing tilt angle.
   * @param {number} tiltAngle - current tilt angle in degrees
   * @param {number} h - canvas height
   */
  function _renderPitchLadder(tiltAngle, h) {
    if (typeof tiltAngle !== 'number') return;
    var x = 30;
    var centerY = h / 2;
    var degreesVisible = 40;
    var pixelsPerDeg = h / degreesVisible;

    _setStroke(HUD_GREEN, 50, 1);
    _ctx.beginPath();
    _ctx.moveTo(x, 0); _ctx.lineTo(x, h);
    _ctx.stroke();

    _setFill(HUD_GREEN, 60);
    _ctx.font = HUD_FONT;

    var startDeg = tiltAngle - degreesVisible / 2;
    var endDeg = tiltAngle + degreesVisible / 2;
    for (var deg = Math.ceil(startDeg / 5) * 5; deg <= endDeg; deg += 5) {
      var yPos = centerY - (deg - tiltAngle) * pixelsPerDeg;
      if (yPos < 0 || yPos > h) continue;

      _ctx.beginPath();
      var tickW = (deg % 10 === 0) ? 10 : 5;
      _ctx.moveTo(x - tickW, yPos); _ctx.lineTo(x + tickW, yPos);
      _ctx.stroke();

      if (deg % 10 === 0) {
        _ctx.fillText(deg + '°', x + 14, yPos + 3);
      }
    }

    // Center indicator
    _setStroke(HUD_GREEN, 80, 2);
    _ctx.beginPath();
    _ctx.moveTo(x - 12, centerY); _ctx.lineTo(x + 12, centerY);
    _ctx.stroke();
    _ctx.globalAlpha = 1;
  }

  // ---- Lock-on animation ----

  /**
   * Animate target lock-on with bracket-tightening animation.
   * @param {object} lockOnTarget - TrackedBlob to animate lock-on for
   * @param {number} now - current timestamp (ms)
   */
  function _renderLockOnAnimation(lockOnTarget, now) {
    if (!lockOnTarget || !lockOnTarget.boundingBox) return;

    if (!_lockOnAnim || _lockOnAnim.targetBlob !== lockOnTarget) {
      _lockOnAnim = { startTime: now, targetBlob: lockOnTarget, duration: LOCK_ON_DURATION };
    }

    var elapsed = now - _lockOnAnim.startTime;
    if (elapsed > _lockOnAnim.duration) {
      // Animation complete — draw final tight brackets
      var bb = lockOnTarget.boundingBox;
      var bracketLen = Math.max(8, Math.min(bb.w, bb.h) * 0.2);
      _drawCornerBrackets(bb.x, bb.y, bb.w, bb.h, bracketLen, HUD_GREEN, 90, 2);
      return;
    }

    // Interpolate from expanded to tight
    var t = elapsed / _lockOnAnim.duration;
    t = t * t * (3 - 2 * t); // smoothstep
    var bb2 = lockOnTarget.boundingBox;
    var expand = (1 - t) * 20;
    var ax = bb2.x - expand;
    var ay = bb2.y - expand;
    var aw = bb2.w + expand * 2;
    var ah = bb2.h + expand * 2;
    var bracketLen2 = Math.max(8, Math.min(aw, ah) * 0.2);
    _drawCornerBrackets(ax, ay, aw, ah, bracketLen2, HUD_GREEN, 60 + t * 30, 2);
  }

  // ---- Public API ----

  /**
   * Initialize the HUD renderer with a canvas element.
   * @param {HTMLCanvasElement} canvas
   */
  function init(canvas) {
    _canvas = canvas;
    _ctx = canvas.getContext('2d');
    _loadConfig();
  }

  /**
   * Set the active reticle style.
   * @param {string} style - 'crosshair' | 'tactical-circle' | 'mil-dot' | 'bracket'
   */
  function setReticleStyle(style) {
    if (VALID_RETICLE_STYLES.indexOf(style) !== -1) {
      _reticleStyle = style;
      if (style !== 'none') {
        _reticleFade.active = true;
        _reticleFade.startTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      }
      _saveConfig();
    }
  }

  /**
   * Set the active grid preset.
   * @param {string} preset
   */
  function setGridPreset(preset) {
    if (VALID_GRID_PRESETS.indexOf(preset) !== -1) {
      _gridPreset = preset;
      if (preset !== 'none') {
        _gridFade.active = true;
        _gridFade.startTime = (typeof performance !== 'undefined') ? performance.now() : Date.now();
      }
      _saveConfig();
    }
  }

  /**
   * Set reticle config (opacity and thickness).
   * @param {{ opacity: number, thickness: number }} config
   */
  function setReticleConfig(config) {
    if (config) {
      if (typeof config.opacity === 'number') {
        _reticleOpacity = Math.max(0, Math.min(100, config.opacity));
      }
      if (typeof config.thickness === 'number') {
        _reticleThickness = Math.max(1, Math.min(3, config.thickness));
      }
      if (typeof config.color === 'string' && config.color) {
        _reticleColor = config.color;
      }
      _saveConfig();
    }
  }

  /**
   * Set grid config (opacity, thickness, gridN).
   * @param {{ opacity: number, thickness: number, gridN?: number }} config
   */
  function setGridConfig(config) {
    if (config) {
      if (typeof config.opacity === 'number') {
        _gridOpacity = Math.max(0, Math.min(100, config.opacity));
      }
      if (typeof config.thickness === 'number') {
        _gridThickness = Math.max(1, Math.min(3, config.thickness));
      }
      if (typeof config.gridN === 'number') {
        _gridN = Math.max(4, Math.min(16, Math.floor(config.gridN)));
      }
      if (typeof config.color === 'string' && config.color) {
        _gridColor = config.color;
      }
      _saveConfig();
    }
  }

  /**
   * Render a complete frame: video + all HUD overlays.
   * @param {ImageData} videoFrame
   * @param {object} overlays - OverlayData { blobs, detections, telemetry, status, lockOnTarget }
   */
  function renderFrame(videoFrame, overlays) {
    if (!_canvas || !_ctx) return;
    var w = _canvas.width;
    var h = _canvas.height;
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    var ct = overlays ? overlays.cameraTransform : null;

    // 1. Draw video frame (with camera-only transform if set)
    if (videoFrame) {
      if (ct && (ct.mirrorH || ct.mirrorV || ct.angle)) {
        // putImageData ignores transforms, so draw to temp canvas then drawImage with transform
        if (!_transformCanvas) {
          _transformCanvas = document.createElement('canvas');
          _transformCtx = _transformCanvas.getContext('2d');
        }
        _transformCanvas.width = w;
        _transformCanvas.height = h;
        _transformCtx.putImageData(videoFrame, 0, 0);

        _ctx.save();
        _ctx.translate(w / 2, h / 2);
        if (ct.angle) _ctx.rotate(ct.angle * Math.PI / 180);
        var sx = ct.mirrorH ? -1 : 1;
        var sy = ct.mirrorV ? -1 : 1;
        _ctx.scale(sx, sy);
        _ctx.drawImage(_transformCanvas, -w / 2, -h / 2);
        _ctx.restore();
      } else {
        _ctx.putImageData(videoFrame, 0, 0);
      }
    }

    // 2. Grid overlay
    _renderGrid(w, h);

    // 3. Reticle
    _renderReticle(w, h);

    // 4. Blob bounding boxes
    if (overlays && overlays.blobs) {
      _renderBlobs(overlays.blobs, w, h);
    }

    // 5. TF.js detection overlays
    if (overlays && overlays.detections) {
      _renderDetections(overlays.detections, w, h);
    }

    // 6. Lock-on animation
    if (overlays && overlays.lockOnTarget) {
      _renderLockOnAnimation(overlays.lockOnTarget, now);
    }

    // 7. Compass / bearing
    if (overlays && overlays.telemetry) {
      _renderCompass(overlays.telemetry.panAngle, w);
      _renderPitchLadder(overlays.telemetry.tiltAngle, h);
    }

    // 8. Telemetry panel
    if (overlays) {
      _renderTelemetry(overlays.telemetry, overlays.status, w, h);
    }
  }

  /**
   * Start the HUD renderer. Loads config.
   */
  function start() {
    _running = true;
    _loadConfig();
  }

  /**
   * Stop the HUD renderer. Cancels any pending animation frame.
   */
  function stop() {
    _running = false;
    if (_rafId) {
      if (typeof cancelAnimationFrame !== 'undefined') {
        cancelAnimationFrame(_rafId);
      }
      _rafId = null;
    }
    _lockOnAnim = null;
  }

  /**
   * Get current state (for testing/debugging).
   */
  function getState() {
    return {
      running: _running,
      reticleStyle: _reticleStyle,
      reticleOpacity: _reticleOpacity,
      reticleThickness: _reticleThickness,
      gridPreset: _gridPreset,
      gridOpacity: _gridOpacity,
      gridThickness: _gridThickness,
      gridN: _gridN
    };
  }

  return {
    init: init,
    setReticleStyle: setReticleStyle,
    setGridPreset: setGridPreset,
    renderFrame: renderFrame,
    setReticleConfig: setReticleConfig,
    setGridConfig: setGridConfig,
    start: start,
    stop: stop,
    getState: getState,
    // Exposed for property testing
    _statusToColor: _statusToColor,
    _gridPresetLineCount: _gridPresetLineCount
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.HUDRenderer = HUDRenderer;
}
