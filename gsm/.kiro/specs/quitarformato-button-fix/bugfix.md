# Bugfix Requirements Document

> Note on naming: the spec directory is `quitarformato-button-fix` for historical reasons (the bug was first reported against the "Quitar Formato" button). The actual scope is broader — see below. The directory name has intentionally not been changed to avoid churn in the spec config.

## Introduction

Every button in the "Text, JSON & Base64 Tools" section of `logs2.html` that reads from the input textarea is broken. Nine separate buttons appear dead on click, producing no visible change to the Input or Result areas. The root cause is a single defect: an infinite recursion inside the `getFullInput()` helper (logs2.html line ~1517). When the input is not a buffered large input (the common case), `getFullInput()` calls itself instead of returning `inputTextarea.value`, triggering a synchronous `RangeError: Maximum call stack size exceeded`. Because every affected button invokes `getFullInput()` as its first step, the error is thrown inside each `onclick` handler before any real work can run, and the user perceives all of them as silently broken.

The affected buttons are:

1. `runBase64Tool()` — "Run Base64 Tool"
2. `addNewLines()` — "Convert Text"
3. `validateJson()` — "Validate JSON"
4. `formatJson()` — "Format JSON"
5. `anonymizeAwsArns()` — "Anonymize account ARNs"
6. `anonymizeAwsBuckets()` — "Anonymize Buckets ARNs"
7. `anonymizeAwsRoles()` — "Anonymize Role ARNs"
8. `extractAwsResources()` — "Extract AWS Infra, CLI & IDs"
9. `quitarFormato()` — "Quitar Formato"

Buttons that do not route through `getFullInput()` — Clear, the epoch converters, Copy, Download, and the WebLLM link — are unaffected and continue to work.

The fix is a single one-line change inside `getFullInput()`: replace the recursive `return getFullInput();` with `return inputTextarea.value;`.

## Bug Analysis

### Current Behavior (Defect)

All nine buttons listed above fail with the same symptom for the same reason: each one calls `getFullInput()` as its first statement, and `getFullInput()` recurses into itself when `_fullInput` is empty or its length is at or below `INPUT_DISPLAY_LIMIT` (200000 characters).

1.1 WHEN the user clicks any of the nine listed buttons ("Run Base64 Tool", "Convert Text", "Validate JSON", "Format JSON", "Anonymize account ARNs", "Anonymize Buckets ARNs", "Anonymize Role ARNs", "Extract AWS Infra, CLI & IDs", "Quitar Formato") with a non-empty input whose length is less than or equal to `INPUT_DISPLAY_LIMIT` (200000 characters) THEN the system throws `RangeError: Maximum call stack size exceeded` from `getFullInput()` and leaves both the Input and Result areas unchanged
1.2 WHEN the user clicks any of the nine listed buttons with an empty input THEN the system throws `RangeError: Maximum call stack size exceeded` from `getFullInput()` before the handler's empty-input guard (where one exists, e.g. the `!input.trim()` check in `quitarFormato`) can run, so empty-input messages such as "Input is empty." are never displayed
1.3 WHEN any caller invokes `getFullInput()` while `_fullInput` is empty or its length is less than or equal to `INPUT_DISPLAY_LIMIT` THEN the system throws `RangeError: Maximum call stack size exceeded` instead of returning the current textarea value

### Expected Behavior (Correct)

After the fix, `getFullInput()` must return the textarea value in the non-buffered case, and every listed button must perform its documented operation normally.

2.1 WHEN the user clicks any of the nine listed buttons with a non-empty input whose length is less than or equal to `INPUT_DISPLAY_LIMIT` (200000 characters) THEN the system SHALL execute that button's documented operation (Base64 conversion, line conversion, JSON validation, JSON formatting, ARN/bucket/role anonymization, AWS resource extraction, or format stripping) against the textarea's current value and update the Input and/or Result areas accordingly, without throwing any error
2.2 WHEN the user clicks any of the nine listed buttons with an empty input THEN the system SHALL run that handler's normal empty-input path (e.g. display "Input is empty." for `quitarFormato`, or the handler's own equivalent message) without throwing any error
2.3 WHEN any caller invokes `getFullInput()` while `_fullInput` is empty or its length is less than or equal to `INPUT_DISPLAY_LIMIT` THEN the system SHALL return the current value of `inputTextarea.value` without recursing or throwing

### Unchanged Behavior (Regression Prevention)

The fix must be scoped to the one-line recursion bug inside `getFullInput()`. All other existing behavior — including the large-input buffering path, the operation logic inside each of the nine handlers, and every button that already works — must be preserved byte-for-byte.

3.1 WHEN any caller invokes `getFullInput()` with a buffered large input (`_fullInput` is set and its length is greater than `INPUT_DISPLAY_LIMIT`) THEN the system SHALL CONTINUE TO return `_fullInput` so that large-file flows read the full content rather than the truncated textarea preview
3.2 WHEN `quitarFormato()` is invoked with input length greater than 2000000 characters THEN the system SHALL CONTINUE TO show the "Cleaning format from X MB..." progress message and defer `_quitarFormatoCore` via `setTimeout`
3.3 WHEN `_quitarFormatoCore` processes any input THEN the system SHALL CONTINUE TO apply the same set of replacements (HTML tags, Markdown constructs, HTML entities, emoji blocks, common symbols, tabs, control characters, zero-width characters, whitespace collapsing, trim) and produce identical output for identical input
3.4 WHEN any of the other eight handlers (`runBase64Tool`, `addNewLines`, `validateJson`, `formatJson`, `anonymizeAwsArns`, `anonymizeAwsBuckets`, `anonymizeAwsRoles`, `extractAwsResources`) runs on input it previously could process without crashing THEN the system SHALL CONTINUE TO produce identical output for identical input — only the recursion inside `getFullInput()` is allowed to change
3.5 WHEN the user interacts with buttons that do not depend on `getFullInput()` — "Clear" (`clearInput()`), the epoch converters (`convertEpochToGmtMinus6()`, `convertEpochToUtc()`), "Copy" (`copyResult()`), "Download" (`downloadResult()`), and the "WebLLM local" link — THEN the system SHALL CONTINUE TO behave exactly as before

## Deriving the Bug Condition

### Bug Condition Function

```pascal
FUNCTION isBugCondition(X)
  INPUT: X of type AppState  // { fullInput: string, textareaValue: string }
  OUTPUT: boolean

  // The defective branch of getFullInput() runs when the buffered
  // large-input path is NOT taken, i.e. _fullInput is empty/short.
  RETURN (X.fullInput = "") OR (LENGTH(X.fullInput) <= INPUT_DISPLAY_LIMIT)
END FUNCTION
```

### Property: Fix Checking

```pascal
// For every input that currently triggers the recursion,
// getFullInput() must return the textarea value without throwing.
// This fixes all nine callers at once because they all start with
// `const input = getFullInput();`.
FOR ALL X WHERE isBugCondition(X) DO
  result ← getFullInput'(X)
  ASSERT no_throw(result) AND result = X.textareaValue
END FOR
```

### Property: Preservation Checking

```pascal
// For non-buggy inputs (buffered large input present), the fixed
// function must behave identically to the original.
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT getFullInput(X) = getFullInput'(X)  // both return X.fullInput
END FOR
```

Where `F = getFullInput` (original, recursive) and `F' = getFullInput` after the fix.
