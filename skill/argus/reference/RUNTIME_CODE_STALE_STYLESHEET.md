# Runtime Code Issue: Stale Stylesheet IDs Break `code grep`

## Summary

`argus code grep` can fail while searching runtime code with a Chrome DevTools Protocol error like:

```text
Error: {"code":-32000,"message":"No style sheet with given id found"}
```

Observed effect: the entire grep aborts even when the search target is a JavaScript symbol and matching script resources are present.

This has been observed against an extension-attached page after reload, but the failure mode is broader: any flow that leaves a stale stylesheet handle in the runtime resource inventory can trigger it.

---

## Symptom

Example command:

```bash
argus code grep showLogsByHost --id extension
```

Expected:

- Argus scans discovered runtime resources.
- Matching JS lines are returned.

Actual:

- Argus aborts with `No style sheet with given id found`.
- No JS matches are returned, even if the bundle definitely contains the symbol.

---

## Why This Happens

Runtime-code inspection currently tracks both scripts and stylesheets through CDP.

Relevant implementation: `packages/argus-watcher/src/cdp/editor.ts`.

Key behavior:

- `CSS.styleSheetAdded` events are stored in `stylesheets`.
- `code grep` iterates over `getResources()`, which merges scripts and stylesheets.
- `getSource(resource)` dispatches by resource type.
- Stylesheets are fetched via `CSS.getStyleSheetText`.

Current grep path:

```ts
for (const resource of getResources()) {
	const source = await getSource(resource)
	...
}
```

Stylesheet source path:

```ts
async function readStylesheetSource(resource: RuntimeResource): Promise<string> {
	const result = (await session.sendAndWait(
		'CSS.getStyleSheetText',
		{ styleSheetId: resource.id },
		getSessionOptions(resource),
	)) as CssGetStyleSheetTextResult
	return result.text ?? ''
}
```

If Chrome invalidates that `styleSheetId` after reload/navigation/retargeting, `CSS.getStyleSheetText` throws. That exception currently escapes `getSource()` and aborts the whole grep instead of skipping the broken stylesheet.

---

## Likely Trigger Conditions

- Page reload after runtime-code resources were already discovered.
- Extension mode target changes or reattachment.
- Stylesheets being recreated while scripts remain stable.
- A quiet period completing before all obsolete stylesheet handles are naturally replaced.

This is a stale-handle problem, not a "bundle contains invalid CSS" problem.

---

## Why It Is Especially Confusing

- The user may be searching for a JS-only symbol.
- `code grep` does not currently isolate failures per resource.
- The surfaced error mentions a stylesheet, which feels unrelated to the user’s search term.
- The user sees a hard failure instead of partial results.

Net result: one bad stylesheet handle can hide perfectly valid JS matches.

---

## Practical Workaround

Until Argus handles this gracefully, the blunt workaround is:

1. Fetch the shipped JS bundle directly.
2. Grep it locally.

Example:

```bash
curl -s https://target.example/js/app.js | rg showLogsByHost
```

Why this works:

- It bypasses the mixed runtime resource inventory.
- It avoids `CSS.getStyleSheetText` entirely.
- It is good enough when you only need strings from a shipped bundle.

Downside:

- Loses some of the value of runtime-code inspection: inline scripts, post-load resources, per-target resource discovery, synthetic `inline://...` handles, and direct integration with Argus output formatting.

---

## Fix Direction

The safer behavior is not "never track CSS". The safer behavior is "one bad resource must not kill the whole search".

Recommended changes:

- Catch per-resource read failures inside `grep()`.
- Skip resources that fail to load, optionally recording a warning.
- Consider evicting failed stylesheet entries from the cache/map when CDP reports them as missing.
- Optionally add a `--type script|stylesheet|all` filter so JS-only searches can avoid CSS entirely.

Minimal resilient approach:

```ts
for (const resource of getResources()) {
	let source: string
	try {
		source = await getSource(resource)
	} catch (error) {
		continue
	}
	...
}
```

Better version:

- continue on failure
- collect skipped resource metadata
- surface a summary warning in human output / JSON

Example warning:

```text
Skipped 1 runtime resource while grepping: stylesheet https://example/style.css (CDP: No style sheet with given id found)
```

---

## Acceptance Criteria For A Fix

- `argus code grep <pattern>` still returns JS matches when one stylesheet handle is stale.
- JSON mode remains valid and includes warnings/skipped counts if implemented.
- `code read` on a stale stylesheet can still fail, but the error should be scoped to that single resource.
- Reload + extension-attached flows no longer make `code grep` unusable.

---

## Suggested Follow-Up Tests

- E2E repro where a stylesheet ID becomes stale after reload and grep still returns script matches.
- Coverage for both plain output and `--pretty`.
- Coverage for JSON output if skipped-resource reporting is added.
- Optional test for `--type script` if that filter is introduced.

---

## Status

Documented issue. Root cause is a likely stale stylesheet handle inside runtime-code resource traversal, with failure currently escaping the per-resource loop.
