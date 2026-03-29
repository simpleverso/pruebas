// touch-region-handler.js — TouchRegionHandler
// Touch-based ROI selection for the HUD canvas.
// Provides: transformCoordinates, classifyGesture, createTapROI, computeDragROI, isValidROI, init, resetSelection, destroy
// Requirements: 1.1–1.3, 2.1–2.3, 3.1–3.3, 4.1–4.4, 8.1, 9.1, 9.3

/* global globalThis */
var TouchRegionHandler = (function () {

  // ---- Constants ----
  var TAP_MAX_DURATION_MS = 300;
  var TAP_MAX_DISTANCE_PX = 15;
  var DEFAULT_TAP_ROI_SIZE = 64;
  var MIN_ROI_SIZE = 10;

  // ---- Pure functions ----

  /**
   * Convert display coordinates to canvas coordinates.
   * Guards against division by zero when rect.width or rect.height is 0.
   * @param {number} clientX - touch clientX (display coordinate)
   * @param {number} clientY - touch clientY (display coordinate)
   * @param {{ left: number, top: number, width: number, height: number }} rect - canvas bounding rect
   * @param {number} canvasWidth - canvas.width (internal resolution)
   * @param {number} canvasHeight - canvas.height (internal resolution)
   * @returns {{ x: number, y: number }} canvas-space coordinates clamped to [0, canvasWidth] × [0, canvasHeight]
   */
  function transformCoordinates(clientX, clientY, rect, canvasWidth, canvasHeight) {
    if (rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0 };
    }
    var scaleX = canvasWidth / rect.width;
    var scaleY = canvasHeight / rect.height;
    var x = (clientX - rect.left) * scaleX;
    var y = (clientY - rect.top) * scaleY;
    return {
      x: Math.max(0, Math.min(canvasWidth, x)),
      y: Math.max(0, Math.min(canvasHeight, y))
    };
  }

  /**
   * Classify a touch interaction as tap or drag.
   * Tap: duration < 300ms AND distance < 15px. Otherwise drag.
   * @param {number} durationMs - time between touchstart and touchend
   * @param {number} distancePx - CSS pixel distance moved
   * @returns {'tap' | 'drag'}
   */
  function classifyGesture(durationMs, distancePx) {
    if (durationMs < TAP_MAX_DURATION_MS && distancePx < TAP_MAX_DISTANCE_PX) {
      return 'tap';
    }
    return 'drag';
  }

  /**
   * Create a default tap ROI centered at (cx, cy), clamped to canvas bounds.
   * @param {number} cx - canvas X coordinate
   * @param {number} cy - canvas Y coordinate
   * @param {number} canvasWidth
   * @param {number} canvasHeight
   * @param {number} [size] - ROI side length, defaults to DEFAULT_TAP_ROI_SIZE (64)
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function createTapROI(cx, cy, canvasWidth, canvasHeight, size) {
    var s = (size !== undefined) ? size : DEFAULT_TAP_ROI_SIZE;
    var halfW = s / 2;
    var halfH = s / 2;

    // Start with ideal centered position
    var x = cx - halfW;
    var y = cy - halfH;

    // Clamp to canvas bounds
    x = Math.max(0, Math.min(canvasWidth - s, x));
    y = Math.max(0, Math.min(canvasHeight - s, y));

    // Clamp width/height if canvas is smaller than the ROI size
    var w = Math.min(s, canvasWidth);
    var h = Math.min(s, canvasHeight);

    return { x: x, y: y, w: w, h: h };
  }

  /**
   * Compute the axis-aligned bounding box between two canvas-space points.
   * @param {{ x: number, y: number }} start
   * @param {{ x: number, y: number }} end
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function computeDragROI(start, end) {
    var x = Math.min(start.x, end.x);
    var y = Math.min(start.y, end.y);
    var w = Math.abs(end.x - start.x);
    var h = Math.abs(end.y - start.y);
    return { x: x, y: y, w: w, h: h };
  }

  /**
   * Check if an ROI meets the minimum size requirement.
   * @param {{ w: number, h: number }} roi
   * @param {number} [minSize] - minimum width/height, defaults to MIN_ROI_SIZE (10)
   * @returns {boolean}
   */
  function isValidROI(roi, minSize) {
    var min = (minSize !== undefined) ? minSize : MIN_ROI_SIZE;
    return roi.w >= min && roi.h >= min;
  }

  // ---- Internal gesture state ----
  var _gesture = {
    active: false,
    startTime: 0,
    startClientX: 0,
    startClientY: 0,
    startCanvas: null,
    currentCanvas: null,
    gestureType: null
  };

  // ---- References for cleanup ----
  var _canvas = null;
  var _state = null;
  var _callbacks = null;
  var _boundHandlers = null;

  /**
   * Reset internal gesture state to idle.
   */
  function _resetGesture() {
    _gesture.active = false;
    _gesture.startTime = 0;
    _gesture.startClientX = 0;
    _gesture.startClientY = 0;
    _gesture.startCanvas = null;
    _gesture.currentCanvas = null;
    _gesture.gestureType = null;
  }

  /**
   * Reset all selection state (called on touchcancel or cancel button).
   * Clears _roiSelecting, _roiStart, _roiRect via state setters and notifies overlay.
   */
  function resetSelection() {
    _resetGesture();
    if (_state) {
      _state.setRoiSelecting(false);
      _state.setRoiStart(null);
      _state.setRoiRect(null);
    }
    if (_callbacks && _callbacks.onOverlayUpdate) {
      _callbacks.onOverlayUpdate(null);
    }
  }

  // ---- Touch event handlers ----

  function _onTouchStart(e) {
    if (!_state || !_state.getRoiMode()) {
      return;
    }
    e.preventDefault();
    if (!e.touches || e.touches.length === 0) {
      return;
    }
    var touch = e.touches[0];
    var rect = _canvas.getBoundingClientRect();
    var canvasCoords = transformCoordinates(touch.clientX, touch.clientY, rect, _canvas.width, _canvas.height);

    _gesture.active = true;
    _gesture.startTime = performance.now();
    _gesture.startClientX = touch.clientX;
    _gesture.startClientY = touch.clientY;
    _gesture.startCanvas = canvasCoords;
    _gesture.currentCanvas = canvasCoords;
    _gesture.gestureType = null;

    _state.setRoiSelecting(true);
    _state.setRoiStart(canvasCoords);
  }

  function _onTouchMove(e) {
    if (!_gesture.active || !_state || !_state.getRoiMode()) {
      return;
    }
    e.preventDefault();
    if (!e.touches || e.touches.length === 0) {
      return;
    }
    var touch = e.touches[0];

    // Compute CSS pixel distance from start
    var dx = touch.clientX - _gesture.startClientX;
    var dy = touch.clientY - _gesture.startClientY;
    var distancePx = Math.sqrt(dx * dx + dy * dy);

    if (distancePx >= TAP_MAX_DISTANCE_PX) {
      _gesture.gestureType = 'drag';
      var rect = _canvas.getBoundingClientRect();
      var canvasCoords = transformCoordinates(touch.clientX, touch.clientY, rect, _canvas.width, _canvas.height);
      _gesture.currentCanvas = canvasCoords;

      var roiRect = computeDragROI(_gesture.startCanvas, canvasCoords);
      _state.setRoiRect(roiRect);
      if (_callbacks && _callbacks.onOverlayUpdate) {
        _callbacks.onOverlayUpdate(roiRect);
      }
    }
  }

  function _onTouchEnd(e) {
    if (!_gesture.active || !_state || !_state.getRoiMode()) {
      return;
    }
    e.preventDefault();
    if (!e.changedTouches || e.changedTouches.length === 0) {
      resetSelection();
      return;
    }
    var touch = e.changedTouches[0];
    var rect = _canvas.getBoundingClientRect();
    var endCanvas = transformCoordinates(touch.clientX, touch.clientY, rect, _canvas.width, _canvas.height);

    var durationMs = performance.now() - _gesture.startTime;
    var dx = touch.clientX - _gesture.startClientX;
    var dy = touch.clientY - _gesture.startClientY;
    var distancePx = Math.sqrt(dx * dx + dy * dy);

    var gesture = classifyGesture(durationMs, distancePx);

    if (gesture === 'tap') {
      var tapROI = createTapROI(endCanvas.x, endCanvas.y, _canvas.width, _canvas.height);
      _state.setRoiRect(tapROI);
      _state.setRoiSelecting(false);
      if (_callbacks && _callbacks.onTapFlash) {
        _callbacks.onTapFlash(tapROI);
      }
      if (_callbacks && _callbacks.onROIFinalized) {
        _callbacks.onROIFinalized(tapROI);
      }
    } else {
      // drag gesture
      var finalROI = computeDragROI(_gesture.startCanvas, endCanvas);
      _state.setRoiRect(finalROI);
      _state.setRoiSelecting(false);
      if (isValidROI(finalROI)) {
        if (_callbacks && _callbacks.onROIFinalized) {
          _callbacks.onROIFinalized(finalROI);
        }
      }
    }

    _resetGesture();
  }

  function _onTouchCancel(e) {
    if (!_gesture.active) {
      return;
    }
    e.preventDefault();
    resetSelection();
  }

  /**
   * Initialize: register touch event listeners on the canvas.
   * @param {HTMLCanvasElement} canvas - the #hud-canvas element
   * @param {object} state - state accessor object with getter/setter pairs
   *   { getRoiMode, setRoiMode, getRoiSelecting, setRoiSelecting, getRoiStart, setRoiStart, getRoiRect, setRoiRect }
   * @param {object} callbacks - integration callbacks
   *   { onROIFinalized(roi), onOverlayUpdate(rect|null), onTapFlash(roi) }
   */
  function init(canvas, state, callbacks) {
    // Clean up any previous listeners
    if (_canvas && _boundHandlers) {
      destroy();
    }

    _canvas = canvas;
    _state = state;
    _callbacks = callbacks;

    _boundHandlers = {
      touchstart: _onTouchStart,
      touchmove: _onTouchMove,
      touchend: _onTouchEnd,
      touchcancel: _onTouchCancel
    };

    _canvas.addEventListener('touchstart', _boundHandlers.touchstart, { passive: false });
    _canvas.addEventListener('touchmove', _boundHandlers.touchmove, { passive: false });
    _canvas.addEventListener('touchend', _boundHandlers.touchend, { passive: false });
    _canvas.addEventListener('touchcancel', _boundHandlers.touchcancel, { passive: false });
  }

  /**
   * Destroy: remove all event listeners and clear references.
   */
  function destroy() {
    if (_canvas && _boundHandlers) {
      _canvas.removeEventListener('touchstart', _boundHandlers.touchstart);
      _canvas.removeEventListener('touchmove', _boundHandlers.touchmove);
      _canvas.removeEventListener('touchend', _boundHandlers.touchend);
      _canvas.removeEventListener('touchcancel', _boundHandlers.touchcancel);
    }
    _resetGesture();
    _canvas = null;
    _state = null;
    _callbacks = null;
    _boundHandlers = null;
  }

  return {
    transformCoordinates: transformCoordinates,
    classifyGesture: classifyGesture,
    createTapROI: createTapROI,
    computeDragROI: computeDragROI,
    isValidROI: isValidROI,
    init: init,
    resetSelection: resetSelection,
    destroy: destroy
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.TouchRegionHandler = TouchRegionHandler;
}
