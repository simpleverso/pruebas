/*
 * processing.c — WebAssembly pixel processing module
 *
 * Compiled to processing.wasm via clang --target=wasm32 or Emscripten.
 * All functions operate on shared WebAssembly.Memory at specified byte offsets
 * for zero-copy frame transfer between JavaScript and WASM.
 *
 * Memory layout:
 *   - Input RGBA data at inputOffset (4 bytes per pixel)
 *   - Output grayscale/binary data at outputOffset (1 byte per pixel)
 *
 * Requirements: 3.1, 3.4, 3.5
 */

/* Access the linear memory as a byte array */
extern unsigned char __heap_base;

static unsigned char *memory = (unsigned char *)0;

/* ---------- Math helpers (avoid libc dependency for small WASM) ---------- */

static double _sqrt(double x) {
    if (x <= 0.0) return 0.0;
    double guess = x * 0.5;
    for (int i = 0; i < 20; i++) {
        guess = 0.5 * (guess + x / guess);
    }
    return guess;
}

static int _clamp(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

static int _abs(int v) {
    return v < 0 ? -v : v;
}

/* ========================================================================
 * grayscale — Convert RGBA (4 bytes/pixel) to single-channel luminance (1 byte/pixel)
 * Formula: Y = 0.299*R + 0.587*G + 0.114*B
 * ======================================================================== */
__attribute__((export_name("grayscale")))
void grayscale(int inputOffset, int outputOffset, int width, int height) {
    int totalPixels = width * height;
    unsigned char *in  = memory + inputOffset;
    unsigned char *out = memory + outputOffset;

    for (int i = 0; i < totalPixels; i++) {
        int idx = i * 4;
        unsigned char r = in[idx];
        unsigned char g = in[idx + 1];
        unsigned char b = in[idx + 2];
        /* Use fixed-point arithmetic for speed: multiply by 256 scale */
        /* 0.299*256=76.544, 0.587*256=150.272, 0.114*256=29.184 */
        int lum = (77 * r + 150 * g + 29 * b) >> 8;
        out[i] = (unsigned char)_clamp(lum, 0, 255);
    }
}

/* ========================================================================
 * binarize — Threshold a grayscale image to binary (0 or 255)
 * Input: 1 byte/pixel grayscale at inputOffset
 * Output: 1 byte/pixel binary at outputOffset
 * pixel >= threshold → 255, else → 0
 * ======================================================================== */
__attribute__((export_name("binarize")))
void binarize(int inputOffset, int outputOffset, int width, int height, int threshold) {
    int totalPixels = width * height;
    unsigned char *in  = memory + inputOffset;
    unsigned char *out = memory + outputOffset;

    for (int i = 0; i < totalPixels; i++) {
        out[i] = (in[i] >= (unsigned char)threshold) ? 255 : 0;
    }
}

/* ========================================================================
 * sobel — 3×3 Sobel gradient magnitude edge detection
 * Input: 1 byte/pixel grayscale at inputOffset
 * Output: 1 byte/pixel gradient magnitude at outputOffset
 *
 * Gx kernel: [[-1,0,1],[-2,0,2],[-1,0,1]]
 * Gy kernel: [[-1,-2,-1],[0,0,0],[1,2,1]]
 * Output = sqrt(Gx² + Gy²), clamped to [0, 255]
 * ======================================================================== */
__attribute__((export_name("sobel")))
void sobel(int inputOffset, int outputOffset, int width, int height) {
    unsigned char *in  = memory + inputOffset;
    unsigned char *out = memory + outputOffset;

    /* Border pixels are set to 0 */
    for (int x = 0; x < width; x++) {
        out[x] = 0;                              /* top row */
        out[(height - 1) * width + x] = 0;       /* bottom row */
    }
    for (int y = 0; y < height; y++) {
        out[y * width] = 0;                       /* left column */
        out[y * width + (width - 1)] = 0;         /* right column */
    }

    for (int y = 1; y < height - 1; y++) {
        for (int x = 1; x < width - 1; x++) {
            /* Read 3×3 neighborhood */
            int p00 = in[(y - 1) * width + (x - 1)];
            int p01 = in[(y - 1) * width + x];
            int p02 = in[(y - 1) * width + (x + 1)];
            int p10 = in[y * width + (x - 1)];
            /* p11 = center, not used in Sobel */
            int p12 = in[y * width + (x + 1)];
            int p20 = in[(y + 1) * width + (x - 1)];
            int p21 = in[(y + 1) * width + x];
            int p22 = in[(y + 1) * width + (x + 1)];

            /* Gx = [[-1,0,1],[-2,0,2],[-1,0,1]] */
            int gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;

            /* Gy = [[-1,-2,-1],[0,0,0],[1,2,1]] */
            int gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

            int mag = (int)_sqrt((double)(gx * gx + gy * gy));
            out[y * width + x] = (unsigned char)_clamp(mag, 0, 255);
        }
    }
}

/* ========================================================================
 * canny — Multi-stage Canny edge detection
 * Input: 1 byte/pixel grayscale at inputOffset
 * Output: 1 byte/pixel edge map at outputOffset
 *
 * Stages:
 *   1. Gaussian blur (3×3 kernel)
 *   2. Sobel gradient magnitude and direction
 *   3. Non-maximum suppression
 *   4. Hysteresis thresholding (lowThresh, highThresh)
 *
 * Uses scratch space after outputOffset for intermediate buffers:
 *   - blurred:   outputOffset + (width*height)
 *   - magnitude: outputOffset + 2*(width*height)
 *   - direction: outputOffset + 3*(width*height)
 * Caller must ensure enough memory is available.
 * ======================================================================== */
__attribute__((export_name("canny")))
void canny(int inputOffset, int outputOffset, int width, int height,
           int lowThresh, int highThresh) {
    unsigned char *in  = memory + inputOffset;
    unsigned char *out = memory + outputOffset;

    int size = width * height;

    /* Scratch buffers placed after the output region */
    unsigned char *blurred   = out + size;
    unsigned char *magnitude = out + 2 * size;
    unsigned char *direction = out + 3 * size;  /* 0=horiz, 1=diag45, 2=vert, 3=diag135 */

    /* ---- Stage 1: Gaussian blur (3×3 kernel, approximation) ----
     * Kernel: [[1,2,1],[2,4,2],[1,2,1]] / 16
     */
    /* Clear borders */
    for (int x = 0; x < width; x++) {
        blurred[x] = in[x];
        blurred[(height - 1) * width + x] = in[(height - 1) * width + x];
    }
    for (int y = 0; y < height; y++) {
        blurred[y * width] = in[y * width];
        blurred[y * width + (width - 1)] = in[y * width + (width - 1)];
    }

    for (int y = 1; y < height - 1; y++) {
        for (int x = 1; x < width - 1; x++) {
            int sum =
                1 * in[(y - 1) * width + (x - 1)] +
                2 * in[(y - 1) * width + x] +
                1 * in[(y - 1) * width + (x + 1)] +
                2 * in[y * width + (x - 1)] +
                4 * in[y * width + x] +
                2 * in[y * width + (x + 1)] +
                1 * in[(y + 1) * width + (x - 1)] +
                2 * in[(y + 1) * width + x] +
                1 * in[(y + 1) * width + (x + 1)];
            blurred[y * width + x] = (unsigned char)(sum >> 4);
        }
    }

    /* ---- Stage 2: Sobel gradient magnitude and direction ---- */
    for (int i = 0; i < size; i++) {
        magnitude[i] = 0;
        direction[i] = 0;
    }

    for (int y = 1; y < height - 1; y++) {
        for (int x = 1; x < width - 1; x++) {
            int p00 = blurred[(y - 1) * width + (x - 1)];
            int p01 = blurred[(y - 1) * width + x];
            int p02 = blurred[(y - 1) * width + (x + 1)];
            int p10 = blurred[y * width + (x - 1)];
            int p12 = blurred[y * width + (x + 1)];
            int p20 = blurred[(y + 1) * width + (x - 1)];
            int p21 = blurred[(y + 1) * width + x];
            int p22 = blurred[(y + 1) * width + (x + 1)];

            int gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22;
            int gy = -p00 - 2 * p01 - p02 + p20 + 2 * p21 + p22;

            int mag = (int)_sqrt((double)(gx * gx + gy * gy));
            magnitude[y * width + x] = (unsigned char)_clamp(mag, 0, 255);

            /* Quantize gradient direction into 4 bins:
             * 0 = horizontal (0° or 180°)
             * 1 = diagonal 45° (45° or 225°)
             * 2 = vertical (90° or 270°)
             * 3 = diagonal 135° (135° or 315°)
             *
             * Use |gy|/|gx| ratio to determine angle bucket without atan2.
             */
            int agx = _abs(gx);
            int agy = _abs(gy);

            if (agx == 0 && agy == 0) {
                direction[y * width + x] = 0;
            } else if (agx > 2 * agy) {
                /* Angle near 0° or 180° → horizontal edge, suppress vertically */
                direction[y * width + x] = 0;
            } else if (agy > 2 * agx) {
                /* Angle near 90° → vertical edge, suppress horizontally */
                direction[y * width + x] = 2;
            } else {
                /* Diagonal: determine which diagonal based on sign */
                if ((gx > 0 && gy > 0) || (gx < 0 && gy < 0)) {
                    direction[y * width + x] = 1;  /* 45° */
                } else {
                    direction[y * width + x] = 3;  /* 135° */
                }
            }
        }
    }

    /* ---- Stage 3: Non-maximum suppression ---- */
    /* Write suppressed result into the output buffer */
    for (int i = 0; i < size; i++) {
        out[i] = 0;
    }

    for (int y = 1; y < height - 1; y++) {
        for (int x = 1; x < width - 1; x++) {
            int mag_c = magnitude[y * width + x];
            int n1 = 0, n2 = 0;

            switch (direction[y * width + x]) {
                case 0: /* horizontal edge → compare with pixels above and below */
                    n1 = magnitude[(y - 1) * width + x];
                    n2 = magnitude[(y + 1) * width + x];
                    break;
                case 1: /* 45° diagonal → compare NE and SW */
                    n1 = magnitude[(y - 1) * width + (x + 1)];
                    n2 = magnitude[(y + 1) * width + (x - 1)];
                    break;
                case 2: /* vertical edge → compare with pixels left and right */
                    n1 = magnitude[y * width + (x - 1)];
                    n2 = magnitude[y * width + (x + 1)];
                    break;
                case 3: /* 135° diagonal → compare NW and SE */
                    n1 = magnitude[(y - 1) * width + (x - 1)];
                    n2 = magnitude[(y + 1) * width + (x + 1)];
                    break;
            }

            /* Keep pixel only if it's a local maximum along gradient direction */
            if (mag_c >= n1 && mag_c >= n2) {
                out[y * width + x] = (unsigned char)mag_c;
            }
            /* else remains 0 from initialization */
        }
    }

    /* ---- Stage 4: Hysteresis thresholding ---- */
    /* Two-pass approach:
     * Pass 1: Mark strong edges (>= highThresh) as 255, weak edges (>= lowThresh) as 128, rest as 0
     * Pass 2: Promote weak edges to strong if any 8-neighbor is strong; iterate until stable
     */

    /* Pass 1: classify */
    for (int i = 0; i < size; i++) {
        if (out[i] >= (unsigned char)highThresh) {
            out[i] = 255;
        } else if (out[i] >= (unsigned char)lowThresh) {
            out[i] = 128;
        } else {
            out[i] = 0;
        }
    }

    /* Pass 2: propagate strong edges to connected weak edges */
    /* Iterate until no more changes (simple multi-pass approach) */
    int changed = 1;
    while (changed) {
        changed = 0;
        for (int y = 1; y < height - 1; y++) {
            for (int x = 1; x < width - 1; x++) {
                if (out[y * width + x] == 128) {
                    /* Check 8-connected neighbors for strong edge */
                    if (out[(y - 1) * width + (x - 1)] == 255 ||
                        out[(y - 1) * width + x]       == 255 ||
                        out[(y - 1) * width + (x + 1)] == 255 ||
                        out[y * width + (x - 1)]       == 255 ||
                        out[y * width + (x + 1)]       == 255 ||
                        out[(y + 1) * width + (x - 1)] == 255 ||
                        out[(y + 1) * width + x]       == 255 ||
                        out[(y + 1) * width + (x + 1)] == 255) {
                        out[y * width + x] = 255;
                        changed = 1;
                    }
                }
            }
        }
    }

    /* Final pass: suppress remaining weak edges */
    for (int i = 0; i < size; i++) {
        if (out[i] != 255) {
            out[i] = 0;
        }
    }
}
