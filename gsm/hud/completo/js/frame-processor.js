// frame-processor.js — FrameProcessor
// Image processing pipeline orchestration; delegates to WASM or JS fallback.
// Supports grayscale, binarize, sobel, canny with chaining and hot-reload.
// Provides: init, setPipeline, processFrame, updateParameter, start, stop
// Requirements: 2.1–2.6, 3.2, 3.3

/* global globalThis, BufferPool */
var FrameProcessor = (function () {
  var _wasmModule = null;
  var _pipeline = [];    // Array of { type, params }
  var _running = false;

  // --- Math helpers (match processing.c) ---

  function _sqrt(x) {
    if (x <= 0) return 0;
    var guess = x * 0.5;
    for (var i = 0; i < 20; i++) {
      guess = 0.5 * (guess + x / guess);
    }
    return guess;
  }

  function _clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function _abs(v) {
    return v < 0 ? -v : v;
  }

  // --- JS fallback implementations (match processing.c algorithms) ---

  /**
   * grayscale: RGBA (4 bytes/pixel) → single-channel luminance (1 byte/pixel)
   * Y = (77*R + 150*G + 29*B) >> 8
   */
  function jsGrayscale(input, output, width, height) {
    var inBuf = new Uint8Array(input);
    var outBuf = new Uint8Array(output);
    var totalPixels = width * height;
    for (var i = 0; i < totalPixels; i++) {
      var idx = i * 4;
      var r = inBuf[idx];
      var g = inBuf[idx + 1];
      var b = inBuf[idx + 2];
      var lum = (77 * r + 150 * g + 29 * b) >> 8;
      outBuf[i] = _clamp(lum, 0, 255);
    }
  }

  /**
   * binarize: 1 byte/pixel grayscale → 1 byte/pixel binary
   * pixel >= threshold → 255, else → 0
   */
  function jsBinarize(input, output, width, height, threshold) {
    var inBuf = new Uint8Array(input);
    var outBuf = new Uint8Array(output);
    var totalPixels = width * height;
    for (var i = 0; i < totalPixels; i++) {
      outBuf[i] = (inBuf[i] >= threshold) ? 255 : 0;
    }
  }

  /**
   * sobel: 3×3 Sobel gradient magnitude edge detection
   * Input: 1 byte/pixel grayscale, Output: 1 byte/pixel gradient magnitude
   */
  function jsSobel(input, output, width, height) {
    var inBuf = new Uint8Array(input);
    var outBuf = new Uint8Array(output);

    // Border pixels set to 0
    for (var x = 0; x < width; x++) {
      outBuf[x] = 0;
      outBuf[(height - 1) * width + x] = 0;
    }
    for (var y = 0; y < height; y++) {
      outBuf[y * width] = 0;
      outBuf[y * width + (width - 1)] = 0;
    }

    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        var p00 = inBuf[(y - 1) * width + (x - 1)];
        var p01 = inBuf[(y - 1) * width + x];
        var p02 = inBuf[(y - 1) * width + (x + 1)];
        var p10 = inBuf[y * width + (x - 1)];
        var p12 = inBuf[y * width + (x + 1)];
        var p20 = inBuf[(y + 1) * width + (x - 1)];
        var p21 = inBuf[(y + 1) * width + x];
        var p22 = inBuf[(y + 1) * width + (x + 1)];

        var gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
        var gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

        var mag = _sqrt(gx * gx + gy * gy) | 0;
        outBuf[y * width + x] = _clamp(mag, 0, 255);
      }
    }
  }

  /**
   * canny: Multi-stage Canny edge detection
   * Stages: Gaussian blur → Sobel gradient → non-max suppression → hysteresis
   * Input: 1 byte/pixel grayscale, Output: 1 byte/pixel edge map
   */
  function jsCanny(input, output, width, height, lowThresh, highThresh) {
    var inBuf = new Uint8Array(input);
    var outBuf = new Uint8Array(output);
    var size = width * height;

    // Scratch buffers
    var blurred = new Uint8Array(size);
    var magnitude = new Uint8Array(size);
    var direction = new Uint8Array(size);

    // Stage 1: Gaussian blur (3×3 kernel [[1,2,1],[2,4,2],[1,2,1]] / 16)
    // Copy borders
    for (var x = 0; x < width; x++) {
      blurred[x] = inBuf[x];
      blurred[(height - 1) * width + x] = inBuf[(height - 1) * width + x];
    }
    for (var y = 0; y < height; y++) {
      blurred[y * width] = inBuf[y * width];
      blurred[y * width + (width - 1)] = inBuf[y * width + (width - 1)];
    }

    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        var sum =
          1 * inBuf[(y - 1) * width + (x - 1)] +
          2 * inBuf[(y - 1) * width + x] +
          1 * inBuf[(y - 1) * width + (x + 1)] +
          2 * inBuf[y * width + (x - 1)] +
          4 * inBuf[y * width + x] +
          2 * inBuf[y * width + (x + 1)] +
          1 * inBuf[(y + 1) * width + (x - 1)] +
          2 * inBuf[(y + 1) * width + x] +
          1 * inBuf[(y + 1) * width + (x + 1)];
        blurred[y * width + x] = (sum >> 4) & 0xFF;
      }
    }

    // Stage 2: Sobel gradient magnitude and direction
    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        var p00 = blurred[(y - 1) * width + (x - 1)];
        var p01 = blurred[(y - 1) * width + x];
        var p02 = blurred[(y - 1) * width + (x + 1)];
        var p10 = blurred[y * width + (x - 1)];
        var p12 = blurred[y * width + (x + 1)];
        var p20 = blurred[(y + 1) * width + (x - 1)];
        var p21 = blurred[(y + 1) * width + x];
        var p22 = blurred[(y + 1) * width + (x + 1)];

        var gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
        var gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

        var mag = _sqrt(gx * gx + gy * gy) | 0;
        magnitude[y * width + x] = _clamp(mag, 0, 255);

        // Quantize gradient direction into 4 bins
        var agx = _abs(gx);
        var agy = _abs(gy);

        if (agx === 0 && agy === 0) {
          direction[y * width + x] = 0;
        } else if (agx > 2 * agy) {
          direction[y * width + x] = 0; // horizontal
        } else if (agy > 2 * agx) {
          direction[y * width + x] = 2; // vertical
        } else {
          if ((gx > 0 && gy > 0) || (gx < 0 && gy < 0)) {
            direction[y * width + x] = 1; // 45°
          } else {
            direction[y * width + x] = 3; // 135°
          }
        }
      }
    }

    // Stage 3: Non-maximum suppression
    for (var i = 0; i < size; i++) {
      outBuf[i] = 0;
    }

    for (var y = 1; y < height - 1; y++) {
      for (var x = 1; x < width - 1; x++) {
        var mag_c = magnitude[y * width + x];
        var n1 = 0, n2 = 0;

        switch (direction[y * width + x]) {
          case 0:
            n1 = magnitude[(y - 1) * width + x];
            n2 = magnitude[(y + 1) * width + x];
            break;
          case 1:
            n1 = magnitude[(y - 1) * width + (x + 1)];
            n2 = magnitude[(y + 1) * width + (x - 1)];
            break;
          case 2:
            n1 = magnitude[y * width + (x - 1)];
            n2 = magnitude[y * width + (x + 1)];
            break;
          case 3:
            n1 = magnitude[(y - 1) * width + (x - 1)];
            n2 = magnitude[(y + 1) * width + (x + 1)];
            break;
        }

        if (mag_c >= n1 && mag_c >= n2) {
          outBuf[y * width + x] = mag_c;
        }
      }
    }

    // Stage 4: Hysteresis thresholding
    // Pass 1: classify
    for (var i = 0; i < size; i++) {
      if (outBuf[i] >= highThresh) {
        outBuf[i] = 255;
      } else if (outBuf[i] >= lowThresh) {
        outBuf[i] = 128;
      } else {
        outBuf[i] = 0;
      }
    }

    // Pass 2: propagate strong edges to connected weak edges
    var changed = 1;
    while (changed) {
      changed = 0;
      for (var y = 1; y < height - 1; y++) {
        for (var x = 1; x < width - 1; x++) {
          if (outBuf[y * width + x] === 128) {
            if (outBuf[(y - 1) * width + (x - 1)] === 255 ||
                outBuf[(y - 1) * width + x]       === 255 ||
                outBuf[(y - 1) * width + (x + 1)] === 255 ||
                outBuf[y * width + (x - 1)]       === 255 ||
                outBuf[y * width + (x + 1)]       === 255 ||
                outBuf[(y + 1) * width + (x - 1)] === 255 ||
                outBuf[(y + 1) * width + x]       === 255 ||
                outBuf[(y + 1) * width + (x + 1)] === 255) {
              outBuf[y * width + x] = 255;
              changed = 1;
            }
          }
        }
      }
    }

    // Final pass: suppress remaining weak edges
    for (var i = 0; i < size; i++) {
      if (outBuf[i] !== 255) {
        outBuf[i] = 0;
      }
    }
  }

  // --- WASM delegation helpers ---

  function wasmGrayscale(wasmMod, input, output, width, height) {
    var mem = new Uint8Array(wasmMod.getMemory().buffer);
    var inView = new Uint8Array(input);
    var totalPixels = width * height;
    var inputOffset = 0;
    var outputOffset = totalPixels * 4;
    mem.set(inView.subarray(0, totalPixels * 4), inputOffset);
    wasmMod.grayscale(inputOffset, outputOffset, width, height);
    var outView = new Uint8Array(output);
    outView.set(mem.subarray(outputOffset, outputOffset + totalPixels));
  }

  function wasmBinarize(wasmMod, input, output, width, height, threshold) {
    var mem = new Uint8Array(wasmMod.getMemory().buffer);
    var inView = new Uint8Array(input);
    var totalPixels = width * height;
    var inputOffset = 0;
    var outputOffset = totalPixels;
    mem.set(inView.subarray(0, totalPixels), inputOffset);
    wasmMod.binarize(inputOffset, outputOffset, width, height, threshold);
    var outView = new Uint8Array(output);
    outView.set(mem.subarray(outputOffset, outputOffset + totalPixels));
  }

  function wasmSobel(wasmMod, input, output, width, height) {
    var mem = new Uint8Array(wasmMod.getMemory().buffer);
    var inView = new Uint8Array(input);
    var totalPixels = width * height;
    var inputOffset = 0;
    var outputOffset = totalPixels;
    mem.set(inView.subarray(0, totalPixels), inputOffset);
    wasmMod.sobel(inputOffset, outputOffset, width, height);
    var outView = new Uint8Array(output);
    outView.set(mem.subarray(outputOffset, outputOffset + totalPixels));
  }

  function wasmCanny(wasmMod, input, output, width, height, lowThresh, highThresh) {
    var mem = new Uint8Array(wasmMod.getMemory().buffer);
    var inView = new Uint8Array(input);
    var totalPixels = width * height;
    var inputOffset = 0;
    var outputOffset = totalPixels;
    // Canny needs scratch space: output + 3 * size after outputOffset
    mem.set(inView.subarray(0, totalPixels), inputOffset);
    wasmMod.canny(inputOffset, outputOffset, width, height, lowThresh, highThresh);
    var outView = new Uint8Array(output);
    outView.set(mem.subarray(outputOffset, outputOffset + totalPixels));
  }

  // --- Core dispatch: run a single operation ---

  function runOperation(op, input, output, width, height) {
    var type = op.type;
    var params = op.params || {};

    if (_wasmModule) {
      switch (type) {
        case 'grayscale':
          wasmGrayscale(_wasmModule, input, output, width, height);
          return;
        case 'binarize':
          wasmBinarize(_wasmModule, input, output, width, height, params.threshold || 128);
          return;
        case 'sobel':
          wasmSobel(_wasmModule, input, output, width, height);
          return;
        case 'canny':
          wasmCanny(_wasmModule, input, output, width, height,
            params.lowThreshold || 50, params.highThreshold || 150);
          return;
      }
    }

    // JS fallback
    switch (type) {
      case 'grayscale':
        jsGrayscale(input, output, width, height);
        break;
      case 'binarize':
        jsBinarize(input, output, width, height, params.threshold || 128);
        break;
      case 'sobel':
        jsSobel(input, output, width, height);
        break;
      case 'canny':
        jsCanny(input, output, width, height,
          params.lowThreshold || 50, params.highThreshold || 150);
        break;
    }
  }

  // --- Determine output size for a given operation ---
  // grayscale: RGBA input → 1 byte/pixel output
  // binarize, sobel, canny: 1 byte/pixel input → 1 byte/pixel output
  function getOutputSize(opType, width, height) {
    return width * height; // all operations produce 1 byte/pixel
  }

  // --- Public API ---

  /**
   * Initialize the FrameProcessor.
   * @param {object|null} wasmModule - WasmModule instance or null for JS-only mode
   */
  function init(wasmModule) {
    _wasmModule = wasmModule || null;
    _pipeline = [];
    _running = false;
  }

  /**
   * Set the processing pipeline (ordered list of operations).
   * @param {Array<{type: string, params: object}>} operations
   */
  function setPipeline(operations) {
    _pipeline = (operations || []).map(function (op) {
      return { type: op.type, params: Object.assign({}, op.params || {}) };
    });
  }

  /**
   * Process a single frame through the pipeline.
   * Input is RGBA (4 bytes/pixel). Output receives the final processed result.
   * Chain operations using intermediate buffers from BufferPool.
   * @param {ArrayBuffer} input - RGBA frame data
   * @param {ArrayBuffer} output - destination for final result
   * @param {number} width - frame width in pixels
   * @param {number} height - frame height in pixels
   */
  function processFrame(input, output, width, height) {
    if (!_running) return;
    if (_pipeline.length === 0) return;

    var pool = (typeof globalThis !== 'undefined' && globalThis.BufferPool) ? globalThis.BufferPool : null;
    var intermediates = [];

    try {
      var currentInput = input;

      // Detect if input is RGBA (4 bytes/pixel) based on buffer size vs frame dimensions
      var inputIsRGBA = (input.byteLength === width * height * 4);

      // Auto-prepend grayscale if first op needs single-channel and input is RGBA
      var effectivePipeline = _pipeline;
      if (inputIsRGBA && _pipeline.length > 0 && _pipeline[0].type !== 'grayscale') {
        effectivePipeline = [{ type: 'grayscale', params: {} }].concat(_pipeline);
      }

      for (var i = 0; i < effectivePipeline.length; i++) {
        var op = effectivePipeline[i];
        var isLast = (i === effectivePipeline.length - 1);
        var currentOutput;

        if (isLast) {
          currentOutput = output;
        } else {
          // Acquire intermediate buffer from pool
          var bufSize = getOutputSize(op.type, width, height);
          if (pool) {
            try {
              currentOutput = pool.acquire();
              intermediates.push(currentOutput);
            } catch (e) {
              // Pool exhausted — allocate a temporary buffer
              currentOutput = new ArrayBuffer(bufSize);
            }
          } else {
            currentOutput = new ArrayBuffer(bufSize);
          }
        }

        runOperation(op, currentInput, currentOutput, width, height);
        currentInput = currentOutput;
      }
    } finally {
      // Release all intermediate buffers back to pool
      if (pool) {
        for (var j = 0; j < intermediates.length; j++) {
          try {
            pool.release(intermediates[j]);
          } catch (e) {
            // Ignore release errors for non-pool buffers
          }
        }
      }
    }
  }

  /**
   * Hot-reload a parameter for a specific operation type.
   * Applied on the next processFrame call without restart.
   * @param {string} operation - operation type ('grayscale', 'binarize', 'sobel', 'canny')
   * @param {string} param - parameter name
   * @param {number} value - new parameter value
   */
  function updateParameter(operation, param, value) {
    for (var i = 0; i < _pipeline.length; i++) {
      if (_pipeline[i].type === operation) {
        _pipeline[i].params[param] = value;
      }
    }
  }

  /**
   * Start the processor (enable processFrame to execute).
   */
  function start() {
    _running = true;
  }

  /**
   * Stop the processor (processFrame becomes a no-op).
   */
  function stop() {
    _running = false;
  }

  return {
    init: init,
    setPipeline: setPipeline,
    getPipeline: function () { return _pipeline; },
    processFrame: processFrame,
    updateParameter: updateParameter,
    start: start,
    stop: stop,
    // Expose JS fallbacks for testing equivalence
    _jsFallback: {
      grayscale: jsGrayscale,
      binarize: jsBinarize,
      sobel: jsSobel,
      canny: jsCanny
    }
  };
})();

// Make available for both browser globals and test imports
if (typeof globalThis !== 'undefined') {
  globalThis.FrameProcessor = FrameProcessor;
}
