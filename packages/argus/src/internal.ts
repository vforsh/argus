/**
 * Repo-internal entry point, consumed only by `e2e/`.
 *
 * **Not public API.** Nothing here carries semver guarantees and none of it is supported for
 * outside consumers; anything genuinely public belongs in `index.ts`. It exists so the test suite
 * reaches the CLI through the package's export map instead of relative paths into `src/`, which
 * keeps the set of test-visible symbols explicit — adding a line here is a deliberate act, and a
 * moved file no longer silently rewires a test.
 */

export { loadArgusConfig, resolveArgusConfigPath } from './config/loadConfig.js'
export { mergeChromeStartOptionsWithConfig, mergeWatcherStartOptionsWithConfig } from './config/mergeConfig.js'
export { loadEvalArgsFile, parseEvalArgFlags, resolveEvalArgs } from './commands/evalArgs.js'
export { bundleEvalEntry, type BundleEvalEntryResult } from './commands/evalBundle.js'
export { fileUsesModuleSyntax } from './commands/evalModuleSyntax.js'
export { createEvalResultFileSink, formatRotatedPath } from './commands/evalResultOutput.js'
export { parseDurationFlagMs, parseTimeoutMs, resolveBundleDecision, resolveExpression, wrapExpressionWithArgs } from './commands/evalShared.js'
export {
	inferRecordFormatFromOutFile,
	parseRecordClipValue,
	parseRecordFormatValue,
	parseRecordFpsValue,
	validateRecordOutFile,
	validateRecordOutFileForFormat,
} from './commands/record.js'
export { formatEvalTransportError } from './eval/evalClient.js'
export { createOutput, type Output } from './output/io.js'
