# dxv2 translator (WASM-protected)

The page (`index.html`) loads `loader.js` + `build/translator.wasm`.
All dictionary entries and grammatical rules live encrypted inside the
wasm module — they are never present in any plain `.js` shipped to the
browser.

## Editing dictionary or rules

Edit the original source files as before:

- `scripts/database.js` — Spanish → Zapotec dictionary (a single `dictionary` object)
- `scripts/rules.js` — grammatical / substitution rules (the `translationRules` array)
- `scripts/translator.js` — legacy plain-JS translator (kept for `admin.html` only; not loaded by `index.html`)

These files are **build inputs only** for the public page; they are not
loaded by `index.html`. The `admin.html` tooling still reads
`scripts/database.js` and `scripts/rules.js` directly.

After editing, regenerate the wasm:

```
npm install        # one-time
npm run build      # or: ./scripts/build.sh   (macOS/Linux)   or: scripts\build.bat   (Windows)
```

That runs `scripts/compile_build.js` which:

1. Evaluates `scripts/database.js` + `scripts/rules.js` in a sandbox to capture the data.
2. Serializes everything to a compact binary blob.
3. Generates a fresh 16-byte key, encrypts the blob with a xorshift128+
   keystream, splits the key into 4 fragments and XOR-masks each one,
   and writes those constants into `assembly/keys.ts`.
4. Embeds the encrypted blob (base64) into `assembly/data.ts`.
5. Compiles `assembly/index.ts` to `build/translator.wasm` with
   `--runtime stub --optimize -Oz` and strips debug names.

The output `translator.wasm` is the only artifact that needs to ship.

## Verifying

`scripts/compile_test.js` instantiates `translator.wasm` in Node, runs a handful
of phrases through both the legacy plain-JS implementation and the wasm
implementation, and compares the results:

```
node scripts/compile_test.js
```

## Using the wasm in another web page

You can drop the translator into any HTML page on the same origin.
Three things have to go up to your web host together:

- `loader.js`
- `build/translator.wasm`
- the page that calls `TRANSLATOR.translate(...)`

You may rename the folders or flatten the layout — what matters is
that `loader.js` can fetch the wasm file at the URL you tell it.

### Minimal example

Save this next to `loader.js` and `build/translator.wasm` and open it in
your browser:

```html
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Translator demo</title></head>
<body>
    <input id="in" maxlength="26" placeholder="Spanish (≤26 chars)">
    <button id="go">Translate</button>
    <div id="out"></div>

    <script src="loader.js"></script>
    <script>
        document.getElementById('go').addEventListener('click', async () => {
            const text = document.getElementById('in').value;
            // The wasm itself caps input at 26 characters; longer input
            // returns "" so the UI should also surface that to users.
            const zapotec = await TRANSLATOR.translate(text);
            document.getElementById('out').innerHTML = zapotec || '(too long or empty)';
        });
    </script>
</body>
</html>
```

`TRANSLATOR.translate(text)` returns a `Promise<string>` containing the
HTML-formatted Zapotec output (unknown words are wrapped in `<i>...</i>`
just like in `index.html`). Render it with `.innerHTML` so the italics
display correctly.

### If your wasm lives at a custom path

`loader.js` defaults to `./build/translator.wasm` (relative to the
HTML page). Override the URL once before the first call:

```html
<script src="loader.js"></script>
<script>
    TRANSLATOR.wasmUrl = '/static/translator/translator.wasm';
    // or: '/cdn/v2/translator.wasm', or a full https:// URL on the same origin
</script>
```

Or pass the URL the first time you initialize:

```js
await TRANSLATOR.init('/assets/translator.wasm');
const out = await TRANSLATOR.translate('hola');
```

### Pre-warming for snappy first click

Calling `init()` early (e.g. on `DOMContentLoaded`) downloads and
instantiates the wasm in the background so the first `translate()` call
is instantaneous:

```js
document.addEventListener('DOMContentLoaded', () => {
    TRANSLATOR.init().catch(err => console.error('translator init failed', err));
});
```

`init()` is idempotent; subsequent calls return the same promise.

### Calling from existing JS

If you already have a translation handler somewhere, swap it out for:

```js
async function translate(spanish) {
    return await TRANSLATOR.translate(spanish);
}
```

Inputs longer than 26 characters return an empty string from the wasm,
so add a length check in your UI if you want to display a friendly
message instead of a blank result.

### Serving requirements

- The page and the wasm **must** be served from the same origin
  (CORS is not configured for the wasm).
- The web server should send `application/wasm` for `.wasm` files.
  If it doesn't, `loader.js` automatically falls back to fetching the
  bytes and using `WebAssembly.instantiate()`, which is slightly slower
  but works regardless of MIME type.
- Opening the HTML directly via `file://` works in some browsers but
  fails in others (Chrome blocks `fetch()` on `file://`). Use any
  static-file server for development, e.g. `python3 -m http.server`
  or `npx serve` from the folder containing your HTML.

### Module-style import (optional)

`loader.js` is a plain script that exposes a `window.TRANSLATOR` global,
which is the simplest path. If you prefer ES modules, wrap the same
calls in a small re-exporter:

```js
// translator-bridge.js (your file, in your project)
import './loader.js';
export default window.TRANSLATOR;
```

Then `import translator from './translator-bridge.js';` and call
`translator.translate(...)`.

## Realistic threat model

Anything that runs in the browser must be downloadable, so a determined
reverse-engineer with breakpoints in DevTools can dump the decrypted
blob from linear memory after `translate()` runs. What this build
**does** stop:

- `strings build/translator.wasm` reveals zero dictionary entries
- The only export reachable from JavaScript is `translate(text)`
- A plain `wasm-decompile` dump shows opcodes, not human-readable rules
- The decryption key is not present as a single constant — it must be
  reassembled from four masked fragments before use
- Each rebuild produces a different ciphertext and different key, so
  precomputed extractors don't carry over

What it does **not** stop:

- Setting a breakpoint at `translate()`'s entry, snapshotting linear
  memory, and walking the parsed dictionary structures
- Re-implementing the binary format reader once someone has the source

If full secrecy of the data is critical, the only real fix is keeping
it on a server.
