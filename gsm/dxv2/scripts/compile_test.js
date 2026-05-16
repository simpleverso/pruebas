#!/usr/bin/env node
/**
 * Quick smoke test: load translator.wasm in Node, call translate() with a
 * few Spanish phrases, and compare against the legacy plain-JS translator
 * (database.js + rules.js + translator.js minus the DOM bits).
 *
 * This is just to confirm the wasm path produces sensible output. It is
 * NOT shipped to users.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

// ---------- legacy reference impl ----------

function loadLegacyTranslator() {
    const dbCode = fs.readFileSync(path.join(ROOT, 'scripts', 'database.js'), 'utf8')
        .replace(/^\s*let\s+dictionary\s*=/m, 'globalThis.dictionary =');
    const rulesCode = fs.readFileSync(path.join(ROOT, 'scripts', 'rules.js'), 'utf8')
        .replace(/^\s*let\s+translationRules\s*=/m, 'globalThis.translationRules =');

    const sandbox = { console, document: null };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(dbCode, sandbox);
    vm.runInContext(rulesCode, sandbox);

    // Re-implement the relevant translation pipeline from translator.js
    // without DOM. Mirrors the original logic exactly.
    function cleanText(text) {
        return text.toLowerCase()
            .replace(/[,.\n\r\-;?!¿¡]/g, '')
            .replace(/\s\s+/g, ' ')
            .trim();
    }
    function oneForOne(text, w, r) { return text.replace(new RegExp(`\\b${w}\\b`, 'g'), r); }
    function twoForOne(text, w1, w2, r) { return text.replace(new RegExp(`\\b${w1}\\s+${w2}\\b`, 'g'), r); }
    function threeForOne(text, w1, w2, w3, r) { return text.replace(new RegExp(`\\b${w1}\\s+${w2}\\s+${w3}\\b`, 'g'), r); }
    function fourForOne(text, w1, w2, w3, w4, r) { return text.replace(new RegExp(`\\b${w1}\\s+${w2}\\s+${w3}\\s+${w4}\\b`, 'g'), r); }
    function fiveForOne(text, words, r) { return text.replace(new RegExp(`\\b${words[0]}\\s+${words[1]}\\s+${words[2]}\\s+${words[3]}\\s+${words[4]}\\b`, 'g'), r); }
    function preprocessRule(text, w) {
        const words = text.split(' '), out = [];
        for (let i = 0; i < words.length; i++) {
            if (words[i] === w && i < words.length - 1) { out.push(words[i + 1]); out.push(words[i]); i++; }
            else out.push(words[i]);
        }
        return out.join(' ');
    }
    function removeParticle(text, w) { return text.split(' ').filter(x => x !== w).join(' '); }
    function ifAtStart(text, w, r) { const parts = text.split(' '); if (parts[0] === w) parts[0] = r; return parts.join(' '); }
    function replaceWord(text, w, r) { return text.replace(new RegExp(`\\b${w}\\b`, 'g'), r); }
    function replaceIfNext(text, w, n, r) {
        const parts = text.split(' ');
        for (let i = 0; i < parts.length - 1; i++) if (parts[i] === w && parts[i + 1] === n) parts[i] = r;
        return parts.join(' ');
    }
    function replaceIfPrevious(text, w, p, r) {
        const parts = text.split(' ');
        for (let i = 1; i < parts.length; i++) if (parts[i] === w && parts[i - 1] === p) parts[i] = r;
        return parts.join(' ');
    }
    function replaceEnding(text, target, oldE, newE) {
        const stem = target.slice(0, -oldE.length);
        return text.replace(new RegExp(`\\b(${stem})${oldE}\\b`, 'g'), `$1${newE}`);
    }
    function swapWords(text, w1, w2) { return text.replace(new RegExp(`\\b${w1}\\s+${w2}\\b`, 'g'), `${w2} ${w1}`); }
    function oneToMany(text, w, r) { return text.replace(new RegExp(`\\b${w}\\b`, 'g'), r); }

    function applyRules(text) {
        let t = text;
        for (const rule of sandbox.translationRules) {
            switch (rule.type) {
                case 'oneForOne': t = oneForOne(t, rule.word, rule.replacement); break;
                case 'twoForOne': t = twoForOne(t, rule.words[0], rule.words[1], rule.replacement); break;
                case 'threeForOne': t = threeForOne(t, rule.words[0], rule.words[1], rule.words[2], rule.replacement); break;
                case 'fourForOne': t = fourForOne(t, rule.words[0], rule.words[1], rule.words[2], rule.words[3], rule.replacement); break;
                case 'fiveForOne': t = fiveForOne(t, rule.words, rule.replacement); break;
                case 'preprocess': t = preprocessRule(t, rule.word); break;
                case 'remove': t = removeParticle(t, rule.word); break;
                case 'ifAtStart': t = ifAtStart(t, rule.word, rule.replacement); break;
                case 'replaceWord': t = replaceWord(t, rule.word, rule.replacement); break;
                case 'replaceIfNext': t = replaceIfNext(t, rule.word, rule.next, rule.replacement); break;
                case 'replaceIfPrevious': t = replaceIfPrevious(t, rule.word, rule.previous, rule.replacement); break;
                case 'replaceEnding': t = replaceEnding(t, rule.word, rule.oldEnding, rule.newEnding); break;
                case 'swapWords': t = swapWords(t, rule.words[0], rule.words[1]); break;
                case 'oneToMany': t = oneToMany(t, rule.word, rule.replacement); break;
            }
        }
        return t;
    }

    return function legacyTranslate(spanish) {
        const phrase = applyRules(cleanText(spanish));
        return phrase.split(/\s+/).map(w => {
            const t = w.trim();
            if (!t) return '';
            return sandbox.dictionary[t] || `<i>${t}</i>`;
        }).join(' ');
    };
}

// ---------- wasm translator ----------

async function loadWasmTranslator() {
    const bytes = fs.readFileSync(path.join(ROOT, 'build/translator.wasm'));
    const env = {
        abort: (_msg, _file, line, col) => { throw new Error(`wasm abort ${line}:${col}`); },
        'console.log': () => {},
        seed: () => Date.now(),
    };
    const { instance } = await WebAssembly.instantiate(bytes, { env });
    const exp = instance.exports;
    const STRING_ID = 1;

    function allocString(str) {
        const ptr = exp.__new(str.length * 2, STRING_ID) >>> 0;
        const u16 = new Uint16Array(exp.memory.buffer, ptr, str.length);
        for (let i = 0; i < str.length; i++) u16[i] = str.charCodeAt(i);
        return ptr;
    }
    function readString(ptr) {
        ptr = ptr >>> 0;
        if (!ptr) return '';
        const i32 = new Int32Array(exp.memory.buffer);
        const byteLen = i32[(ptr - 4) >> 2] >>> 0;
        const len = byteLen >>> 1;
        const u16 = new Uint16Array(exp.memory.buffer, ptr, len);
        let out = '';
        const CHUNK = 0x4000;
        for (let i = 0; i < len; i += CHUNK) {
            out += String.fromCharCode.apply(null, u16.subarray(i, Math.min(i + CHUNK, len)));
        }
        return out;
    }

    return function wasmTranslate(s) {
        const inPtr = allocString(String(s || ''));
        const pinned = exp.__pin ? exp.__pin(inPtr) : inPtr;
        let outPtr;
        try { outPtr = exp.translate(pinned); }
        finally { if (exp.__unpin) exp.__unpin(pinned); }
        const r = readString(outPtr);
        if (exp.__collect) exp.__collect();
        return r;
    };
}

// ---------- run cases ----------

const CASES = [
    'hola',
    'gracias',
    'amor',
    'no les digas',
    'buenos días',
    'mi corazón',
    'tu casa',
    'no te entendí',
    'yo soy el ingeniero',
    'pan de muerto',
    'todavía no',
    'tengo miedo',
    'casa',
    'sol y luna',
    'palabra_inventada xyz',
];

// Cases for the 26-char input cap. The wasm must return "" when the
// input exceeds 26 characters, regardless of what the legacy JS does.
const CAP_CASES = [
    { input: 'a'.repeat(26), expectEmpty: false }, // exactly at limit
    { input: 'a'.repeat(27), expectEmpty: true },  // one over
    { input: 'hola amor mi vida cariño...', expectEmpty: true },
    { input: 'hola hola hola hola hola hola', expectEmpty: true },
];

(async () => {
    const legacy = loadLegacyTranslator();
    const wasm = await loadWasmTranslator();

    let mismatches = 0;
    for (const phrase of CASES) {
        if (phrase.length > 26) continue; // skip translation parity above the cap
        const l = legacy(phrase);
        const w = wasm(phrase);
        const same = (l === w);
        if (!same) mismatches++;
        console.log(`\nINPUT : ${JSON.stringify(phrase)}`);
        console.log(`legacy: ${l}`);
        console.log(`wasm  : ${w}`);
        console.log(`match : ${same ? 'yes' : 'NO'}`);
    }

    let capFailures = 0;
    console.log('\n--- 26-char cap ---');
    for (const c of CAP_CASES) {
        const out = wasm(c.input);
        const isEmpty = (out === '');
        const ok = (isEmpty === c.expectEmpty);
        if (!ok) capFailures++;
        console.log(`len=${c.input.length} expectEmpty=${c.expectEmpty} got=${JSON.stringify(out.slice(0, 40))} ${ok ? 'OK' : 'FAIL'}`);
    }

    const ranTranslate = CASES.filter(c => c.length <= 26).length;
    console.log(`\n${ranTranslate - mismatches}/${ranTranslate} translation cases match`);
    console.log(`${CAP_CASES.length - capFailures}/${CAP_CASES.length} cap cases pass`);
    process.exit((mismatches === 0 && capFailures === 0) ? 0 : 1);
})().catch(err => { console.error(err); process.exit(1); });
