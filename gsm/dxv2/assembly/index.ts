// translator.wasm entry point. Built by scripts/compile_build.js.
//
// Exposes a single function: translate(spanish: string): string
// All dictionary + rule data is decrypted lazily into linear memory and
// parsed into private maps/arrays held in module scope. Nothing apart
// from the translate() entry point is reachable from JavaScript.

import { ENC_DATA_B64, ENC_DATA_LEN } from "./data";
import { KF_A, KF_B, KF_C, KF_D, KM_A, KM_B, KM_C, KM_D } from "./keys";

// ---------- Rule type ids (must match scripts/compile_build.js typeIds) ----------

const T_oneForOne: u8 = 1;
const T_twoForOne: u8 = 2;
const T_threeForOne: u8 = 3;
const T_fourForOne: u8 = 4;
const T_fiveForOne: u8 = 5;
const T_preprocess: u8 = 6;
const T_remove: u8 = 7;
const T_ifAtStart: u8 = 8;
const T_replaceWord: u8 = 9;
const T_replaceIfNext: u8 = 10;
const T_replaceIfPrevious: u8 = 11;
const T_replaceEnding: u8 = 12;
const T_swapWords: u8 = 13;
const T_oneToMany: u8 = 14;

// ---------- module state ----------

class Rule {
    type: u8 = 0;
    // for *ForOne / swapWords:
    words: string[] = [];
    // for single-word rules:
    word: string = "";
    // optional context word(s):
    next: string = "";
    previous: string = "";
    oldEnding: string = "";
    newEnding: string = "";
    replacement: string = "";
}

let initialized: bool = false;
let dictKeys: string[] = [];
let dictVals: string[] = [];
// Simple linear-probing map of key hash -> index in dictKeys (cuts cost of
// a linear scan on every word lookup). Not strictly needed but gives a nice
// speedup for larger dictionaries.
let dictMapKeys: string[] = [];
let dictMapVals: i32[] = [];
let dictMapMask: i32 = 0;
let rules: Rule[] = [];

// ---------- base64 decode ----------

function b64decode(s: string): Uint8Array {
    // length math: each 4 chars → 3 bytes (minus padding)
    let len: i32 = s.length;
    let pad: i32 = 0;
    if (len > 0 && s.charCodeAt(len - 1) == 61) pad++;
    if (len > 1 && s.charCodeAt(len - 2) == 61) pad++;
    let outLen: i32 = (len / 4) * 3 - pad;
    let out = new Uint8Array(outLen);

    let oi: i32 = 0;
    let i: i32 = 0;
    while (i < len) {
        let v: i32 = 0;
        let valid: i32 = 0;
        for (let j: i32 = 0; j < 4 && i < len; j++) {
            let c: i32 = s.charCodeAt(i++);
            let d: i32 = -1;
            if (c >= 65 && c <= 90) d = c - 65;        // A-Z → 0-25
            else if (c >= 97 && c <= 122) d = c - 71;  // a-z → 26-51
            else if (c >= 48 && c <= 57) d = c + 4;    // 0-9 → 52-61
            else if (c == 43) d = 62;                  // +
            else if (c == 47) d = 63;                  // /
            else if (c == 61) { d = 0; }               // = pad
            else continue;
            v = (v << 6) | d;
            valid++;
        }
        if (valid == 0) break;
        if (oi < outLen) out[oi++] = u8((v >> 16) & 0xff);
        if (oi < outLen) out[oi++] = u8((v >> 8) & 0xff);
        if (oi < outLen) out[oi++] = u8(v & 0xff);
    }
    return out;
}

// ---------- xorshift128+ keystream (matches build.js) ----------

function unmaskKey(): u64[] {
    let f0: u32 = KF_A ^ KM_A;
    let f1: u32 = KF_B ^ KM_B;
    let f2: u32 = KF_C ^ KM_C;
    let f3: u32 = KF_D ^ KM_D;
    let s0: u64 = (u64(f1) << 32) | u64(f0);
    let s1: u64 = (u64(f3) << 32) | u64(f2);
    if (s0 == 0 && s1 == 0) s1 = 1;
    let r = new Array<u64>(2);
    r[0] = s0;
    r[1] = s1;
    return r;
}

function decryptInPlace(buf: Uint8Array): void {
    let seeds = unmaskKey();
    let s0: u64 = seeds[0];
    let s1: u64 = seeds[1];
    let len: i32 = buf.length;
    let pos: i32 = 0;
    while (pos < len) {
        // xorshift128+
        let x: u64 = s0;
        let y: u64 = s1;
        s0 = y;
        x ^= (x << 23);
        x ^= (x >> 17);
        x ^= y;
        x ^= (y >> 26);
        s1 = x;
        let r: u64 = x + y;
        for (let b: i32 = 0; b < 8 && pos < len; b++) {
            buf[pos] = buf[pos] ^ u8(r & 0xff);
            r >>= 8;
            pos++;
        }
    }
}

// ---------- binary parser ----------

class Reader {
    buf: Uint8Array;
    pos: i32 = 0;
    constructor(buf: Uint8Array) { this.buf = buf; }

    u8(): u8 {
        let v = this.buf[this.pos];
        this.pos++;
        return v;
    }
    u16(): i32 {
        let v = i32(this.buf[this.pos]) | (i32(this.buf[this.pos + 1]) << 8);
        this.pos += 2;
        return v;
    }
    u32(): i32 {
        let v = i32(this.buf[this.pos])
              | (i32(this.buf[this.pos + 1]) << 8)
              | (i32(this.buf[this.pos + 2]) << 16)
              | (i32(this.buf[this.pos + 3]) << 24);
        this.pos += 4;
        return v;
    }
    str(): string {
        let n = this.u16();
        let bytes = this.buf.subarray(this.pos, this.pos + n);
        this.pos += n;
        return String.UTF8.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    strs(): string[] {
        let n = this.u16();
        let arr = new Array<string>(n);
        for (let i = 0; i < n; i++) arr[i] = this.str();
        return arr;
    }
}

// String hash for the dict map (FNV-1a 32-bit).
function hashString(s: string): u32 {
    let bytes = String.UTF8.encode(s);
    let view = Uint8Array.wrap(bytes);
    let h: u32 = 0x811c9dc5;
    for (let i: i32 = 0, n: i32 = view.length; i < n; i++) {
        h ^= u32(view[i]);
        h = (h * 0x01000193) >>> 0;
    }
    return h;
}

function buildDictMap(): void {
    let n = dictKeys.length;
    // power-of-two capacity, load factor ~0.5
    let cap: i32 = 1;
    while (cap < n * 2) cap <<= 1;
    if (cap < 8) cap = 8;
    dictMapMask = cap - 1;
    dictMapKeys = new Array<string>(cap);
    dictMapVals = new Array<i32>(cap);
    for (let i = 0; i < cap; i++) {
        dictMapKeys[i] = "";
        dictMapVals[i] = -1;
    }
    for (let i = 0; i < n; i++) {
        let k = dictKeys[i];
        let h = hashString(k) & u32(dictMapMask);
        let idx: i32 = i32(h);
        while (dictMapVals[idx] != -1) {
            idx = (idx + 1) & dictMapMask;
        }
        dictMapKeys[idx] = k;
        dictMapVals[idx] = i;
    }
}

function dictLookup(word: string): string {
    if (dictMapMask == 0) return "";
    let h = hashString(word) & u32(dictMapMask);
    let idx: i32 = i32(h);
    let guard: i32 = 0;
    while (dictMapVals[idx] != -1 && guard <= dictMapMask) {
        if (dictMapKeys[idx] == word) {
            return dictVals[dictMapVals[idx]];
        }
        idx = (idx + 1) & dictMapMask;
        guard++;
    }
    return "";
}

function ensureInit(): void {
    if (initialized) return;

    let bytes = b64decode(ENC_DATA_B64);
    if (bytes.length != ENC_DATA_LEN) {
        // mismatch — refuse to initialize
        initialized = true;
        return;
    }
    decryptInPlace(bytes);

    let r = new Reader(bytes);

    // header
    if (r.u8() != 0x44 || r.u8() != 0x58 || r.u8() != 0x56 || r.u8() != 0x32) {
        // bad magic
        initialized = true;
        return;
    }
    let version = r.u8();
    if (version != 1) {
        initialized = true;
        return;
    }

    // type table — we ignore the names but skip them to advance the cursor
    let typeCount: i32 = i32(r.u8());
    for (let i = 0; i < typeCount; i++) {
        r.u8();   // typeId
        r.str();  // typeName
    }

    // dictionary
    let dictCount = r.u32();
    dictKeys = new Array<string>(dictCount);
    dictVals = new Array<string>(dictCount);
    for (let i = 0; i < dictCount; i++) {
        dictKeys[i] = r.str();
        dictVals[i] = r.str();
    }
    buildDictMap();

    // rules
    let ruleCount = r.u32();
    rules = new Array<Rule>(ruleCount);
    for (let i = 0; i < ruleCount; i++) {
        let rule = new Rule();
        rule.type = r.u8();
        let t = rule.type;
        if (t == T_oneForOne) {
            rule.word = r.str();
            rule.replacement = r.str();
        } else if (t == T_twoForOne || t == T_threeForOne || t == T_fourForOne || t == T_fiveForOne) {
            rule.words = r.strs();
            rule.replacement = r.str();
        } else if (t == T_preprocess || t == T_remove) {
            rule.word = r.str();
        } else if (t == T_ifAtStart || t == T_replaceWord || t == T_oneToMany) {
            rule.word = r.str();
            rule.replacement = r.str();
        } else if (t == T_replaceIfNext) {
            rule.word = r.str();
            rule.next = r.str();
            rule.replacement = r.str();
        } else if (t == T_replaceIfPrevious) {
            rule.word = r.str();
            rule.previous = r.str();
            rule.replacement = r.str();
        } else if (t == T_replaceEnding) {
            rule.word = r.str();
            rule.oldEnding = r.str();
            rule.newEnding = r.str();
        } else if (t == T_swapWords) {
            rule.words = r.strs();
        }
        rules[i] = rule;
    }

    initialized = true;

    // Best-effort scrub of the decrypted buffer. AS may keep references via
    // GC, but at least we drop our own.
    for (let i: i32 = 0, n: i32 = bytes.length; i < n; i++) bytes[i] = 0;
}

// ---------- string helpers ----------

function isWordCharCode(c: i32): bool {
    // Treat ASCII letters/digits + '_' + non-ASCII (>=128) as word chars.
    // This matches \w roughly, plus Latin-1+ accented characters.
    if (c >= 48 && c <= 57) return true;   // 0-9
    if (c >= 65 && c <= 90) return true;   // A-Z
    if (c >= 97 && c <= 122) return true;  // a-z
    if (c == 95) return true;              // _
    if (c >= 128) return true;             // accented / Spanish chars
    return false;
}

function lowerSimple(s: string): string {
    return s.toLowerCase();
}

function cleanText(text: string): string {
    let lower = lowerSimple(text);
    let out = "";
    let prevSpace: bool = true; // collapse leading/trailing too
    let len = lower.length;
    for (let i = 0; i < len; i++) {
        let cc = lower.charCodeAt(i);
        // strip: , . \n \r - ; ? !  ¿ ¡
        if (cc == 44 || cc == 46 || cc == 10 || cc == 13 || cc == 45 || cc == 59 ||
            cc == 63 || cc == 33 || cc == 0xBF /*¿*/ || cc == 0xA1 /*¡*/) {
            continue;
        }
        // collapse whitespace
        if (cc == 32 || cc == 9) {
            if (!prevSpace) { out += " "; prevSpace = true; }
            continue;
        }
        out += String.fromCharCode(cc);
        prevSpace = false;
    }
    // trim trailing space
    while (out.length > 0 && out.charCodeAt(out.length - 1) == 32) {
        out = out.substring(0, out.length - 1);
    }
    return out;
}

// Splits on runs of ASCII spaces (cleanText already collapsed others).
function splitWords(text: string): string[] {
    let parts: string[] = [];
    let len = text.length;
    let start: i32 = 0;
    for (let i = 0; i < len; i++) {
        if (text.charCodeAt(i) == 32) {
            if (i > start) parts.push(text.substring(start, i));
            start = i + 1;
        }
    }
    if (len > start) parts.push(text.substring(start, len));
    return parts;
}

// Replace whole-word occurrences of `needle` in `text` with `replacement`.
// Word boundaries: start/end of string or non-word character.
function replaceWholeWord(text: string, needle: string, replacement: string): string {
    if (needle.length == 0) return text;
    let out = "";
    let i: i32 = 0;
    let len = text.length;
    let nlen = needle.length;
    while (i <= len - nlen) {
        // boundary before
        let before: i32 = (i == 0) ? -1 : text.charCodeAt(i - 1);
        let beforeIsWord = (before >= 0) && isWordCharCode(before);
        if (!beforeIsWord) {
            // try match
            let matched: bool = true;
            for (let k = 0; k < nlen; k++) {
                if (text.charCodeAt(i + k) != needle.charCodeAt(k)) { matched = false; break; }
            }
            if (matched) {
                let after: i32 = (i + nlen >= len) ? -1 : text.charCodeAt(i + nlen);
                let afterIsWord = (after >= 0) && isWordCharCode(after);
                if (!afterIsWord) {
                    out += replacement;
                    i += nlen;
                    continue;
                }
            }
        }
        out += text.charAt(i);
        i++;
    }
    if (i < len) out += text.substring(i, len);
    return out;
}

function replaceWordSeq(text: string, words: string[], replacement: string): string {
    // Build "w1\\sw2\\s...wN" and replace whole-word.
    if (words.length == 0) return text;
    let needle = words[0];
    for (let i = 1; i < words.length; i++) {
        needle += " ";
        needle += words[i];
    }
    return replaceWholeWord(text, needle, replacement);
}

function preprocessRule(text: string, wordToMove: string): string {
    let parts = splitWords(text);
    let out: string[] = [];
    let n = parts.length;
    let i: i32 = 0;
    while (i < n) {
        if (parts[i] == wordToMove && i < n - 1) {
            out.push(parts[i + 1]);
            out.push(parts[i]);
            i += 2;
        } else {
            out.push(parts[i]);
            i++;
        }
    }
    return joinSpace(out);
}

function joinSpace(parts: string[]): string {
    if (parts.length == 0) return "";
    let s = parts[0];
    for (let i = 1; i < parts.length; i++) {
        s += " ";
        s += parts[i];
    }
    return s;
}

function removeParticle(text: string, wordToRemove: string): string {
    let parts = splitWords(text);
    let kept: string[] = [];
    for (let i = 0; i < parts.length; i++) {
        if (parts[i] != wordToRemove) kept.push(parts[i]);
    }
    return joinSpace(kept);
}

function ifAtStart(text: string, word: string, replacement: string): string {
    let parts = splitWords(text);
    if (parts.length > 0 && parts[0] == word) {
        parts[0] = replacement;
    }
    return joinSpace(parts);
}

function replaceIfNext(text: string, word: string, next: string, replacement: string): string {
    let parts = splitWords(text);
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] == word && parts[i + 1] == next) parts[i] = replacement;
    }
    return joinSpace(parts);
}

function replaceIfPrevious(text: string, word: string, prev: string, replacement: string): string {
    let parts = splitWords(text);
    for (let i = 1; i < parts.length; i++) {
        if (parts[i] == word && parts[i - 1] == prev) parts[i] = replacement;
    }
    return joinSpace(parts);
}

function swapWords(text: string, word1: string, word2: string): string {
    let parts = splitWords(text);
    for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i] == word1 && parts[i + 1] == word2) {
            parts[i] = word2;
            parts[i + 1] = word1;
            i++;
        }
    }
    return joinSpace(parts);
}

function replaceEnding(text: string, targetWord: string, oldEnding: string, newEnding: string): string {
    // Strict mirror of original JS: regex `\b(<stem>)<oldEnding>\b` → `$1<newEnding>`.
    if (targetWord.length < oldEnding.length) return text;
    if (targetWord.substring(targetWord.length - oldEnding.length) != oldEnding) return text;
    return replaceWholeWord(text, targetWord, targetWord.substring(0, targetWord.length - oldEnding.length) + newEnding);
}

function applyRules(text: string): string {
    let processed = text;
    for (let i = 0, n = rules.length; i < n; i++) {
        let r = rules[i];
        let t = r.type;
        if (t == T_oneForOne) {
            processed = replaceWholeWord(processed, r.word, r.replacement);
        } else if (t == T_twoForOne || t == T_threeForOne || t == T_fourForOne || t == T_fiveForOne) {
            processed = replaceWordSeq(processed, r.words, r.replacement);
        } else if (t == T_preprocess) {
            processed = preprocessRule(processed, r.word);
        } else if (t == T_remove) {
            processed = removeParticle(processed, r.word);
        } else if (t == T_ifAtStart) {
            processed = ifAtStart(processed, r.word, r.replacement);
        } else if (t == T_replaceWord) {
            processed = replaceWholeWord(processed, r.word, r.replacement);
        } else if (t == T_replaceIfNext) {
            processed = replaceIfNext(processed, r.word, r.next, r.replacement);
        } else if (t == T_replaceIfPrevious) {
            processed = replaceIfPrevious(processed, r.word, r.previous, r.replacement);
        } else if (t == T_replaceEnding) {
            processed = replaceEnding(processed, r.word, r.oldEnding, r.newEnding);
        } else if (t == T_swapWords) {
            if (r.words.length >= 2) processed = swapWords(processed, r.words[0], r.words[1]);
        } else if (t == T_oneToMany) {
            processed = replaceWholeWord(processed, r.word, r.replacement);
        }
    }
    return processed;
}

// ---------- exported entry point ----------

const MAX_INPUT_LENGTH: i32 = 26;

export function translate(spanish: string): string {
    ensureInit();
    if (spanish.length == 0) return "";
    // Hard cap enforced inside the wasm so removing it requires patching
    // the binary, not just editing the page JS.
    if (spanish.length > MAX_INPUT_LENGTH) return "";

    let cleaned = cleanText(spanish);
    let withRules = applyRules(cleaned);
    let words = splitWords(withRules);
    let out: string[] = [];
    for (let i = 0; i < words.length; i++) {
        let w = words[i];
        if (w.length == 0) { out.push(""); continue; }
        let v = dictLookup(w);
        if (v.length == 0) {
            out.push("<i>" + w + "</i>");
        } else {
            out.push(v);
        }
    }
    return joinSpace(out);
}
