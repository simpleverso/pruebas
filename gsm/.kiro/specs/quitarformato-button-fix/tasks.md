# Implementation Plan

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - `getFullInput()` recurses when buffered branch is not taken
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **GOAL**: Surface counterexamples demonstrating that `getFullInput()` throws `RangeError` whenever `isBugCondition(X)` holds
  - Build a lightweight pure-JS PBT harness (no browser). Copy the UNFIXED body of `getFullInput()` (logs2.html ~line 1513) into the harness. Stub `globalThis.inputTextarea = { value: textareaValue }`, set `globalThis.INPUT_DISPLAY_LIMIT = 200000`, and set `globalThis._fullInput = fullInput`
  - Property: `FOR ALL X WHERE isBugCondition(X)` — i.e. `fullInput === ""` OR `fullInput.length <= INPUT_DISPLAY_LIMIT` — calling `getFullInput()` throws `RangeError: Maximum call stack size exceeded`
  - Generators: `textareaValue` = arbitrary string; `fullInput` = `fc.oneof(fc.constant(""), fc.string({ maxLength: 200000 }))`
  - Run test on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS (RangeError thrown for every generated X — this proves the bug exists)
  - Document the counterexamples (e.g. `fullInput=""`, `textareaValue="abc"` → `RangeError`)
  - Mark task complete when the test is written, run, and the failure is documented
  - _Requirements: 1.1, 1.2, 1.3 (from bugfix.md); Property 1 (from design.md)_

- [x] 2. Apply the fix in `logs2.html`
  - In `getFullInput()` (logs2.html ~line 1517), replace the single line `return getFullInput();` with `return inputTextarea.value;`
  - No other file or line is modified. The nine affected handlers (`runBase64Tool`, `addNewLines`, `validateJson`, `formatJson`, `anonymizeAwsArns`, `anonymizeAwsBuckets`, `anonymizeAwsRoles`, `extractAwsResources`, `quitarFormato`) are not touched — they regain functionality automatically because their first statement `const input = getFullInput();` stops throwing
  - _Bug_Condition: `isBugCondition(X)` ≡ `X.fullInput === "" OR X.fullInput.length <= INPUT_DISPLAY_LIMIT` (design.md Glossary + Bug Condition)_
  - _Expected_Behavior: on `isBugCondition(X)`, `getFullInput()` returns `inputTextarea.value` and does not throw (design.md Property 1)_
  - _Preservation: on `NOT isBugCondition(X)`, `getFullInput()` still returns `_fullInput` (design.md Property 2)_
  - _Requirements: 2.1, 2.2, 2.3, 3.1_

- [x] 3. Fix Checking property test (bug condition branch)
  - **Property 1: Expected Behavior** - `getFullInput()` returns `inputTextarea.value` on fallback
  - **IMPORTANT**: Re-use the same harness as task 1, but now load the FIXED `getFullInput()` body
  - Property: `FOR ALL X WHERE isBugCondition(X)`, `getFullInput()` returns exactly `X.textareaValue` and does not throw
  - Generators: `textareaValue` = `fc.string()`; `fullInput` = `fc.oneof(fc.constant(""), fc.string({ maxLength: 200000 }))`
  - Assertion: `result === textareaValue` and no exception
  - Run on FIXED code
  - **EXPECTED OUTCOME**: Test PASSES (confirms bug is fixed)
  - _Requirements: 2.3 (bugfix.md); Property 1 (design.md) — validates clauses 2.1, 2.2, 2.3_

- [x] 4. Preservation Checking property test (large-input branch)
  - **Property 2: Preservation** - buffered large-input branch unchanged
  - **IMPORTANT**: Follow observation-first methodology. On UNFIXED code, observe that when `_fullInput.length > INPUT_DISPLAY_LIMIT` the early-return guard fires and `getFullInput()` returns `_fullInput` without reaching the recursive line. Record that baseline
  - Property: `FOR ALL X WHERE NOT isBugCondition(X)` — i.e. `fullInput.length > INPUT_DISPLAY_LIMIT` — `getFullInput()` returns exactly `fullInput`
  - Generators: `textareaValue` = arbitrary string (irrelevant on this branch); `fullInput` = `fc.string({ minLength: 200001, maxLength: 200050 })` (kept small for test speed while still exceeding the limit)
  - Assertion: `result === fullInput`
  - Run on UNFIXED code → **EXPECTED**: PASSES (establishes the behavior to preserve)
  - Re-run on FIXED code → **EXPECTED**: PASSES (confirms no regression)
  - _Requirements: 3.1 (bugfix.md); Property 2 (design.md)_

- [ ] 5*. Manual smoke test of the nine affected buttons and untouched controls (optional)
  - Open `logs2.html` in a browser, open the DevTools console
  - Paste a small payload (e.g. `{"a":1}` for JSON-shaped buttons, a short AWS log line for the AWS tools, any text for `quitarFormato`)
  - Click each of the nine affected buttons and confirm each performs its documented operation with no console errors:
    - `runBase64Tool` ("Run Base64 Tool"), `addNewLines` ("Convert Text"), `validateJson` ("Validate JSON"), `formatJson` ("Format JSON"), `anonymizeAwsArns` ("Anonymize account ARNs"), `anonymizeAwsBuckets` ("Anonymize Buckets ARNs"), `anonymizeAwsRoles` ("Anonymize Role ARNs"), `extractAwsResources` ("Extract AWS Infra, CLI & IDs"), `quitarFormato` ("Quitar Formato")
  - Click `quitarFormato` with an empty textarea and confirm "Input is empty." is shown (empty-input guard reachable again)
  - Verify untouched controls still behave exactly as before: Clear (`clearInput`), the epoch converters (`convertEpochToGmtMinus6`, `convertEpochToUtc`), Copy (`copyResult`), Download (`downloadResult`), and the "WebLLM local" link
  - Confirm the console stays clean throughout
  - _Requirements: 2.1, 2.2, 3.2, 3.3, 3.4, 3.5_
