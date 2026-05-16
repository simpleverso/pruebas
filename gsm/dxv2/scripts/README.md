# Build Environment Setup

This folder contains everything needed to regenerate `build/translator.wasm`
from the editable sources `database.js` and `rules.js`.

You only need to set this up on the machine that **builds** the wasm. The
public page (`index.html`) just loads the prebuilt `translator.wasm`, so
end users do not need any of this.

---

## Required tools

| Tool | Minimum version | Verified version | Why |
| --- | --- | --- | --- |
| Node.js | **18 LTS** or newer | 24.14.1 | Runs the build script and the AssemblyScript compiler |
| npm | ships with Node.js | 11.11.0 | Installs the AssemblyScript toolchain |

That is the entire required toolchain. There is **no** Rust, no Python,
no Emscripten, no global wasm tooling to install. Everything else is a
plain npm dependency that gets pulled in automatically the first time
you build.

### Operating systems

The build runs on:

- macOS (tested on darwin / Apple Silicon and Intel)
- Linux (any distro with a recent Node.js package)
- Windows 10 / 11 (use `scripts\build.bat`)

No system-level compilers or build tools are needed — the wasm is
produced by AssemblyScript, which is pure JavaScript and runs entirely
inside Node.

---

## Installing Node.js

If you do not already have Node.js installed, pick one option:

### Option A — official installer (recommended for new users)

1. Go to <https://nodejs.org/>
2. Download the **LTS** build for your operating system.
3. Run the installer. Accept the defaults; this also installs `npm`.
4. Open a fresh terminal and verify:
   ```
   node --version
   npm --version
   ```
   Both commands should print a version. If they do not, restart your
   terminal so PATH updates take effect.

### Option B — version manager (recommended for developers)

- macOS / Linux: install [`nvm`](https://github.com/nvm-sh/nvm), then
  ```
  nvm install --lts
  nvm use --lts
  ```
- Windows: install [`nvm-windows`](https://github.com/coreybutler/nvm-windows)
  and run the same `nvm install lts` / `nvm use lts` commands from an
  elevated `cmd` prompt.

### Option C — package manager

- macOS Homebrew: `brew install node`
- Debian / Ubuntu: follow the [NodeSource setup script](https://github.com/nodesource/distributions)
  for the LTS line, then `sudo apt install nodejs`
- Fedora: `sudo dnf install nodejs`
- Arch: `sudo pacman -S nodejs npm`

Whichever route you pick, end up with a working `node` and `npm` on
your `PATH`.

---

## First-time setup

From the **project root** (the folder that contains `package.json`,
i.e. `dxv2/`):

```
npm install
```

This downloads the AssemblyScript compiler and its loader into
`node_modules/`. It does not modify anything outside the project
folder. The first run takes ~5–15 seconds depending on your network.

The npm dependencies pinned in `package.json` are:

| Package | Range | Role |
| --- | --- | --- |
| `assemblyscript` | `^0.27.31` (verified at 0.27.37) | Compiles `assembly/index.ts` to wasm |
| `@assemblyscript/loader` | `^0.27.31` | Optional helper for instantiating wasm in Node, used by the test script |

You can skip the explicit `npm install` step — both `scripts/build.sh`
and `scripts/build.bat` run it automatically on the first build when
`node_modules/` is missing.

---

## Building the wasm

Pick whichever entry point matches your OS:

- macOS / Linux: `./scripts/build.sh`
- Windows: `scripts\build.bat`
- Either OS via npm: `npm run build`

All three call the same underlying script (`scripts/compile_build.js`).
A successful build prints:

```
build: loading scripts/database.js + scripts/rules.js
build: dictionary entries = N, rules = N
build: serializing to binary blob
build: plaintext blob = N bytes
build: generating key + encrypting
build: writing assembly/data.ts
build: writing assembly/keys.ts
build: running npx asc assembly/index.ts ...
build: done. translator.wasm = N bytes
```

The output you actually ship is `build/translator.wasm`.

---

## Verifying the build

After every build you can run:

```
npm test
```

(or `node scripts/compile_test.js`)

It instantiates the freshly built wasm in Node, runs a handful of
Spanish phrases through both the legacy plain-JS implementation and the
wasm implementation, and compares them. A clean run ends with:

```
15/15 translation cases match
4/4 cap cases pass
```

If anything fails, the script prints which case mismatched.

---

## Editable inputs

These two files (in this same `scripts/` folder) are the **only** files
that change the contents of the wasm:

- `database.js` — Spanish → Zapotec dictionary
- `rules.js` — grammatical and substitution rules

After editing either file, run the build again. Each rebuild generates
a fresh encryption key, so the resulting `translator.wasm` is binary
different from the previous one even when the data is unchanged.

The third file, `translator.js`, is the legacy plain-JS translator. It
is **not** loaded by `index.html`. It only exists for `admin.html` and
as a reference implementation that `compile_test.js` compares against.

---

## Troubleshooting

**`error: 'node' is not on your PATH`**
Node.js is not installed or your terminal hasn't picked up the PATH
change. Open a new terminal and rerun `node --version` to confirm.

**`npm install` fails behind a corporate proxy**
Set `npm config set proxy http://your.proxy:port` and
`npm config set https-proxy http://your.proxy:port`, or use an npm
mirror. The build does not require network access after `node_modules/`
is populated.

**`asc` reports type errors**
`assembly/data.ts` and `assembly/keys.ts` are auto-generated. If you
see compile errors there, delete both files and rerun the build —
they will be regenerated from scratch.

**Test cases mismatch after a change to `rules.js`**
The legacy reference (`translator.js`) and the wasm implementation must
stay logically equivalent. If you add a new rule **type** (rather than
just a new rule entry of an existing type), update both:

1. `RULE_SHAPE` in `compile_build.js` to know how to serialize it.
2. The matching `T_*` constant + `applyRules` branch in
   `assembly/index.ts` to know how to apply it at runtime.

**The wasm got noticeably bigger**
That is expected when you add many new dictionary entries or rules —
they are part of the encrypted blob embedded inside the wasm. The
overhead beyond the data itself is around 39 KB (the runtime + parser).

---

## What ships to users

Only these files need to be deployed to your web host:

- `index.html`
- `loader.js`
- `build/translator.wasm`
- `admin.html` (only if you want the admin tool reachable on the web)
- `scripts/database.js` and `scripts/rules.js` (only if you want the
  admin tool to load them; for the public page they are **not** needed)

Everything else in this folder is build-time only.
