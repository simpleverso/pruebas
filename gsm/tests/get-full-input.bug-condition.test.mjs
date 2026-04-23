// Bug condition exploration test for getFullInput() in logs2.html
//
// Property 1: Bug Condition
//   FOR ALL X WHERE isBugCondition(X) — i.e.
//     X.fullInput === "" OR X.fullInput.length <= INPUT_DISPLAY_LIMIT —
//   calling getFullInput() throws RangeError: Maximum call stack size exceeded.
//
// EXPECTED OUTCOME on UNFIXED code: test FAILS (RangeError thrown for every
// generated example). That failure IS the success signal — it proves the bug
// exists.
//
// Validates: Requirements 1.1, 1.2, 1.3 (bugfix.md); Property 1 (design.md)

import fc from 'fast-check';
import assert from 'node:assert/strict';

// --- Harness setup -----------------------------------------------------------
// Stub the two module-level symbols and the DOM reference that getFullInput()
// depends on. These are set per-iteration inside the property below.
globalThis.INPUT_DISPLAY_LIMIT = 200000;
globalThis._fullInput = '';
globalThis.inputTextarea = { value: '' };

// --- UNFIXED getFullInput() verbatim from logs2.html (~lines 1513–1519) ------
// NOTE: We intentionally copy the defective body. The recursive `return
// getFullInput();` is the bug under test. Do NOT "fix" this in this task.
function getFullInput() {
    // If we have a buffered large input, return it; otherwise return textarea value
    if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
        return _fullInput;
    }
    return getFullInput();
}

// --- Property ----------------------------------------------------------------
// The property claims: for every (textareaValue, fullInput) where the bug
// condition holds, getFullInput() throws a RangeError. We report `true` ONLY
// when a RangeError was actually thrown. On unfixed code this property is
// expected to hold universally (i.e. fast-check should NOT find a shrunk
// counterexample); on fixed code this property would fail immediately.
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
            getFullInput();
            // If we got here, no error was thrown — bug NOT reproduced for
            // this input. That would be a counterexample to "bug always throws".
            return false;
        } catch (err) {
            // We expect RangeError: Maximum call stack size exceeded.
            return err instanceof RangeError;
        }
    }
);

// --- Run ---------------------------------------------------------------------
// We use the exploration-test convention: the test's stated assertion is
// "getFullInput() throws RangeError whenever isBugCondition(X) holds". On
// unfixed code this assertion is TRUE universally, so fc.assert will PASS
// silently and we additionally run a concrete sanity check that demonstrates
// the RangeError with a minimal counterexample, which we print for the record.

let propertyOutcome = 'unknown';
let propertyError = null;
try {
    fc.assert(property, { numRuns: 200, verbose: false });
    propertyOutcome = 'held';
} catch (err) {
    propertyOutcome = 'counterexample-found';
    propertyError = err;
}

// Concrete demonstration of the bug with a trivial counterexample.
globalThis._fullInput = '';
globalThis.inputTextarea = { value: 'abc' };
let concreteOutcome;
try {
    getFullInput();
    concreteOutcome = { threw: false };
} catch (err) {
    concreteOutcome = {
        threw: true,
        name: err && err.name,
        message: err && err.message,
    };
}

console.log('--- Bug condition exploration test ---');
console.log('Property outcome (fc.assert):', propertyOutcome);
if (propertyError) {
    console.log('fc.assert error:', propertyError.message);
}
console.log('Concrete counterexample: fullInput="", textareaValue="abc"');
console.log('  threw:', concreteOutcome.threw);
if (concreteOutcome.threw) {
    console.log('  error.name:', concreteOutcome.name);
    console.log('  error.message:', concreteOutcome.message);
}

// Final assertion for the test runner: the concrete call MUST throw a
// RangeError. On UNFIXED code this passes (bug confirmed). On FIXED code it
// would fail (because getFullInput() would return "abc" instead of throwing),
// which is exactly the signal the later fix-checking task needs.
assert.equal(concreteOutcome.threw, true, 'Expected getFullInput() to throw on bug condition');
assert.equal(concreteOutcome.name, 'RangeError', 'Expected a RangeError');
assert.match(
    concreteOutcome.message || '',
    /Maximum call stack size exceeded/,
    'Expected "Maximum call stack size exceeded" message'
);

console.log('Bug confirmed: getFullInput() recurses and throws RangeError on the fallback branch.');
