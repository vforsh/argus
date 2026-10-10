import type { Command } from 'commander'

const watcherArguments = new WeakSet<Command>()

/** Declare the leading positional argument as the watcher selected by a session. */
export const watcherArgument = (command: Command): Command => {
	watcherArguments.add(command)
	return command
}

/** Explicit roles take precedence; retain the built-in/legacy leading `id` convention. */
export const takesWatcherArgument = (command: Command): boolean => watcherArguments.has(command) || command.registeredArguments[0]?.name() === 'id'
