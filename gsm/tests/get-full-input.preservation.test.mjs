// Preservation property test for getFullInput() in logs2.html
//
// Property 2: Preservation — buffered large-input branch unchanged
//   FOR ALL X WHERE NOT isBugCondition(X) — i.e.
//     X.fullInput.length > INPUT_DISPLAY_LIMIT —
//   getFullInput() returns exactly X.fullInput.
//
// Observation-first methodology: on UNFIXED code, when `_fullInput.length >
// INPUT_DISPLAY_LIMIT` the early-return guard fires and `getFullInput()`
// returns `_fullInput` WITHOUT reaching the recursive fallback line. That
// baseline is what the fix must preserve byte-for-byte.
//
// EXPECTED OUTCOMES:
//   - UNFIXED body: PASSES (establishes the behavior to preserve)
//   - FIXED body:   PASSES (confirms no regression on the large-input branch)
//
// Validates: Requirements 3.1 (bugfix.md); Property 2 (design.md)

import fc from 'fast-check';
import assert from 'node:assert/strict';

// --- Harness setup -----------------------------------------------------------
// Stub the two module-level symbols and the DOM reference that getFullInput()
// depends on. These are refreshed per-iteration inside the property below.
globalThis.INPUT_DISPLAY_LIMIT = 200000;
globalThis._fullInput = '';
globalThis.inputTextarea = { value: '' };

// --- UNFIXED getFullInput() verbatim from logs2.html (original defective body)
// The recursive `return getFullInput();` is the bug, but it is unreachable on
// the large-input branch because the `if` guard returns first. This function
// is here to prove exactly that invariant.
function getFullInput_unfixed() {
    // If we have a buffered large input, return it; otherwise return textarea value
    if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
        return _fullInput;
    }
    return getFullInput_unfixed();
}

// --- FIXED getFullInput() verbatim from logs2.html (current post-fix body) ---
function getFullInput_fixed() {
    // If we have a buffered large input, return it; otherwise return textarea value
    if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
        return _fullInput;
    }
    return inputTextarea.value;
}

// --- Property ----------------------------------------------------------------
// For every (textareaValue, fullInput) where fullInput.length >
// INPUT_DISPLAY_LIMIT, the function under test must return exactly fullInput.
function makeProperty(fnUnderTest) {
    return fc.property(
        fc.string(),                                          // textareaValue (irrelevant on this branch)
        fc.string({ minLength: 200001, maxLength: 200050 }),  // fullInput: length > INPUT_DISPLAY_LIMIT
        (textareaValue, fullInput) => {
            globalThis._fullInput = fullInput;
            globalThis.inputTextarea = { value: textareaValue };

            try {
                const result = fnUnderTest();
                return result === fullInput;
            } catch {
                return false;
            }
        }
    );
}

// --- Run ---------------------------------------------------------------------
function runProperty(label, fnUnderTest) {
    let outcome = 'unknown';
    let error = null;
    try {
        fc.assert(makeProperty(fnUnderTest), { numRuns: 100, verbose: false });
        outcome = 'held';
    } catch (err) {
        outcome = 'counterexample-found';
        error = err;
    }
    console.log(`--- Preservation property (${label}) ---`);
    console.log('Property outcome (fc.assert):', outcome);
    if (error) {
        console.log('fc.assert error:', error.message);
    }
    return outcome;
}

const unfixedOutcome = runProperty('unfixed body', getFullInput_unfixed);
const fixedOutcome = runProperty('fixed body', getFullInput_fixed);

// Concrete sanity check: a string just over the limit should be returned
// verbatim by both bodies.
const bigInput = 'x'.repeat(200001);
globalThis._fullInput = bigInput;
globalThis.inputTextarea = { value: 'irrelevant' };

let unfixedConcrete;
try {
    unfixedConcrete = { threw: false, result: getFullInput_unfixed() };
} catch (err) {
    unfixedConcrete = { threw: true, name: err && err.name, message: err && err.message };
}

let fixedConcrete;
try {
    fixedConcrete = { threw: false, result: getFullInput_fixed() };
} catch (err) {
    fixedConcrete = { threw: true, name: err && err.name, message: err && err.message };
}

console.log('--- Concrete check: fullInput.length = 200001, textareaValue = "irrelevant" ---');
console.log('  unfixed threw:', unfixedConcrete.threw,
    '  returns_fullInput:', !unfixedConcrete.threw && unfixedConcrete.result === bigInput);
console.log('  fixed   threw:', fixedConcrete.threw,
    '  returns_fullInput:', !fixedConcrete.threw && fixedConcrete.result === bigInput);

// --- Final assertions for the test runner ------------------------------------
assert.equal(unfixedOutcome, 'held',
    'Expected Preservation property to hold on UNFIXED body (large-input branch short-circuits)');
assert.equal(fixedOutcome, 'held',
    'Expected Preservation property to hold on FIXED body (no regression)');

assert.equal(unfixedConcrete.threw, false, 'Unfixed body must not throw on large-input branch');
assert.equal(unfixedConcrete.result, bigInput, 'Unfixed body must return _fullInput verbatim');

assert.equal(fixedConcrete.threw, false, 'Fixed body must not throw on large-input branch');
assert.equal(fixedConcrete.result, bigInput, 'Fixed body must return _fullInput verbatim');

console.log('Preservation confirmed: both unfixed and fixed bodies return _fullInput when length > INPUT_DISPLAY_LIMIT.');
