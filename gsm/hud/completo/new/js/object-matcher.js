// object-matcher.js — ObjectMatcher
// HOG-based descriptor computation, candidate matching, EMA reference update,
// linear motion model, re-identification, partial occlusion handling.
// Provides: computeDescriptor, matchCandidates, updateReferenceDescriptor, predictPosition, configure
// Requirements: 6.1–6.11

/* global globalThis, ConfigManager */
var ObjectMatcher = (function () {
  // ---- Default configuration ----
  var _config = {
    // HOG descriptor
    cellsX: 4,
    cellsY: 4,
    orientationBins: 9,
    // Matching weights
    spatialWeight: 0.4,
    areaWeight: 0.3,
    descriptorWeight: 0.3,
    // Thresholds
    reIdThreshold: 0.6,
    reIdWindowFrames: 30,
    occlusionMinRatio: 0.15,
    occlusionMaxRatio: 0.50,
    // Motion model
    motionDamping: 0.8,
    // Search region
    searchRegionScale: 1.5
  };

  // ---- Lost target store for re-identification ----
  var _lostTargets = []; // { blobId, referenceDescriptor, referenceArea, lastPosition, framesSinceLost }

  // ---- Descriptor length (computed from config) ----
  function _descriptorLength() {
    return _config.cellsX * _config.cellsY * _config.orientationBins;
  }

  // ---- HOG Descriptor Computation ----

  /**
   * Compute a lightweight HOG descriptor from an ImageData region.
   * Divides the bounding box into a fixed grid of cells (cellsX × cellsY),
   * computes unsigned gradient orientations (0–180°) in histogram bins,
   * and L2-normalizes to a fixed-length Float32Array.
   *
   * The descriptor is computed over a fixed-size normalized sampling window
   * regardless of the blob's pixel dimensions (scale invariance).
   *
   * @param {ImageData} region - The full image data
   * @param {{ x: number, y: number, w: number, h: number }} boundingBox
   * @returns {Float32Array} L2-normalized descriptor
   */
  function computeDescriptor(region, boundingBox) {
    var bins = _config.orientationBins;
    var cX = _config.cellsX;
    var cY = _config.cellsY;
    var len = cX * cY * bins;
    var descriptor = new Float32Array(len);

    if (!region || !region.data || !boundingBox) {
      return _l2Normalize(descriptor);
    }

    var imgW = region.width;
    var imgH = region.height;
    var data = region.data; // RGBA Uint8ClampedArray

    // Clamp bounding box to image bounds
    var bx = Math.max(0, Math.floor(boundingBox.x));
    var by = Math.max(0, Math.floor(boundingBox.y));
    var bw = Math.max(1, Math.floor(boundingBox.w));
    var bh = Math.max(1, Math.floor(boundingBox.h));
    if (bx + bw > imgW) bw = imgW - bx;
    if (by + bh > imgH) bh = imgH - by;
    if (bw < 2 || bh < 2) {
      return _l2Normalize(descriptor);
    }

    // Cell dimensions in the bounding box coordinate space
    var cellW = bw / cX;
    var cellH = bh / cY;

    // For each pixel inside the bounding box (excluding 1px border for gradient),
    // compute gradient magnitude and orientation, then accumulate into the
    // appropriate cell's histogram bin.
    for (var py = 1; py < bh - 1; py++) {
      for (var px = 1; px < bw - 1; px++) {
        var imgX = bx + px;
        var imgY = by + py;

        // Compute gradient using central differences on luminance
        var lumC = _luminance(data, imgX, imgY, imgW);
        var lumL = _luminance(data, imgX - 1, imgY, imgW);
        var lumR = _luminance(data, imgX + 1, imgY, imgW);
        var lumU = _luminance(data, imgX, imgY - 1, imgW);
        var lumD = _luminance(data, imgX, imgY + 1, imgW);

        var gx = lumR - lumL;
        var gy = lumD - lumU;
        var mag = Math.sqrt(gx * gx + gy * gy);

        // Unsigned orientation in [0, 180)
        var angle = Math.atan2(gy, gx) * (180 / Math.PI);
        if (angle < 0) angle += 180;
        if (angle >= 180) angle -= 180;

        // Determine which cell this pixel belongs to
        var cellCol = Math.min(Math.floor(px / cellW), cX - 1);
        var cellRow = Math.min(Math.floor(py / cellH), cY - 1);

        // Determine bin (with soft binning via linear interpolation)
        var binWidth = 180 / bins;
        var binCenter = angle / binWidth;
        var binLow = Math.floor(binCenter) % bins;
        var binHigh = (binLow + 1) % bins;
        var frac = binCenter - Math.floor(binCenter);

        var cellOffset = (cellRow * cX + cellCol) * bins;
        descriptor[cellOffset + binLow] += mag * (1 - frac);
        descriptor[cellOffset + binHigh] += mag * frac;
      }
    }

    return _l2Normalize(descriptor);
  }

  /**
   * Get luminance of a pixel at (x, y) from RGBA data.
   * Uses standard luminance: 0.299*R + 0.587*G + 0.114*B
   */
  function _luminance(data, x, y, width) {
    var idx = (y * width + x) * 4;
    return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
  }

  /**
   * L2-normalize a Float32Array in-place and return it.
   * If magnitude is near zero, returns the zero vector.
   */
  function _l2Normalize(arr) {
    var sumSq = 0;
    for (var i = 0; i < arr.length; i++) {
      sumSq += arr[i] * arr[i];
    }
    var mag = Math.sqrt(sumSq);
    if (mag > 1e-10) {
      for (var j = 0; j < arr.length; j++) {
        arr[j] /= mag;
      }
    }
    return arr;
  }

  // ---- Cosine Similarity ----

  /**
   * Compute cosine similarity between two Float32Arrays.
   * Returns value in [-1, 1]. Returns 0 if either vector is zero.
   */
  function _cosineSimilarity(a, b) {
    if (!a || !b || a.length === 0 || b.length === 0) return 0;
    var len = Math.min(a.length, b.length);
    var dot = 0, magA = 0, magB = 0;
    for (var i = 0; i < len; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    if (magA < 1e-10 || magB < 1e-10) return 0;
    return dot / (magA * magB);
  }

  // ---- EMA Reference Descriptor Update ----

  /**
   * Update reference descriptor using exponential moving average.
   * result[i] = alpha * current[i] + (1 - alpha) * reference[i]
   *
   * @param {Float32Array} current - Current frame descriptor
   * @param {Float32Array} reference - Stored reference descriptor
   * @param {number} alpha - Blending factor in (0, 1)
   * @returns {Float32Array} Updated reference descriptor
   */
  function updateReferenceDescriptor(current, reference, alpha) {
    if (!current || !reference) {
      return current || reference || new Float32Array(0);
    }
    var len = Math.min(current.length, reference.length);
    var result = new Float32Array(len);
    for (var i = 0; i < len; i++) {
      result[i] = alpha * current[i] + (1 - alpha) * reference[i];
    }
    return result;
  }

  // ---- Candidate Matching ----

  /**
   * Score and rank candidate blobs against a reference descriptor.
   * Uses weighted combination of spatial distance, area ratio, and descriptor similarity.
   *
   * @param {Float32Array} reference - Reference descriptor of the target
   * @param {Array} candidates - TrackedBlob[] to evaluate
   * @param {{ x: number, y: number, w: number, h: number }} searchRegion - Bounding region to search within
   * @returns {Array} ScoredMatch[] sorted by combinedScore descending
   */
  function matchCandidates(reference, candidates, searchRegion) {
    if (!candidates || candidates.length === 0) return [];

    var results = [];
    var maxDist = Math.sqrt(searchRegion.w * searchRegion.w + searchRegion.h * searchRegion.h) || 1;

    for (var i = 0; i < candidates.length; i++) {
      var blob = candidates[i];

      // Check if candidate is within search region
      if (!_isInsideRegion(blob.centroid, searchRegion)) continue;

      // Spatial score: 1 = at predicted position, 0 = at edge of search region
      var dist = _distFromRegionCenter(blob.centroid, searchRegion);
      var spatialScore = Math.max(0, 1 - (dist / (maxDist / 2)));

      // Area score: ratio of smaller/larger area (1 = same size, 0 = very different)
      var areaScore = _areaRatio(blob.area, searchRegion._referenceArea || blob.area);

      // Descriptor score: cosine similarity mapped to [0, 1]
      var descSim = _cosineSimilarity(reference, blob.descriptor || blob.referenceDescriptor);
      var descriptorScore = Math.max(0, descSim); // clamp negative to 0

      // Weighted combination
      var combinedScore =
        _config.spatialWeight * spatialScore +
        _config.areaWeight * areaScore +
        _config.descriptorWeight * descriptorScore;

      results.push({
        blobId: blob.id,
        spatialScore: spatialScore,
        areaScore: areaScore,
        descriptorScore: descriptorScore,
        combinedScore: combinedScore
      });
    }

    // Sort by combinedScore descending (best match first)
    results.sort(function (a, b) { return b.combinedScore - a.combinedScore; });
    return results;
  }

  /**
   * Check if a point is inside a bounding box region.
   */
  function _isInsideRegion(point, region) {
    return point.x >= region.x &&
           point.x <= region.x + region.w &&
           point.y >= region.y &&
           point.y <= region.y + region.h;
  }

  /**
   * Compute distance from a point to the center of a region.
   */
  function _distFromRegionCenter(point, region) {
    var cx = region.x + region.w / 2;
    var cy = region.y + region.h / 2;
    var dx = point.x - cx;
    var dy = point.y - cy;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Compute area ratio (smaller / larger), returns value in [0, 1].
   */
  function _areaRatio(a, b) {
    if (a <= 0 && b <= 0) return 1;
    var minA = Math.min(a, b);
    var maxA = Math.max(a, b);
    if (maxA === 0) return 1;
    return minA / maxA;
  }

  // ---- Linear Motion Model ----

  /**
   * Predict the next position of a tracked blob using linear motion model.
   * position = (x + vx * damping, y + vy * damping)
   * For skipped frames, extrapolate: (x + vx * k, y + vy * k) where k = framesLost + 1
   *
   * @param {object} blob - TrackedBlob with centroid, velocity, framesLost
   * @returns {{ x: number, y: number }}
   */
  function predictPosition(blob) {
    if (!blob || !blob.centroid) {
      return { x: 0, y: 0 };
    }
    var vx = (blob.velocity && blob.velocity.vx) || 0;
    var vy = (blob.velocity && blob.velocity.vy) || 0;
    var framesAhead = (blob.framesLost || 0) + 1;

    return {
      x: blob.centroid.x + vx * framesAhead,
      y: blob.centroid.y + vy * framesAhead
    };
  }

  // ---- Search Region ----

  /**
   * Compute a search region around a predicted position, scaled by searchRegionScale.
   * @param {{ x: number, y: number }} predicted - Predicted center position
   * @param {{ w: number, h: number }} refSize - Reference bounding box size
   * @param {number} frameWidth
   * @param {number} frameHeight
   * @returns {{ x: number, y: number, w: number, h: number }}
   */
  function computeSearchRegion(predicted, refSize, frameWidth, frameHeight) {
    var scale = _config.searchRegionScale;
    var sw = (refSize.w || 50) * scale;
    var sh = (refSize.h || 50) * scale;
    var sx = predicted.x - sw / 2;
    var sy = predicted.y - sh / 2;

    // Clamp to frame bounds
    if (sx < 0) sx = 0;
    if (sy < 0) sy = 0;
    if (sx + sw > frameWidth) sw = frameWidth - sx;
    if (sy + sh > frameHeight) sh = frameHeight - sy;

    return { x: sx, y: sy, w: sw, h: sh };
  }

  /**
   * Return a full-frame search region (used after target is marked lost).
   */
  function fullFrameSearchRegion(frameWidth, frameHeight) {
    return { x: 0, y: 0, w: frameWidth, h: frameHeight };
  }

  // ---- Partial Occlusion Handling ----

  /**
   * Check if a blob is partially occluded relative to a reference area.
   * Partial occlusion: visible area is between 15% and 50% of reference.
   * @param {number} currentArea
   * @param {number} referenceArea
   * @returns {boolean}
   */
  function isPartiallyOccluded(currentArea, referenceArea) {
    if (referenceArea <= 0) return false;
    var ratio = currentArea / referenceArea;
    return ratio >= _config.occlusionMinRatio && ratio <= _config.occlusionMaxRatio;
  }

  // ---- Re-identification ----

  /**
   * Register a lost target for re-identification.
   * @param {number} blobId
   * @param {Float32Array} referenceDescriptor
   * @param {number} referenceArea
   * @param {{ x: number, y: number }} lastPosition
   */
  function registerLostTarget(blobId, referenceDescriptor, referenceArea, lastPosition) {
    _lostTargets.push({
      blobId: blobId,
      referenceDescriptor: referenceDescriptor,
      referenceArea: referenceArea || 0,
      lastPosition: lastPosition || { x: 0, y: 0 },
      framesSinceLost: 0
    });
  }

  /**
   * Attempt re-identification: scan all blobs against stored lost target descriptors.
   * Returns the matched lost target info and blob, or null.
   *
   * @param {Array} blobs - Current TrackedBlob[]
   * @returns {{ lostTarget: object, matchedBlob: object, similarity: number }|null}
   */
  function attemptReIdentification(blobs) {
    if (!blobs || blobs.length === 0 || _lostTargets.length === 0) return null;

    var bestMatch = null;
    var bestSim = -1;

    for (var t = 0; t < _lostTargets.length; t++) {
      var target = _lostTargets[t];
      if (target.framesSinceLost > _config.reIdWindowFrames) continue;

      for (var b = 0; b < blobs.length; b++) {
        var blob = blobs[b];
        var desc = blob.descriptor || blob.referenceDescriptor;
        if (!desc || desc.length === 0) continue;

        var sim = _cosineSimilarity(target.referenceDescriptor, desc);
        if (sim > _config.reIdThreshold && sim > bestSim) {
          bestSim = sim;
          bestMatch = { lostTarget: target, matchedBlob: blob, similarity: sim };
        }
      }
    }

    return bestMatch;
  }

  /**
   * Advance the frame counter for all lost targets.
   * Remove targets that exceed the re-ID window.
   */
  function tickLostTargets() {
    for (var i = _lostTargets.length - 1; i >= 0; i--) {
      _lostTargets[i].framesSinceLost++;
      if (_lostTargets[i].framesSinceLost > _config.reIdWindowFrames) {
        _lostTargets.splice(i, 1);
      }
    }
  }

  /**
   * Remove a lost target by blob ID (after successful re-identification).
   */
  function removeLostTarget(blobId) {
    for (var i = _lostTargets.length - 1; i >= 0; i--) {
      if (_lostTargets[i].blobId === blobId) {
        _lostTargets.splice(i, 1);
      }
    }
  }

  /**
   * Get all currently stored lost targets.
   * @returns {Array}
   */
  function getLostTargets() {
    return _lostTargets.slice();
  }

  // ---- Configuration ----

  /**
   * Configure matcher parameters. Merges provided params with current config.
   * Also loads from ConfigManager if available.
   *
   * @param {object} params - MatcherConfig partial
   */
  function configure(params) {
    if (params) {
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        if (_config.hasOwnProperty(key) && typeof params[key] === typeof _config[key]) {
          _config[key] = params[key];
        }
      }
    }
    _loadFromConfigManager();
  }

  /**
   * Load matching parameters from ConfigManager if available.
   */
  function _loadFromConfigManager() {
    if (typeof ConfigManager !== 'undefined' && ConfigManager.load) {
      try {
        var cfg = ConfigManager.load();
        if (cfg && cfg.tracker) {
          var t = cfg.tracker;
          if (typeof t.descriptorBins === 'number' && t.descriptorBins > 0) {
            _config.orientationBins = t.descriptorBins;
          }
          if (typeof t.spatialWeight === 'number') _config.spatialWeight = t.spatialWeight;
          if (typeof t.areaWeight === 'number') _config.areaWeight = t.areaWeight;
          if (typeof t.descriptorWeight === 'number') _config.descriptorWeight = t.descriptorWeight;
          if (typeof t.motionDamping === 'number') _config.motionDamping = t.motionDamping;
          if (typeof t.searchRegionScale === 'number') _config.searchRegionScale = t.searchRegionScale;
          if (typeof t.reIdThreshold === 'number') _config.reIdThreshold = t.reIdThreshold;
          if (typeof t.reIdWindowFrames === 'number') _config.reIdWindowFrames = t.reIdWindowFrames;
        }
      } catch (_) { /* ignore */ }
    }
  }

  /**
   * Get current configuration (for testing/inspection).
   * @returns {object}
   */
  function getConfig() {
    var copy = {};
    var keys = Object.keys(_config);
    for (var i = 0; i < keys.length; i++) {
      copy[keys[i]] = _config[keys[i]];
    }
    return copy;
  }

  /**
   * Reset lost targets store (useful for testing or when tracking is restarted).
   */
  function resetLostTargets() {
    _lostTargets = [];
  }

  return {
    computeDescriptor: computeDescriptor,
    matchCandidates: matchCandidates,
    updateReferenceDescriptor: updateReferenceDescriptor,
    predictPosition: predictPosition,
    configure: configure,
    // Additional helpers exposed for integration
    computeSearchRegion: computeSearchRegion,
    fullFrameSearchRegion: fullFrameSearchRegion,
    isPartiallyOccluded: isPartiallyOccluded,
    registerLostTarget: registerLostTarget,
    attemptReIdentification: attemptReIdentification,
    tickLostTargets: tickLostTargets,
    removeLostTarget: removeLostTarget,
    getLostTargets: getLostTargets,
    getConfig: getConfig,
    resetLostTargets: resetLostTargets
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.ObjectMatcher = ObjectMatcher;
}
