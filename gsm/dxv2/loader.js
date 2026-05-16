// Minimal AssemblyScript runtime glue for translator.wasm.
//
// We only need string in / string out, so we implement just enough of the
// AS object header layout to allocate a UTF-16 string and read one back.
// AS string layout in linear memory (with --runtime stub):
//   header at (ptr - 20):
//       i32 mmInfo, i32 gcInfo, i32 gcInfo2, i32 rtId, i32 rtSize
//   ptr itself points to UTF-16LE code units; rtSize is the byte length.

(function () {
    const STRING_ID = 1; // built-in id for `String` under AS stub runtime
    const DEFAULT_WASM_URL = './build/translator.wasm';

    let instance = null;
    let initPromise = null;

    function allocString(str) {
        const exp = instance.exports;
        const ptr = exp.__new(str.length * 2, STRING_ID) >>> 0;
        const u16 = new Uint16Array(exp.memory.buffer, ptr, str.length);
        for (let i = 0; i < str.length; i++) u16[i] = str.charCodeAt(i);
        return ptr;
    }

    function readString(ptr) {
        ptr = ptr >>> 0;
        if (ptr === 0) return '';
        const buf = instance.exports.memory.buffer;
        const byteLen = new Int32Array(buf, ptr - 4, 1)[0] >>> 0;
        const len = byteLen >>> 1;
        const u16 = new Uint16Array(buf, ptr, len);
        const CHUNK = 0x4000;
        let out = '';
        for (let i = 0; i < len; i += CHUNK) {
            out += String.fromCharCode.apply(null, u16.subarray(i, Math.min(i + CHUNK, len)));
        }
        return out;
    }

    async function loadInstance(wasmUrl) {
        const importObject = {
            env: {
                abort: (_msg, _file, line, col) => {
                    throw new Error('wasm abort at ' + line + ':' + col);
                },
                'console.log': () => {},
                seed: () => Date.now(),
            },
        };
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                const resp = fetch(wasmUrl);
                const result = await WebAssembly.instantiateStreaming(resp, importObject);
                return result.instance;
            } catch (_) {
                // fall through to ArrayBuffer path (e.g. wrong MIME type)
            }
        }
        const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer());
        const result = await WebAssembly.instantiate(bytes, importObject);
        return result.instance;
    }

    function init(wasmUrl) {
        if (initPromise) return initPromise;
        const url = wasmUrl || TRANSLATOR.wasmUrl || DEFAULT_WASM_URL;
        initPromise = loadInstance(url).then(inst => { instance = inst; });
        return initPromise;
    }

    async function translate(text) {
        await init();
        const exp = instance.exports;
        const inPtr = allocString(String(text == null ? '' : text));
        const pinned = exp.__pin ? exp.__pin(inPtr) : inPtr;
        let outPtr;
        try {
            outPtr = exp.translate(pinned);
        } finally {
            if (exp.__unpin) exp.__unpin(pinned);
        }
        const result = readString(outPtr);
        if (exp.__collect) exp.__collect();
        return result;
    }

    const TRANSLATOR = { init, translate, wasmUrl: DEFAULT_WASM_URL };

    if (typeof window !== 'undefined') window.TRANSLATOR = TRANSLATOR;
    if (typeof module !== 'undefined' && module.exports) module.exports = TRANSLATOR;
})();
