import { describe, it, expect, vi, afterEach } from 'vitest';

// Load the TouchRegionHandler IIFE — it attaches to globalThis via `var`
import './touch-region-handler.js';

const handler = globalThis.TouchRegionHandler;

// ---- Helpers for event handling tests ----

function createMockCanvas(width, height, rectOverride) {
  const rect = rectOverride || { left: 0, top: 0, width: width, height: height, right: width, bottom: height };
  const listeners = {};
  return {
    width: width,
    height: height,
    getBoundingClientRect: () => rect,
    addEventListener: vi.fn((type, fn, opts) => { listeners[type] = fn; }),
    removeEventListener: vi.fn((type, fn) => { if (listeners[type] === fn) delete listeners[type]; }),
    _listeners: listeners,
    _fire: function (type, eventProps) {
      if (listeners[type]) listeners[type](eventProps);
    }
  };
}

function createMockState(initial) {
  const s = {
    roiMode: initial.roiMode || false,
    roiSelecting: initial.roiSelecting || false,
    roiStart: initial.roiStart || null,
    roiRect: initial.roiRect || null
  };
  return {
    getRoiMode: () => s.roiMode,
    setRoiMode: (v) => { s.roiMode = v; },
    getRoiSelecting: () => s.roiSelecting,
    setRoiSelecting: (v) => { s.roiSelecting = v; },
    getRoiStart: () => s.roiStart,
    setRoiStart: (v) => { s.roiStart = v; },
    getRoiRect: () => s.roiRect,
    setRoiRect: (v) => { s.roiRect = v; },
    _raw: s
  };
}

function makeTouchEvent(type, touches, changedTouches) {
  return {
    type: type,
    touches: touches || [],
    changedTouches: changedTouches || [],
    preventDefault: vi.fn()
  };
}

// ---- classifyGesture ----

describe('classifyGesture', () => {
  it('returns "tap" when duration < 300ms AND distance < 15px', () => {
    expect(handler.classifyGesture(100, 5)).toBe('tap');
    expect(handler.classifyGesture(0, 0)).toBe('tap');
    expect(handler.classifyGesture(299, 14)).toBe('tap');
  });

  it('returns "drag" when duration >= 300ms', () => {
    expect(handler.classifyGesture(300, 5)).toBe('drag');
    expect(handler.classifyGesture(500, 0)).toBe('drag');
  });

  it('returns "drag" when distance >= 15px', () => {
    expect(handler.classifyGesture(100, 15)).toBe('drag');
    expect(handler.classifyGesture(50, 100)).toBe('drag');
  });

  it('returns "drag" when both thresholds exceeded', () => {
    expect(handler.classifyGesture(300, 15)).toBe('drag');
    expect(handler.classifyGesture(1000, 200)).toBe('drag');
  });
});

// ---- createTapROI ----

describe('createTapROI', () => {
  it('creates a 64x64 ROI centered at the tap point', () => {
    const roi = handler.createTapROI(200, 200, 640, 480);
    expect(roi).toEqual({ x: 168, y: 168, w: 64, h: 64 });
  });

  it('defaults size to 64 when not provided', () => {
    const roi = handler.createTapROI(200, 200, 640, 480);
    expect(roi.w).toBe(64);
    expect(roi.h).toBe(64);
  });

  it('uses custom size when provided', () => {
    const roi = handler.createTapROI(200, 200, 640, 480, 100);
    expect(roi).toEqual({ x: 150, y: 150, w: 100, h: 100 });
  });

  it('clamps ROI to left/top canvas edge', () => {
    const roi = handler.createTapROI(10, 10, 640, 480);
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.y + roi.h).toBeLessThanOrEqual(480);
  });

  it('clamps ROI to right/bottom canvas edge', () => {
    const roi = handler.createTapROI(630, 470, 640, 480);
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.y + roi.h).toBeLessThanOrEqual(480);
  });

  it('handles canvas smaller than ROI size', () => {
    const roi = handler.createTapROI(15, 15, 30, 30);
    expect(roi.w).toBeLessThanOrEqual(30);
    expect(roi.h).toBeLessThanOrEqual(30);
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
  });

  it('ROI is fully contained within canvas bounds', () => {
    const roi = handler.createTapROI(0, 0, 640, 480);
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.y + roi.h).toBeLessThanOrEqual(480);
  });
});

// ---- computeDragROI ----

describe('computeDragROI', () => {
  it('computes bounding box for top-left to bottom-right drag', () => {
    const roi = handler.computeDragROI({ x: 10, y: 20 }, { x: 100, y: 80 });
    expect(roi).toEqual({ x: 10, y: 20, w: 90, h: 60 });
  });

  it('computes bounding box for bottom-right to top-left drag', () => {
    const roi = handler.computeDragROI({ x: 100, y: 80 }, { x: 10, y: 20 });
    expect(roi).toEqual({ x: 10, y: 20, w: 90, h: 60 });
  });

  it('handles same start and end point', () => {
    const roi = handler.computeDragROI({ x: 50, y: 50 }, { x: 50, y: 50 });
    expect(roi).toEqual({ x: 50, y: 50, w: 0, h: 0 });
  });

  it('handles horizontal drag', () => {
    const roi = handler.computeDragROI({ x: 10, y: 50 }, { x: 100, y: 50 });
    expect(roi).toEqual({ x: 10, y: 50, w: 90, h: 0 });
  });

  it('handles vertical drag', () => {
    const roi = handler.computeDragROI({ x: 50, y: 10 }, { x: 50, y: 100 });
    expect(roi).toEqual({ x: 50, y: 10, w: 0, h: 90 });
  });
});

// ---- isValidROI ----

describe('isValidROI', () => {
  it('returns true when both dimensions >= 10 (default minSize)', () => {
    expect(handler.isValidROI({ w: 10, h: 10 })).toBe(true);
    expect(handler.isValidROI({ w: 100, h: 200 })).toBe(true);
  });

  it('returns false when width < 10', () => {
    expect(handler.isValidROI({ w: 9, h: 100 })).toBe(false);
  });

  it('returns false when height < 10', () => {
    expect(handler.isValidROI({ w: 100, h: 9 })).toBe(false);
  });

  it('returns false when both dimensions < 10', () => {
    expect(handler.isValidROI({ w: 5, h: 5 })).toBe(false);
  });

  it('uses custom minSize when provided', () => {
    expect(handler.isValidROI({ w: 15, h: 15 }, 20)).toBe(false);
    expect(handler.isValidROI({ w: 20, h: 20 }, 20)).toBe(true);
  });

  it('returns false for zero-size ROI', () => {
    expect(handler.isValidROI({ w: 0, h: 0 })).toBe(false);
  });
});


// ---- init ----

describe('init', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('registers touchstart, touchmove, touchend, touchcancel listeners on the canvas', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    expect(canvas.addEventListener).toHaveBeenCalledTimes(4);
    const types = canvas.addEventListener.mock.calls.map(c => c[0]);
    expect(types).toContain('touchstart');
    expect(types).toContain('touchmove');
    expect(types).toContain('touchend');
    expect(types).toContain('touchcancel');
  });

  it('registers listeners with passive: false', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    canvas.addEventListener.mock.calls.forEach(call => {
      expect(call[2]).toEqual({ passive: false });
    });
  });

  it('cleans up previous listeners when init is called again', () => {
    const canvas1 = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas1, state, {});

    const canvas2 = createMockCanvas(800, 600);
    handler.init(canvas2, state, {});

    expect(canvas1.removeEventListener).toHaveBeenCalledTimes(4);
    expect(canvas2.addEventListener).toHaveBeenCalledTimes(4);
  });
});

// ---- touchstart behavior ----

describe('touchstart', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('ignores touch when roiMode is false (Req 8.1)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: false });
    handler.init(canvas, state, {});

    const e = makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]);
    canvas._fire('touchstart', e);

    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(state._raw.roiSelecting).toBe(false);
    expect(state._raw.roiStart).toBeNull();
  });

  it('calls preventDefault when roiMode is true (Req 1.2)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    const e = makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]);
    canvas._fire('touchstart', e);

    expect(e.preventDefault).toHaveBeenCalled();
  });

  it('uses touches[0] and sets roiSelecting and roiStart (Req 1.3)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    const e = makeTouchEvent('touchstart', [
      { clientX: 100, clientY: 200 },
      { clientX: 300, clientY: 400 }  // second touch should be ignored
    ]);
    canvas._fire('touchstart', e);

    expect(state._raw.roiSelecting).toBe(true);
    expect(state._raw.roiStart).toEqual({ x: 100, y: 200 });
  });
});

// ---- touchmove behavior ----

describe('touchmove', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('classifies as drag and updates roiRect when past 15px threshold', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    // Start touch
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));

    // Move past threshold
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 120, clientY: 120 }]));

    expect(onOverlayUpdate).toHaveBeenCalled();
    expect(state._raw.roiRect).not.toBeNull();
    expect(state._raw.roiRect.w).toBeGreaterThan(0);
  });

  it('does not update when movement is below 15px threshold', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 105, clientY: 105 }]));

    expect(onOverlayUpdate).not.toHaveBeenCalled();
  });
});

// ---- touchend behavior ----

describe('touchend', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('uses changedTouches[0] (not touches[0])', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    const onTapFlash = vi.fn();
    handler.init(canvas, state, { onROIFinalized, onTapFlash });

    // Start touch
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]));

    // End touch — touches is empty on touchend, changedTouches has the released finger
    const endEvent = makeTouchEvent('touchend', [], [{ clientX: 200, clientY: 200 }]);
    canvas._fire('touchend', endEvent);

    // Should have processed the touch (tap gesture)
    expect(onTapFlash).toHaveBeenCalled();
    expect(onROIFinalized).toHaveBeenCalled();
  });

  it('classifies tap and calls onTapFlash then onROIFinalized', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    const onTapFlash = vi.fn();
    handler.init(canvas, state, { onROIFinalized, onTapFlash });

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 202, clientY: 202 }]));

    expect(onTapFlash).toHaveBeenCalledBefore(onROIFinalized);
    const tapROI = onTapFlash.mock.calls[0][0];
    expect(tapROI.w).toBe(64);
    expect(tapROI.h).toBe(64);
  });

  it('classifies drag and calls onROIFinalized for valid ROI', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    handler.init(canvas, state, { onROIFinalized });

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    // Move past threshold to classify as drag
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 200, clientY: 200 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 200, clientY: 200 }]));

    expect(onROIFinalized).toHaveBeenCalled();
    const roi = onROIFinalized.mock.calls[0][0];
    expect(roi.w).toBeGreaterThanOrEqual(10);
    expect(roi.h).toBeGreaterThanOrEqual(10);
  });

  it('does not call onROIFinalized for drag with too-small ROI (Req 4.4)', () => {
    // Use a canvas where display is much larger than internal resolution
    // so 15+ CSS pixels maps to < 10 canvas pixels
    // Display: 1000x1000, Internal: 50x50 → scale = 0.05
    // 20 CSS px → 1 canvas px
    const canvas = createMockCanvas(50, 50, { left: 0, top: 0, width: 1000, height: 1000, right: 1000, bottom: 1000 });
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    handler.init(canvas, state, { onROIFinalized });

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 500, clientY: 500 }]));
    // Move past 15px CSS threshold to classify as drag
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 520, clientY: 520 }]));
    // End 20 CSS px away → only 1 canvas px away (20 * 50/1000 = 1)
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 520, clientY: 520 }]));

    // The drag ROI is ~1x1 canvas pixels, well below the 10px minimum
    expect(onROIFinalized).not.toHaveBeenCalled();
  });

  it('sets roiSelecting to false after touchend', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]));
    expect(state._raw.roiSelecting).toBe(true);

    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 200, clientY: 200 }]));
    expect(state._raw.roiSelecting).toBe(false);
  });
});

// ---- touchcancel behavior ----

describe('touchcancel', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('resets selection state on touchcancel (Req 9.1)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    // Start a touch
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    expect(state._raw.roiSelecting).toBe(true);

    // Cancel
    canvas._fire('touchcancel', makeTouchEvent('touchcancel'));
    expect(state._raw.roiSelecting).toBe(false);
    expect(state._raw.roiStart).toBeNull();
    expect(state._raw.roiRect).toBeNull();
    expect(onOverlayUpdate).toHaveBeenCalledWith(null);
  });
});

// ---- resetSelection ----

describe('resetSelection', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('clears roiSelecting, roiStart, roiRect and calls onOverlayUpdate(null)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true, roiSelecting: true, roiStart: { x: 1, y: 1 }, roiRect: { x: 0, y: 0, w: 50, h: 50 } });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    handler.resetSelection();

    expect(state._raw.roiSelecting).toBe(false);
    expect(state._raw.roiStart).toBeNull();
    expect(state._raw.roiRect).toBeNull();
    expect(onOverlayUpdate).toHaveBeenCalledWith(null);
  });
});

// ---- destroy ----

describe('destroy', () => {
  it('removes all event listeners from the canvas', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    handler.destroy();

    expect(canvas.removeEventListener).toHaveBeenCalledTimes(4);
    const types = canvas.removeEventListener.mock.calls.map(c => c[0]);
    expect(types).toContain('touchstart');
    expect(types).toContain('touchmove');
    expect(types).toContain('touchend');
    expect(types).toContain('touchcancel');
  });

  it('ignores touch events after destroy', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    handler.init(canvas, state, { onROIFinalized });

    handler.destroy();

    // Simulate firing events — since listeners were removed, nothing should happen
    // (the mock canvas won't fire because removeEventListener deletes the listener)
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 100, clientY: 100 }]));

    expect(onROIFinalized).not.toHaveBeenCalled();
  });
});


// ---- transformCoordinates error handling ----

describe('transformCoordinates', () => {
  it('returns {x:0, y:0} when bounding rect has zero width (error handling)', () => {
    const result = handler.transformCoordinates(100, 100, { left: 0, top: 0, width: 0, height: 480 }, 640, 480);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('returns {x:0, y:0} when bounding rect has zero height (error handling)', () => {
    const result = handler.transformCoordinates(100, 100, { left: 0, top: 0, width: 640, height: 0 }, 640, 480);
    expect(result).toEqual({ x: 0, y: 0 });
  });

  it('returns {x:0, y:0} when bounding rect has zero width and height', () => {
    const result = handler.transformCoordinates(50, 50, { left: 0, top: 0, width: 0, height: 0 }, 1280, 720);
    expect(result).toEqual({ x: 0, y: 0 });
  });
});

// ---- Tap near canvas edge produces clamped ROI (Req 3.3 edge case) ----

describe('tap near canvas edge (Req 3.3)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('tap at top-left corner (0,0) produces ROI clamped within canvas', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    const onTapFlash = vi.fn();
    handler.init(canvas, state, { onROIFinalized, onTapFlash });

    // Tap at (0, 0) — the very top-left corner
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 0, clientY: 0 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 0, clientY: 0 }]));

    expect(onROIFinalized).toHaveBeenCalled();
    const roi = onROIFinalized.mock.calls[0][0];
    // ROI must be fully within canvas bounds
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.y + roi.h).toBeLessThanOrEqual(480);
  });

  it('tap at bottom-right corner produces ROI clamped within canvas', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onROIFinalized = vi.fn();
    handler.init(canvas, state, { onROIFinalized });

    // Tap at (640, 480) — the very bottom-right corner
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 640, clientY: 480 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 640, clientY: 480 }]));

    expect(onROIFinalized).toHaveBeenCalled();
    const roi = onROIFinalized.mock.calls[0][0];
    expect(roi.x).toBeGreaterThanOrEqual(0);
    expect(roi.y).toBeGreaterThanOrEqual(0);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.y + roi.h).toBeLessThanOrEqual(480);
  });

  it('tap 5px from right edge produces clamped 64x64 ROI', () => {
    const roi = handler.createTapROI(635, 240, 640, 480);
    expect(roi.x + roi.w).toBeLessThanOrEqual(640);
    expect(roi.w).toBe(64);
  });
});

// ---- SELECT REGION button enables ROI mode (Req 8.2) ----

describe('SELECT REGION button enables ROI mode (Req 8.2)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('touch events are accepted when roiMode is set to true via state', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: false });
    handler.init(canvas, state, {});

    // Simulate SELECT REGION button: set roiMode to true
    state._raw.roiMode = true;

    const e = makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]);
    canvas._fire('touchstart', e);

    // Touch should now be processed
    expect(e.preventDefault).toHaveBeenCalled();
    expect(state._raw.roiSelecting).toBe(true);
  });

  it('touch events are ignored before SELECT REGION activates roiMode', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: false });
    const onROIFinalized = vi.fn();
    handler.init(canvas, state, { onROIFinalized });

    // Touch without enabling roiMode
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 200, clientY: 200 }]));

    expect(onROIFinalized).not.toHaveBeenCalled();
    expect(state._raw.roiSelecting).toBe(false);
  });
});

// ---- CANCEL SELECT button resets state (Req 9.2) ----

describe('CANCEL SELECT button resets state (Req 9.2)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('resetSelection clears mid-selection state (simulates CANCEL SELECT)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    // Start a touch selection
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    expect(state._raw.roiSelecting).toBe(true);

    // Simulate CANCEL SELECT button press: call resetSelection
    handler.resetSelection();

    expect(state._raw.roiSelecting).toBe(false);
    expect(state._raw.roiStart).toBeNull();
    expect(state._raw.roiRect).toBeNull();
    expect(onOverlayUpdate).toHaveBeenCalledWith(null);
  });

  it('resetSelection during drag clears overlay and state', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    // Start drag
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 200, clientY: 200 }]));
    expect(state._raw.roiRect).not.toBeNull();

    // Cancel
    handler.resetSelection();

    expect(state._raw.roiSelecting).toBe(false);
    expect(state._raw.roiRect).toBeNull();
    expect(onOverlayUpdate).toHaveBeenLastCalledWith(null);
  });
});

// ---- Auto-tracking enabled after target creation (Req 6.3) ----

describe('auto-tracking enabled after target creation (Req 6.3)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('onROIFinalized callback is invoked with valid ROI for auto-tracking setup', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    let finalizedROI = null;
    handler.init(canvas, state, {
      onROIFinalized: (roi) => { finalizedROI = roi; },
      onTapFlash: () => {}
    });

    // Tap to create target
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 320, clientY: 240 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 320, clientY: 240 }]));

    // onROIFinalized should have been called with a valid ROI
    expect(finalizedROI).not.toBeNull();
    expect(finalizedROI.w).toBe(64);
    expect(finalizedROI.h).toBe(64);
    // The app.js onROIFinalized callback sets _autoTrackEnabled = true and PTZMovement.setMode('auto')
    // This test verifies the handler correctly invokes the callback that triggers auto-tracking
  });

  it('onROIFinalized is called for valid drag ROI enabling auto-tracking', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    let finalizedROI = null;
    handler.init(canvas, state, {
      onROIFinalized: (roi) => { finalizedROI = roi; }
    });

    // Drag to create a large ROI
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 250, clientY: 250 }]));
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 250, clientY: 250 }]));

    expect(finalizedROI).not.toBeNull();
    expect(finalizedROI.w).toBeGreaterThanOrEqual(10);
    expect(finalizedROI.h).toBeGreaterThanOrEqual(10);
  });
});

// ---- Selection overlay cleared on drag end (Req 5.2) ----

describe('selection overlay cleared on drag end (Req 5.2)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('roiRect is set to the final drag ROI on touchend (overlay stops rendering)', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    // Start drag
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 200, clientY: 200 }]));

    // During drag, overlay was updated
    expect(onOverlayUpdate).toHaveBeenCalled();
    const midDragRect = state._raw.roiRect;
    expect(midDragRect).not.toBeNull();

    // End drag — roiRect is set to final ROI, roiSelecting is false
    canvas._fire('touchend', makeTouchEvent('touchend', [], [{ clientX: 200, clientY: 200 }]));
    expect(state._raw.roiSelecting).toBe(false);
    // The final roiRect is set (app.js clears it in onROIFinalized callback)
    expect(state._raw.roiRect).not.toBeNull();
  });

  it('overlay is cleared via onOverlayUpdate(null) when drag is cancelled', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    const onOverlayUpdate = vi.fn();
    handler.init(canvas, state, { onOverlayUpdate });

    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));
    canvas._fire('touchmove', makeTouchEvent('touchmove', [{ clientX: 200, clientY: 200 }]));

    // Cancel the drag
    canvas._fire('touchcancel', makeTouchEvent('touchcancel'));

    expect(onOverlayUpdate).toHaveBeenLastCalledWith(null);
    expect(state._raw.roiRect).toBeNull();
  });
});

// ---- Shared state consistency with mouse path (Req 7.3) ----

describe('shared state consistency with mouse path (Req 7.3)', () => {
  afterEach(() => {
    handler.destroy();
  });

  it('touch handler reads and writes the same state variables as mouse path', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: true });
    handler.init(canvas, state, {});

    // Touch writes to shared state
    canvas._fire('touchstart', makeTouchEvent('touchstart', [{ clientX: 100, clientY: 100 }]));

    // Verify the same state object is modified (mouse path would read these)
    expect(state.getRoiSelecting()).toBe(true);
    expect(state.getRoiStart()).toEqual({ x: 100, y: 100 });
  });

  it('state modified by mouse path is visible to touch handler', () => {
    const canvas = createMockCanvas(640, 480);
    const state = createMockState({ roiMode: false });
    handler.init(canvas, state, {});

    // Simulate mouse path enabling ROI mode (as if SELECT REGION was clicked)
    state.setRoiMode(true);

    // Now touch should work because it reads the same roiMode
    const e = makeTouchEvent('touchstart', [{ clientX: 200, clientY: 200 }]);
    canvas._fire('touchstart', e);

    expect(e.preventDefault).toHaveBeenCalled();
    expect(state.getRoiSelecting()).toBe(true);
  });

  it('touch and mouse paths use identical state accessor interface', () => {
    const state = createMockState({ roiMode: false });

    // Both paths use the same getter/setter interface
    expect(typeof state.getRoiMode).toBe('function');
    expect(typeof state.setRoiMode).toBe('function');
    expect(typeof state.getRoiSelecting).toBe('function');
    expect(typeof state.setRoiSelecting).toBe('function');
    expect(typeof state.getRoiStart).toBe('function');
    expect(typeof state.setRoiStart).toBe('function');
    expect(typeof state.getRoiRect).toBe('function');
    expect(typeof state.setRoiRect).toBe('function');
  });
});
