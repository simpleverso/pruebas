# Quitarformato Button Fix — Bugfix Design

## Overview

Nine buttons in the "Text, JSON & Base64 Tools" section of `logs2.html` are all broken by a single defect: the `getFullInput()` helper (line ~1517) recurses into itself on its fallback branch instead of returning `inputTextarea.value`. Every affected handler starts with `const input = getFullInput();`, so each one throws `RangeError: Maximum call stack size exceeded` before doing any real work. The fix is a one-line replacement inside `getFullInput()` — change `return getFullInput();` to `return inputTextarea.value;`. No other code in the file is touched, and the large-input buffering branch is preserved verbatim.

## Glossary

- **Bug_Condition (C)**: `_fullInput` is empty OR `_fullInput.length <= INPUT_DISPLAY_LIMIT` at the moment `getFullInput()` is called — i.e. the branch that is supposed to fall back to the textarea value.
- **Property (P)**: When C holds, `getFullInput()` returns `inputTextarea.value` and does not throw.
- **Preservation**: When C does NOT hold (buffered large input present), `getFullInput()` still returns `_fullInput`. All nine downstream handlers also remain byte-for-byte identical in their own logic.
- **`getFullInput()`**: Helper in `logs2.html` (~line 1513) that callers use to obtain the current input string. Intended to return the buffered large input when present, otherwise the textarea value.
- **`getFullOutput()`**: Sibling helper (~line 1502) that correctly falls back to `outputTextarea.textContent`. It is the reference implementation for how `getFullInput()` was intended to be written.
- **`_fullInput`**: Module-level string holding the full in-memory input for large files that exceed `INPUT_DISPLAY_LIMIT`.
- **`INPUT_DISPLAY_LIMIT`**: Constant set to `200000` — the maximum number of characters kept in the textarea before the large-input buffer kicks in.
- **`inputTextarea`**: The DOM `<textarea id="inputText">` element holding user-visible input.

## Bug Details

### Bug Condition

The bug manifests every time `getFullInput()` is called and the buffered large-input branch is not taken — which is the common case. The function's fallback branch calls itself (`return getFullInput();`) instead of returning `inputTextarea.value`, producing unbounded recursion and a synchronous `RangeError`. Because all nine affected handlers invoke `getFullInput()` as their first statement, the error is thrown inside each `onclick` before any handler-specific logic runs.

**Formal Specification:**

```
FUNCTION isBugCondition(X)
  INPUT: X of type AppState  // { fullInput: string, textareaValue: string }
  OUTPUT: boolean

  RETURN (X.fullInput = "") OR (LENGTH(X.fullInput) <= INPUT_DISPLAY_LIMIT)
END FUNCTION
```

### Examples

- User pastes `{"a":1}` into the textarea and clicks "Format JSON" → expected: formatted JSON in Result; actual: `RangeError: Maximum call stack size exceeded`, Result unchanged.
- User pastes a short AWS log line and clicks "Anonymize account ARNs" → expected: anonymized output; actual: same `RangeError`, no output.
- User clicks "Quitar Formato" with an empty textarea → expected: "Input is empty." message; actual: `RangeError` thrown before the `!input.trim()` guard runs.
- User loads a 5 MB file so `_fullInput.length > INPUT_DISPLAY_LIMIT` and clicks "Quitar Formato" → this path works today because the buffered branch returns early. It must continue to work after the fix.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Large-input buffering: when `_fullInput` is set and longer than `INPUT_DISPLAY_LIMIT`, `getFullInput()` still returns `_fullInput`.
- Handler logic: all nine handlers (`runBase64Tool`, `addNewLines`, `validateJson`, `formatJson`, `anonymizeAwsArns`, `anonymizeAwsBuckets`, `anonymizeAwsRoles`, `extractAwsResources`, `quitarFormato`) retain identical behavior on identical input.
- `quitarFormato()` large-input path (>2,000,000 chars) still shows the "Cleaning format from X MB..." message and defers `_quitarFormatoCore` via `setTimeout`.
- `_quitarFormatoCore` applies the same replacement pipeline and produces identical output.
- Buttons that do not route through `getFullInput()` — Clear, the epoch converters, Copy, Download, the WebLLM link — behave exactly as before.

**Scope:**
All call sites that do NOT hit the defective fallback branch of `getFullInput()` must be completely unaffected. This includes:
- Large-input flows (`_fullInput.length > INPUT_DISPLAY_LIMIT`).
- Any handler that does not call `getFullInput()`.
- DOM structure, event bindings, CSS, and UI layout.

## Hypothesized Root Cause

The root cause is known and singular — confirmed by direct source inspection at `logs2.html` line ~1513–1519:

```js
function getFullInput() {
    // If we have a buffered large input, return it; otherwise return textarea value
    if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
        return _fullInput;
    }
    return getFullInput();   // <-- defect: unbounded recursion
}
```

The comment explicitly states the intent ("otherwise return textarea value"), and the sibling helper `getFullOutput()` — defined a few lines above — implements that exact pattern correctly:

```js
function getFullOutput() {
    return _fullOutput || outputTextarea.textContent;
}
```

The author clearly intended `getFullInput()` to mirror `getFullOutput()` but accidentally typed the function name in the fallback instead of `inputTextarea.value`. This is the only divergence between the two helpers, and no other site in the file needs to change.

## Correctness Properties

Property 1: Bug Condition — `getFullInput()` returns textarea value on fallback

_For any_ application state `X` where the bug condition holds (`_fullInput` is empty OR `_fullInput.length <= INPUT_DISPLAY_LIMIT`), the fixed `getFullInput()` SHALL return `inputTextarea.value` and SHALL NOT throw.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation — buffered large-input branch unchanged

_For any_ application state `X` where the bug condition does NOT hold (`_fullInput` is set AND `_fullInput.length > INPUT_DISPLAY_LIMIT`), the fixed `getFullInput()` SHALL return exactly the same value as the original function — namely `_fullInput` — preserving the large-file in-memory buffering contract.

**Validates: Requirements 3.1**

## Fix Implementation

### Changes Required

**File**: `logs2.html`

**Function**: `getFullInput()` (around line 1513)

**Specific Changes**:

1. **Replace the recursive fallback with the textarea read**: swap the single line `return getFullInput();` for `return inputTextarea.value;`. This mirrors the shape of `getFullOutput()` and matches the inline comment's stated intent.

**Diff-style snippet** (context unchanged, one line replaced):

```diff
 function getFullInput() {
     // If we have a buffered large input, return it; otherwise return textarea value
     if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) {
         return _fullInput;
     }
-    return getFullInput();
+    return inputTextarea.value;
 }
```

Nothing else in `logs2.html` is modified. The nine affected handlers are not touched — they regain functionality automatically because their first statement `const input = getFullInput();` stops throwing.

### Why This Preserves Large-Input Handling

The `if (_fullInput && _fullInput.length > INPUT_DISPLAY_LIMIT) { return _fullInput; }` guard is untouched by the change. Any caller that previously benefited from the buffered large-input path still hits that branch and returns `_fullInput` before the modified line is ever reached. Large-file flows — including drag-and-drop of multi-MB `.txt`/`.csv`/`.json` files that populate `_fullInput` via `setInput()` — continue to read the full in-memory buffer rather than the truncated textarea preview.

## Testing Strategy

### Validation Approach

Two-phase, lightweight: first surface a counterexample that demonstrates the recursion on unfixed code, then verify the fix satisfies both the Fix property and the Preservation property via small pure-JS property tests. Because `getFullInput()` only depends on two module-level symbols (`_fullInput`, `INPUT_DISPLAY_LIMIT`) and one DOM reference (`inputTextarea`), the tests can run outside the browser by stubbing `inputTextarea` with a minimal `{ value }` object.

### Exploratory Bug Condition Checking

**Goal**: Confirm the recursion hypothesis before changing code.

**Test Plan**: Copy the unfixed `getFullInput()` body into a test harness, stub `inputTextarea = { value: "hello" }`, set `_fullInput = ""` and `INPUT_DISPLAY_LIMIT = 200000`, then call `getFullInput()` and assert it throws a `RangeError`. Repeat with `_fullInput = "short"` (length ≤ limit) to confirm the same failure mode.

**Test Cases**:
1. **Empty input**: `_fullInput = ""`, textarea value `"abc"` → expect `RangeError` (will fail on unfixed code in the sense of "demonstrates the bug").
2. **Short buffered input**: `_fullInput = "short"` (length ≤ `INPUT_DISPLAY_LIMIT`), textarea value `"abc"` → expect `RangeError`.
3. **End-to-end handler smoke**: in the actual page, click "Format JSON" with `{"a":1}` in the textarea → expect `RangeError` in the console (optional, for realism).

**Expected Counterexamples**:
- `getFullInput()` throws `RangeError: Maximum call stack size exceeded` whenever the bug condition holds.
- Confirms root cause: the fallback branch calls itself.

### Fix Checking

**Goal**: Verify that for all inputs where the bug condition holds, the fixed `getFullInput()` returns `inputTextarea.value` and does not throw.

**Pseudocode:**

```
FOR ALL X WHERE isBugCondition(X) DO
  result := getFullInput_fixed(X)   // X provides _fullInput and inputTextarea.value
  ASSERT no_throw(result)
  ASSERT result = X.textareaValue
END FOR
```

**Property-Based Test (sketch)**:

```js
// Fix property
fc.assert(fc.property(
  fc.string(),                                  // textareaValue
  fc.oneof(fc.constant(""),                     // fullInput: empty
           fc.string({ maxLength: 200000 })),   //   or length <= INPUT_DISPLAY_LIMIT
  (textareaValue, fullInput) => {
    globalThis.INPUT_DISPLAY_LIMIT = 200000;
    globalThis._fullInput = fullInput;
    globalThis.inputTextarea = { value: textareaValue };
    const result = getFullInput();              // fixed version under test
    return result === textareaValue;
  }
));
```

### Preservation Checking

**Goal**: Verify that for all inputs where the bug condition does NOT hold, the fixed `getFullInput()` returns the same value as the original — namely `_fullInput`.

**Pseudocode:**

```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT getFullInput_original(X) = getFullInput_fixed(X)
END FOR
```

**Testing Approach**: Property-based testing is the right fit because the input domain is "any string longer than `INPUT_DISPLAY_LIMIT`," which is trivially parameterized and hard to enumerate by hand.

**Property-Based Test (sketch)**:

```js
// Preservation property
fc.assert(fc.property(
  fc.string(),                                               // textareaValue (irrelevant here)
  fc.string({ minLength: 200001, maxLength: 200050 }),       // fullInput: length > INPUT_DISPLAY_LIMIT
  (textareaValue, fullInput) => {
    globalThis.INPUT_DISPLAY_LIMIT = 200000;
    globalThis._fullInput = fullInput;
    globalThis.inputTextarea = { value: textareaValue };
    return getFullInput() === fullInput;
  }
));
```

### Unit Tests

- `getFullInput()` with `_fullInput = ""` returns `inputTextarea.value`.
- `getFullInput()` with `_fullInput` length exactly equal to `INPUT_DISPLAY_LIMIT` returns `inputTextarea.value` (boundary).
- `getFullInput()` with `_fullInput` length `INPUT_DISPLAY_LIMIT + 1` returns `_fullInput` (boundary).

### Property-Based Tests

- Fix property across arbitrary `(fullInput ≤ limit OR "", textareaValue)` pairs.
- Preservation property across arbitrary `fullInput > limit` strings.

### Integration Tests

- Manual smoke: load `logs2.html`, paste `{"a":1}`, click each of the nine buttons, confirm expected behavior and no console errors.
- Manual smoke: drag-and-drop a >200 KB file, click "Quitar Formato", confirm the large-input path still reads the full buffer.

## Risk & Rollback

The change is a single statement inside one helper. Rollback is trivial: revert the one line. Risk of side-effect interaction with the large-input flow is nil — the modified line lives after an early-return guard that protects the buffered branch, so no caller that currently hits the large-input path can reach the new code. No other helper, handler, or UI element is touched.

## Out of Scope

Explicitly not part of this fix:

- Modifying any of the nine affected handlers (`runBase64Tool`, `addNewLines`, `validateJson`, `formatJson`, `anonymizeAwsArns`, `anonymizeAwsBuckets`, `anonymizeAwsRoles`, `extractAwsResources`, `quitarFormato`).
- Restructuring or refactoring the large-input buffering logic (`_fullInput`, `setInput`, `INPUT_DISPLAY_LIMIT`).
- Adding `try`/`catch` wrappers around handlers or around `getFullInput()`.
- Renaming or reorganizing `getFullInput()` / `getFullOutput()`.
- Any UI, CSS, or DOM changes.
- Touching unrelated helpers such as the epoch converters, Copy, Download, or the WebLLM link.
