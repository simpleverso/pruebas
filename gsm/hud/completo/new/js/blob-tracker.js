// blob-tracker.js — BlobTracker
// Connected-component blob detection and frame-to-frame association.
// Provides: init, detectBlobs, associateBlobs, setPrimaryTarget, getPrimaryTarget, getDisplacement, start, stop
// Requirements: 5.1–5.7

/* global globalThis, ConfigManager */
var BlobTracker = (function () {
  // ---- Internal state ----
  var _config = {
    minArea: 50,
    lostFrameThreshold: 10,
    spatialWeight: 0.6,
    areaWeight: 0.4
  };
  var _running = false;
  var _nextId = 1;
  var _primaryTargetId = null;
  var _trackedBlobs = []; // TrackedBlob[]
  var _frameWidth = 0;
  var _frameHeight = 0;

  // ---- Helpers ----

  /**
   * Load tracker config from ConfigManager if available.
   */
  function _loadFromConfig() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg && cfg.tracker) {
          if (typeof cfg.tracker.minArea === 'number' && cfg.tracker.minArea > 0) {
            _config.minArea = cfg.tracker.minArea;
          }
          if (typeof cfg.tracker.lostFrameThreshold === 'number' && cfg.tracker.lostFrameThreshold > 0) {
            _config.lostFrameThreshold = cfg.tracker.lostFrameThreshold;
          }
          if (typeof cfg.tracker.spatialWeight === 'number') {
            _config.spatialWeight = cfg.tracker.spatialWeight;
          }
          if (typeof cfg.tracker.areaWeight === 'number') {
            _config.areaWeight = cfg.tracker.areaWeight;
          }
        }
      } catch (_) { /* ignore */ }
    }
  }


  // ---- Connected-component labeling (flood-fill) ----

  /**
   * Detect connected components in a binary (0/255) frame using flood-fill.
   * Returns an array of raw component data: { pixels, minX, minY, maxX, maxY, sumX, sumY, area }.
   * @param {Uint8Array} data - Binary frame data (0 or 255 per pixel)
   * @param {number} width
   * @param {number} height
   * @returns {Array}
   */
  function _findComponents(data, width, height) {
    var visited = new Uint8Array(width * height);
    var components = [];

    for (var i = 0; i < width * height; i++) {
      if (data[i] === 0 || visited[i]) continue;

      // Flood-fill from this pixel
      var stack = [i];
      visited[i] = 1;
      var pixels = [];
      var sumX = 0, sumY = 0;
      var minX = width, minY = height, maxX = 0, maxY = 0;

      while (stack.length > 0) {
        var idx = stack.pop();
        var px = idx % width;
        var py = (idx - px) / width;

        pixels.push(idx);
        sumX += px;
        sumY += py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;

        // 4-connected neighbors
        var neighbors = [];
        if (px > 0) neighbors.push(idx - 1);
        if (px < width - 1) neighbors.push(idx + 1);
        if (py > 0) neighbors.push(idx - width);
        if (py < height - 1) neighbors.push(idx + width);

        for (var n = 0; n < neighbors.length; n++) {
          var ni = neighbors[n];
          if (!visited[ni] && data[ni] !== 0) {
            visited[ni] = 1;
            stack.push(ni);
          }
        }
      }

      components.push({
        pixels: pixels,
        sumX: sumX,
        sumY: sumY,
        minX: minX,
        minY: minY,
        maxX: maxX,
        maxY: maxY,
        area: pixels.length
      });
    }

    return components;
  }

  /**
   * Build a Blob object from raw component data.
   * @param {object} comp - Raw component from _findComponents
   * @returns {object} Blob
   */
  function _buildBlob(comp) {
    var pixelData = new Uint8Array(comp.pixels.length);
    for (var i = 0; i < comp.pixels.length; i++) {
      pixelData[i] = comp.pixels[i];
    }

    return {
      id: _nextId++,
      centroid: {
        x: comp.sumX / comp.area,
        y: comp.sumY / comp.area
      },
      boundingBox: {
        x: comp.minX,
        y: comp.minY,
        w: comp.maxX - comp.minX + 1,
        h: comp.maxY - comp.minY + 1
      },
      area: comp.area,
      pixels: pixelData
    };
  }


  // ---- Association helpers ----

  /**
   * Compute Euclidean distance between two points.
   */
  function _distance(a, b) {
    var dx = a.x - b.x;
    var dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Compute area similarity score (0–1). 1 = identical area, 0 = very different.
   */
  function _areaSimilarity(areaA, areaB) {
    if (areaA === 0 && areaB === 0) return 1;
    var minA = Math.min(areaA, areaB);
    var maxA = Math.max(areaA, areaB);
    if (maxA === 0) return 1;
    return minA / maxA;
  }

  /**
   * Convert a Blob to a TrackedBlob with default tracking fields.
   * @param {object} blob
   * @returns {object} TrackedBlob
   */
  function _toTrackedBlob(blob) {
    return {
      id: blob.id,
      centroid: { x: blob.centroid.x, y: blob.centroid.y },
      boundingBox: { x: blob.boundingBox.x, y: blob.boundingBox.y, w: blob.boundingBox.w, h: blob.boundingBox.h },
      area: blob.area,
      pixels: blob.pixels,
      velocity: { vx: 0, vy: 0 },
      framesLost: 0,
      descriptor: new Float32Array(0),
      referenceDescriptor: new Float32Array(0)
    };
  }

  // ---- Public API ----

  /**
   * Initialize the blob tracker with configuration.
   * @param {object} config - TrackerConfig
   */
  function init(config) {
    if (config) {
      if (typeof config.minArea === 'number' && config.minArea > 0) {
        _config.minArea = config.minArea;
      }
      if (typeof config.lostFrameThreshold === 'number' && config.lostFrameThreshold > 0) {
        _config.lostFrameThreshold = config.lostFrameThreshold;
      }
      if (typeof config.spatialWeight === 'number') {
        _config.spatialWeight = config.spatialWeight;
      }
      if (typeof config.areaWeight === 'number') {
        _config.areaWeight = config.areaWeight;
      }
    }
    _trackedBlobs = [];
    _primaryTargetId = null;
    _nextId = 1;
    _frameWidth = 0;
    _frameHeight = 0;
  }

  /**
   * Detect blobs in a binary frame.
   * Connected-component labeling via flood-fill on binary (0/255) data.
   * Filters by minimum area threshold. Computes centroid, bounding box, area.
   * Req 5.1, 5.2
   *
   * @param {ArrayBuffer} frame - Binary frame data
   * @param {number} width
   * @param {number} height
   * @returns {Array} Blob[]
   */
  function detectBlobs(frame, width, height) {
    _frameWidth = width;
    _frameHeight = height;

    var data = new Uint8Array(frame);
    var components = _findComponents(data, width, height);

    var blobs = [];
    for (var i = 0; i < components.length; i++) {
      if (components[i].area >= _config.minArea) {
        blobs.push(_buildBlob(components[i]));
      }
    }

    return blobs;
  }


  /**
   * Associate current blobs with previously tracked blobs using greedy
   * nearest-neighbor weighted by centroid distance and area similarity.
   * No blob is matched to two targets.
   * Increments framesLost for unmatched previous blobs.
   * Removes blobs whose framesLost exceeds threshold.
   * Req 5.3, 5.5
   *
   * @param {Array} currentBlobs - Blob[]
   * @param {Array} previousBlobs - TrackedBlob[]
   * @returns {Array} TrackedBlob[]
   */
  function associateBlobs(currentBlobs, previousBlobs) {
    if (!previousBlobs || previousBlobs.length === 0) {
      // No previous blobs — all current blobs become new tracked blobs
      var newTracked = [];
      for (var i = 0; i < currentBlobs.length; i++) {
        newTracked.push(_toTrackedBlob(currentBlobs[i]));
      }
      _trackedBlobs = newTracked;
      return _trackedBlobs;
    }

    if (!currentBlobs || currentBlobs.length === 0) {
      // No current blobs — increment framesLost for all previous
      var surviving = [];
      for (var p = 0; p < previousBlobs.length; p++) {
        var tb = previousBlobs[p];
        tb.framesLost++;
        if (tb.framesLost <= _config.lostFrameThreshold) {
          surviving.push(tb);
        }
      }
      _trackedBlobs = surviving;
      return _trackedBlobs;
    }

    // Compute cost matrix: lower cost = better match
    // cost = spatialWeight * normalizedDistance + areaWeight * (1 - areaSimilarity)
    var maxDist = Math.sqrt(_frameWidth * _frameWidth + _frameHeight * _frameHeight) || 1;
    var costs = [];
    for (var ci = 0; ci < currentBlobs.length; ci++) {
      costs[ci] = [];
      for (var pi = 0; pi < previousBlobs.length; pi++) {
        var dist = _distance(currentBlobs[ci].centroid, previousBlobs[pi].centroid);
        var normDist = dist / maxDist;
        var areaSim = _areaSimilarity(currentBlobs[ci].area, previousBlobs[pi].area);
        costs[ci][pi] = _config.spatialWeight * normDist + _config.areaWeight * (1 - areaSim);
      }
    }

    // Greedy nearest-neighbor matching
    var matchedCurrent = new Set();
    var matchedPrevious = new Set();
    var assignments = []; // { currentIdx, previousIdx, cost }

    // Build flat list of all pairs sorted by cost
    var pairs = [];
    for (var ci2 = 0; ci2 < currentBlobs.length; ci2++) {
      for (var pi2 = 0; pi2 < previousBlobs.length; pi2++) {
        pairs.push({ ci: ci2, pi: pi2, cost: costs[ci2][pi2] });
      }
    }
    pairs.sort(function (a, b) { return a.cost - b.cost; });

    for (var k = 0; k < pairs.length; k++) {
      var pair = pairs[k];
      if (matchedCurrent.has(pair.ci) || matchedPrevious.has(pair.pi)) continue;
      matchedCurrent.add(pair.ci);
      matchedPrevious.add(pair.pi);
      assignments.push(pair);
    }

    // Build result
    var result = [];

    // Matched blobs: update tracked blob with new position, compute velocity
    for (var a = 0; a < assignments.length; a++) {
      var assign = assignments[a];
      var cur = currentBlobs[assign.ci];
      var prev = previousBlobs[assign.pi];

      var tracked = _toTrackedBlob(cur);
      tracked.id = prev.id; // preserve ID for continuity
      tracked.velocity = {
        vx: cur.centroid.x - prev.centroid.x,
        vy: cur.centroid.y - prev.centroid.y
      };
      tracked.framesLost = 0;
      tracked.descriptor = prev.descriptor;
      tracked.referenceDescriptor = prev.referenceDescriptor;
      result.push(tracked);
    }

    // Unmatched current blobs: new tracked blobs
    for (var ci3 = 0; ci3 < currentBlobs.length; ci3++) {
      if (!matchedCurrent.has(ci3)) {
        result.push(_toTrackedBlob(currentBlobs[ci3]));
      }
    }

    // Unmatched previous blobs: increment framesLost, keep if under threshold
    for (var pi3 = 0; pi3 < previousBlobs.length; pi3++) {
      if (!matchedPrevious.has(pi3)) {
        var lost = previousBlobs[pi3];
        lost.framesLost++;
        if (lost.framesLost <= _config.lostFrameThreshold) {
          result.push(lost);
        } else {
          // If the lost blob was the primary target, clear it
          if (_primaryTargetId === lost.id) {
            _primaryTargetId = null;
          }
        }
      }
    }

    _trackedBlobs = result;
    return _trackedBlobs;
  }

  /**
   * Set the primary target blob by ID.
   * Req 5.6
   * @param {number} blobId
   */
  function setPrimaryTarget(blobId) {
    _primaryTargetId = blobId;
  }

  /**
   * Get the current primary target TrackedBlob, or null if none.
   * @returns {object|null} TrackedBlob or null
   */
  function getPrimaryTarget() {
    if (_primaryTargetId === null) return null;
    for (var i = 0; i < _trackedBlobs.length; i++) {
      if (_trackedBlobs[i].id === _primaryTargetId) {
        return _trackedBlobs[i];
      }
    }
    return null;
  }

  /**
   * Compute displacement vector of primary target centroid from frame center.
   * Returns { dx, dy } or null if no primary target.
   * Req 5.4
   * @returns {{ dx: number, dy: number }|null}
   */
  function getDisplacement() {
    var target = getPrimaryTarget();
    if (!target) return null;
    var centerX = _frameWidth / 2;
    var centerY = _frameHeight / 2;
    return {
      dx: target.centroid.x - centerX,
      dy: target.centroid.y - centerY
    };
  }

  /**
   * Start the blob tracker.
   */
  function start() {
    _running = true;
    _loadFromConfig();
  }

  /**
   * Stop the blob tracker and clear state.
   */
  function stop() {
    _running = false;
    _trackedBlobs = [];
    _primaryTargetId = null;
  }

  return {
    init: init,
    detectBlobs: detectBlobs,
    associateBlobs: associateBlobs,
    setPrimaryTarget: setPrimaryTarget,
    getPrimaryTarget: getPrimaryTarget,
    getDisplacement: getDisplacement,
    start: start,
    stop: stop
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.BlobTracker = BlobTracker;
}
