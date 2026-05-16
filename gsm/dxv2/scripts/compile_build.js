#!/usr/bin/env node
/**
 * Build script: regenerates assembly/data.ts and assembly/keys.ts from
 * the editable source files (scripts/database.js + scripts/rules.js),
 * then compiles the AssemblyScript module to translator.wasm.
 *
 * The dictionary and rules are encoded as a compact binary blob, encrypted
 * with a XOR keystream derived from a freshly generated key, and embedded
 * inside the wasm module. The decryption key is split into 4 fragments
 * scattered across the AS source so that no single string in the binary
 * looks like the key.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const ASSEMBLY_DIR = path.join(ROOT, 'assembly');
const BUILD_DIR = path.join(ROOT, 'build');

if (!fs.existsSync(ASSEMBLY_DIR)) fs.mkdirSync(ASSEMBLY_DIR, { recursive: true });
if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

// ---------- Step 1: load editable sources ----------

function loadSources() {
    let dbCode = fs.readFileSync(path.join(ROOT, 'scripts', 'database.js'), 'utf8');
    let rulesCode = fs.readFileSync(path.join(ROOT, 'scripts', 'rules.js'), 'utf8');

    // The source files declare `let dictionary = ...` / `let translationRules = ...`.
    // `let` doesn't attach to the sandbox object, so promote these to vars
    // (and remap the assignment to a property on globalThis) before evaluating.
    dbCode = dbCode.replace(/^\s*let\s+dictionary\s*=/m, 'globalThis.dictionary =');
    rulesCode = rulesCode.replace(/^\s*let\s+translationRules\s*=/m, 'globalThis.translationRules =');

    const sandbox = {};
    vm.createContext(sandbox);
    sandbox.globalThis = sandbox;
    vm.runInContext(dbCode, sandbox, { filename: 'database.js' });
    vm.runInContext(rulesCode, sandbox, { filename: 'rules.js' });

    if (typeof sandbox.dictionary !== 'object' || sandbox.dictionary === null) {
        throw new Error('scripts/database.js did not produce a dictionary object');
    }
    if (!Array.isArray(sandbox.translationRules)) {
        throw new Error('scripts/rules.js did not produce a translationRules array');
    }
    return { dictionary: sandbox.dictionary, rules: sandbox.translationRules };
}

// ---------- Step 2: serialize to a compact binary format ----------
//
// Format (little-endian):
//   magic          : 4 bytes "DXV2"
//   version        : u8     = 1
//   ruleTypeCount  : u8
//   for each rule type:
//       typeId : u8
//       name   : len(u16) + utf8
//   dictCount : u32
//   for each dict entry:
//       keyLen : u16, key utf8
//       valLen : u16, value utf8
//   ruleCount : u32
//   for each rule:
//       typeId : u8
//       payload (depends on type) — see RULE_SHAPE
//
// String encoding helper: u16 length + utf8 bytes.

const RULE_SHAPE = {
    // each entry lists the field names to serialize, in order.
    // Strings = u16 len + utf8. arrays of strings = u16 count + each string.
    oneForOne:        [['str','word'], ['str','replacement']],
    twoForOne:        [['strs','words'], ['str','replacement']],
    threeForOne:      [['strs','words'], ['str','replacement']],
    fourForOne:       [['strs','words'], ['str','replacement']],
    fiveForOne:       [['strs','words'], ['str','replacement']],
    preprocess:       [['str','word']],
    remove:           [['str','word']],
    ifAtStart:        [['str','word'], ['str','replacement']],
    replaceWord:      [['str','word'], ['str','replacement']],
    replaceIfNext:    [['str','word'], ['str','next'], ['str','replacement']],
    replaceIfPrevious:[['str','word'], ['str','previous'], ['str','replacement']],
    replaceEnding:    [['str','word'], ['str','oldEnding'], ['str','newEnding']],
    swapWords:        [['strs','words']],
    oneToMany:        [['str','word'], ['str','replacement']],
};

function buildTypeIdMap() {
    const map = {};
    let id = 1;
    for (const k of Object.keys(RULE_SHAPE)) map[k] = id++;
    return map;
}

class Writer {
    constructor() { this.chunks = []; this.length = 0; }
    pushBuf(buf) { this.chunks.push(buf); this.length += buf.length; }
    u8(v)  { const b = Buffer.alloc(1); b.writeUInt8(v & 0xff, 0); this.pushBuf(b); }
    u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff, 0); this.pushBuf(b); }
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); this.pushBuf(b); }
    str(s) {
        const buf = Buffer.from(String(s == null ? '' : s), 'utf8');
        if (buf.length > 0xffff) throw new Error('string too long: ' + s);
        this.u16(buf.length);
        this.pushBuf(buf);
    }
    strs(arr) {
        if (!Array.isArray(arr)) throw new Error('expected array of strings');
        this.u16(arr.length);
        for (const s of arr) this.str(s);
    }
    finish() { return Buffer.concat(this.chunks, this.length); }
}

function serialize({ dictionary, rules }) {
    const typeIds = buildTypeIdMap();
    const w = new Writer();

    // header
    w.pushBuf(Buffer.from('DXV2', 'utf8'));
    w.u8(1); // version

    // type table
    const typeNames = Object.keys(RULE_SHAPE);
    w.u8(typeNames.length);
    for (const name of typeNames) {
        w.u8(typeIds[name]);
        w.str(name);
    }

    // dictionary
    const dictKeys = Object.keys(dictionary);
    w.u32(dictKeys.length);
    for (const k of dictKeys) {
        w.str(k);
        w.str(dictionary[k]);
    }

    // rules
    const validRules = [];
    for (const r of rules) {
        if (!r || !r.type) continue;
        if (!RULE_SHAPE[r.type]) {
            console.warn(`build: skipping unknown rule type "${r.type}"`);
            continue;
        }
        validRules.push(r);
    }
    w.u32(validRules.length);
    for (const r of validRules) {
        const shape = RULE_SHAPE[r.type];
        w.u8(typeIds[r.type]);
        for (const [kind, field] of shape) {
            const val = r[field];
            if (kind === 'str') w.str(val == null ? '' : val);
            else if (kind === 'strs') w.strs(val);
            else throw new Error('unknown shape kind ' + kind);
        }
    }

    return { blob: w.finish(), typeIds, ruleCount: validRules.length, dictCount: dictKeys.length };
}

// ---------- Step 3: encrypt with xorshift128+ keystream ----------
//
// We use a 16-byte key. The keystream is produced by xorshift128+ seeded
// from two 64-bit halves of the key. The key is split into 4 fragments
// and embedded as separate constants in the AS source.

function generateKey() {
    return crypto.randomBytes(16);
}

function makeKeystream(key, length) {
    // seed two 64-bit BigInts from the 16-byte key
    let s0 = key.readBigUInt64LE(0);
    let s1 = key.readBigUInt64LE(8);
    if (s0 === 0n && s1 === 0n) s1 = 1n;
    const out = Buffer.alloc(length);
    let pos = 0;
    const MASK64 = (1n << 64n) - 1n;
    while (pos < length) {
        // xorshift128+ step
        let x = s0;
        const y = s1;
        s0 = y;
        x ^= (x << 23n) & MASK64;
        x ^= x >> 17n;
        x ^= y;
        x ^= y >> 26n;
        s1 = x;
        let r = (x + y) & MASK64;
        for (let b = 0; b < 8 && pos < length; b++) {
            out[pos++] = Number(r & 0xffn);
            r >>= 8n;
        }
    }
    return out;
}

function encrypt(plain, key) {
    const ks = makeKeystream(key, plain.length);
    const out = Buffer.alloc(plain.length);
    for (let i = 0; i < plain.length; i++) out[i] = plain[i] ^ ks[i];
    return out;
}

// ---------- Step 4: emit assembly/data.ts and assembly/keys.ts ----------

function chunkBase64(b64, width = 76) {
    const lines = [];
    for (let i = 0; i < b64.length; i += width) lines.push(b64.slice(i, i + width));
    return lines;
}

function emitDataModule(encryptedBlob) {
    const b64 = encryptedBlob.toString('base64');
    const lines = chunkBase64(b64).map(l => `  "${l}"`);
    const literal = lines.join(' +\n');
    return `// AUTO-GENERATED by scripts/compile_build.js — do not edit by hand.
// This file is overwritten on every build.

export const ENC_DATA_B64: string =
${literal};

export const ENC_DATA_LEN: i32 = ${encryptedBlob.length};
`;
}

function emitKeysModule(key) {
    // Split into 4 fragments of 4 bytes. Each fragment is XOR-masked with a
    // per-build random byte so the constants don't appear as raw key bytes
    // in the wasm string table either.
    const masks = crypto.randomBytes(4);
    const fragments = [
        Buffer.from(key.subarray(0, 4)),
        Buffer.from(key.subarray(4, 8)),
        Buffer.from(key.subarray(8, 12)),
        Buffer.from(key.subarray(12, 16)),
    ];
    const masked = fragments.map((f, i) => {
        const out = Buffer.alloc(4);
        for (let j = 0; j < 4; j++) out[j] = f[j] ^ masks[i];
        return out;
    });
    const toU32 = (b) => b.readUInt32LE(0);

    return `// AUTO-GENERATED by scripts/compile_build.js — do not edit by hand.
// Key fragments are XOR-masked; the unmask values are scattered across
// the module to make extraction less obvious from a static dump.

export const KF_A: u32 = ${toU32(masked[0])};
export const KF_B: u32 = ${toU32(masked[1])};
export const KF_C: u32 = ${toU32(masked[2])};
export const KF_D: u32 = ${toU32(masked[3])};

// Each KM is a single mask byte broadcast across all 4 bytes of a u32 so
// that the XOR un-masks every byte of the fragment in one operation.
export const KM_A: u32 = ${(masks[0] * 0x01010101) >>> 0};
export const KM_B: u32 = ${(masks[1] * 0x01010101) >>> 0};
export const KM_C: u32 = ${(masks[2] * 0x01010101) >>> 0};
export const KM_D: u32 = ${(masks[3] * 0x01010101) >>> 0};
`;
}

// ---------- Step 5: run asc ----------

function runAsc() {
    const cmd = [
        'npx', 'asc',
        'assembly/index.ts',
        '--outFile', 'build/translator.wasm',
        '--textFile', 'build/translator.wat',
        '--runtime', 'stub',
        '--optimize',
        '--noAssert',
        '-Oz',
    ].join(' ');
    console.log('build: running ' + cmd);
    execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

// ---------- main ----------

function main() {
    console.log('build: loading scripts/database.js + scripts/rules.js');
    const sources = loadSources();
    console.log(`build: dictionary entries = ${Object.keys(sources.dictionary).length}, rules = ${sources.rules.length}`);

    console.log('build: serializing to binary blob');
    const { blob } = serialize(sources);
    console.log(`build: plaintext blob = ${blob.length} bytes`);

    console.log('build: generating key + encrypting');
    const key = generateKey();
    const enc = encrypt(blob, key);

    console.log('build: writing assembly/data.ts');
    fs.writeFileSync(path.join(ASSEMBLY_DIR, 'data.ts'), emitDataModule(enc));

    console.log('build: writing assembly/keys.ts');
    fs.writeFileSync(path.join(ASSEMBLY_DIR, 'keys.ts'), emitKeysModule(key));

    runAsc();

    const wasmSize = fs.statSync(path.join(BUILD_DIR, 'translator.wasm')).size;
    console.log(`build: done. translator.wasm = ${wasmSize} bytes`);
}

main();
