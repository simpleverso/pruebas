# Makefile — Compile processing.c to processing.wasm
#
# Primary method: clang with --target=wasm32 (no Emscripten required)
# Alternative: Emscripten (emcc) — see commented section below
#
# Usage:
#   make          — build processing.wasm
#   make clean    — remove compiled output
#
# Exports: grayscale, binarize, sobel, canny
# Requirements: 3.1, 22.4

CC = clang
CFLAGS = --target=wasm32 \
         --no-standard-libraries \
         -O2 \
         -Wl,--no-entry \
         -Wl,--export-all \
         -Wl,--allow-undefined \
         -Wl,--initial-memory=16777216

SRC = processing.c
OUT = processing.wasm

.PHONY: all clean

all: $(OUT)

$(OUT): $(SRC)
	$(CC) $(CFLAGS) -o $(OUT) $(SRC)

clean:
	rm -f $(OUT)

# ---------------------------------------------------------------
# Alternative: Emscripten (emcc)
#
# Uncomment the block below and comment out the clang block above
# if you prefer to use Emscripten for compilation.
#
# CC_EM = emcc
# CFLAGS_EM = -O2 \
#             -s WASM=1 \
#             -s EXPORTED_FUNCTIONS='["_grayscale","_binarize","_sobel","_canny"]' \
#             -s EXPORTED_RUNTIME_METHODS='["ccall","cwrap"]' \
#             -s ALLOW_MEMORY_GROWTH=1 \
#             -s INITIAL_MEMORY=16777216 \
#             -s STANDALONE_WASM=1 \
#             --no-entry
#
# $(OUT): $(SRC)
# 	$(CC_EM) $(CFLAGS_EM) -o $(OUT) $(SRC)
# ---------------------------------------------------------------
