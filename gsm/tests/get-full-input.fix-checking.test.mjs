// Fix-checking property test for getFullInput() in logs2.html
//
// Property 1: Expected Behavior
//   FOR ALL X WHERE isBugCondition(X) — i.e.
//     X.fullInput === "" OR X.fullInput.length <= INPUT_DISPLAY_LIMIT —
//   getFullInput() returns exactly X.textareaValue and does not throw.
//
// EXPECTED OUTCOME on FIXED code: test PASSES (property holds across all
// generated examples — confirms the bug is fixed).
//
// Validates: Requirements 2.3 (bugfix.md); Property 1 (design.md) — clauses
// 2.1, 2.2, 2.3.

import fc from 'fast-check';
import assert from 'node:assert/strict';

// --- Harness setup -----------------------------------------------------------
// Stub the two module-level symbols and the DOM reference that getFullInput()
// depends on. These are set per-iteration inside the property below.
globalThis.INPUT_DISPLAY_LIMIT = 200000;
globalThis._fullInput = '';
globalThis.inputTextarea = { value: '' };

// --- FIXED getFullInput() verbatim from logs2.html (~lines 1512–1518) --------
// Post-fix version: the fallback returns inputTextarea.value instead of
// recursing. Copied byte-for-byte from the current source.
function getFullInput() {
    // If we have a buffered large input, return it; otherwise return textarea value
    if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
        return _fullInput;
    }
    return inputTextarea.value;
}

// --- Property ----------------------------------------------------------------
// For every (textareaValue, fullInput) where the bug condition holds,
// getFullInput() must return exactly textareaValue and must not throw.
const property = fc.property(
    fc.string(),                                       // textareaValue
    fc.oneof(
        fc.constant(''),
        fc.string({ maxLength: 200000 })               // fullInput: length <= limit
    ),
    (textareaValue, fullInput) => {
        // Per-iteration stub refresh
        globalThis._fullInput = fullInput;
        globalThis.inputTextarea = { value: textareaValue };

        try {
            const result = getFullInput();
            return result === textareaValue;
        } catch {
            return false;
        }
    }
);

// --- Run ---------------------------------------------------------------------
let propertyOutcome = 'unknown';
let propertyError = null;
try {
    fc.assert(property, { numRuns: 200, verbose: false });
    propertyOutcome = 'held';
} catch (err) {
    propertyOutcome = 'counterexample-found';
    propertyError = err;
}

// Concrete sanity check mirroring the bug-condition test's demo input.
globalThis._fullInput = '';
globalThis.inputTextarea = { value: 'abc' };
let concreteOutcome;
try {
    const result = getFullInput();
    concreteOutcome = { threw: false, result };
} catch (err) {
    concreteOutcome = {
        threw: true,
        name: err && err.name,
        message: err && err.message,
    };
}

console.log('--- Fix-checking property test ---');
console.log('Property outcome (fc.assert):', propertyOutcome);
if (propertyError) {
    console.log('fc.assert error:', propertyError.message);
}
console.log('Concrete check: fullInput="", textareaValue="abc"');
console.log('  threw:', concreteOutcome.threw);
if (concreteOutcome.threw) {
    console.log('  error.name:', concreteOutcome.name);
    console.log('  error.message:', concreteOutcome.message);
} else {
    console.log('  result:', JSON.stringify(concreteOutcome.result));
}

// Final assertions for the test runner: the property must have held across
// all generated inputs, AND the concrete call must return "abc" without
// throwing.
assert.equal(propertyOutcome, 'held', 'Expected property to hold on fixed code');
assert.equal(concreteOutcome.threw, false, 'Expected getFullInput() not to throw on fixed code');
assert.equal(concreteOutcome.result, 'abc', 'Expected getFullInput() to return inputTextarea.value');

console.log('Fix confirmed: getFullInput() returns inputTextarea.value on the fallback branch.');
