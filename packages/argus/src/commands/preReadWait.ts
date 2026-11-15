import type { WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { setExitCode } from '../output/exitCode.js'
import { describeUntilMiss, parseUntilFlags, waitForCondition, type UntilFlags, type UntilPlan } from './conditionWait.js'
import { describeSettleMiss, parseSettleFlags, settlePage, type SettleFlags, type SettlePlan } from './settle.js'

/**
 * `--until` / `--settle` on read commands (`probe`, `eval`, `dom info`, `net`, `screenshot`, …).
 *
 * Agents chained `click …; sleep 3; argus eval …` or polled reads in bash loops (713 sleeps, 130
 * loops in a week). Actions already wait after themselves (`defineActionCommand`); reads wait
 * *before* themselves, so the same two flags turn "wait, then look" into one command.
 *
 * Same building blocks as the post-action wait (`waitForCondition`, `settlePage`), so polling,
 * deadlines, and miss reports stay one implementation.
 */

export type PreReadWaitFlags = UntilFlags & SettleFlags

export type PreReadWaitPlan = { until?: UntilPlan; settle?: SettlePlan }

/**
 * Validate the wait flags before anything else runs.
 *
 * @returns The plan (empty when no wait was asked for), or `null` after a usage error.
 */
export const parsePreReadWaitFlags = (options: PreReadWaitFlags, output: Output): PreReadWaitPlan | null => {
	const until = parseUntilFlags(options, output)
	if (until === null) return null
	const settle = parseSettleFlags(options, output, false)
	if (settle === null) return null
	return { ...(until ? { until } : {}), ...(settle ? { settle } : {}) }
}

export const hasPreReadWait = (plan: PreReadWaitPlan): boolean => plan.until != null || plan.settle != null

/**
 * Settle (best effort, a miss warns) and then poll `--until` (a miss fails the command).
 *
 * @returns `true` when the read should go ahead; `false` after the miss was reported and exit 1 set.
 */
export const runPreReadWait = async (watcher: Pick<WatcherRecord, 'id' | 'host' | 'port'>, plan: PreReadWaitPlan, output: Output): Promise<boolean> => {
	if (plan.settle) {
		const settled = await settlePage(watcher, plan.settle, Date.now())
		if (!settled.settled) output.writeWarn(`${describeSettleMiss(plan.settle, settled)}; reading anyway`)
	}
	if (!plan.until) return true

	const outcome = await waitForCondition(watcher, plan.until)
	if (outcome.matched) return true

	const message = describeUntilMiss(plan.until, outcome)
	setExitCode(1)
	if (output.json) {
		output.writeJson({ ok: false, error: { message, code: 'wait_timeout' }, until: outcome })
	} else {
		output.writeWarn(message)
	}
	return false
}
