import { AsyncLocalStorage } from 'node:async_hooks'

type CommandExit = { exitCode: number | null }

const commandExit = new AsyncLocalStorage<CommandExit>()

/**
 * Run one sheets command in a scope that collects its failure code.
 *
 * `process.exitCode` is written once, here, after the command finishes. Helpers below the command
 * layer report through {@link failCommand} instead of assigning it in place — `setTypedRange` used
 * to set `exitCode = 1` itself while its caller `executePlan` also threw, so exit policy was smeared
 * across the stack and any caller composing those helpers silently inherited the side effect.
 */
export const withCommandExit = async (action: () => Promise<void>): Promise<void> => {
	const scope: CommandExit = { exitCode: null }
	await commandExit.run(scope, action)
	if (scope.exitCode != null) {
		process.exitCode = scope.exitCode
	}
}

/**
 * Record a failing exit code for the running command.
 *
 * First failure wins: a command aborts on its first failure, and later bookkeeping (a partial
 * traversal noting `1`) must not downgrade the reason it actually stopped.
 *
 * Outside a {@link withCommandExit} scope the code goes straight to `process.exitCode`, so a helper
 * called from a bare Commander action still reports rather than swallowing the failure.
 *
 * @returns `null`, so callers can `return failCommand(2)` from a `… | null` position.
 */
export const failCommand = (exitCode: number): null => {
	const scope = commandExit.getStore()
	if (!scope) {
		process.exitCode = exitCode
		return null
	}
	if (scope.exitCode == null) {
		scope.exitCode = exitCode
	}
	return null
}
