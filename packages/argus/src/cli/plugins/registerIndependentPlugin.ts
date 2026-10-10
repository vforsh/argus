import type { ArgusPluginContextV1, ArgusPluginManifestV1, ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import type { Command } from 'commander'

/** Stage additive registrations; attach only after registration and ownership checks succeed.
 * This isolates Commander state, not arbitrary JavaScript execution. Legacy modules remain unrestricted.
 */
export const registerIndependentPlugin = async (plugin: ArgusPluginV1, manifest: ArgusPluginManifestV1, ctx: ArgusPluginContextV1): Promise<void> => {
	const live = ctx.program
	const staged = live.createCommand(live.name()).copyInheritedSettings(live)
	// Commander inherits these by reference; detach mutable configuration before plugin code runs.
	staged.configureOutput({ ...live.configureOutput() })
	staged.configureHelp({ ...live.configureHelp() })
	const baseline = rootState(staged)
	await plugin.register({ ...ctx, program: staged })
	if (!sameState(baseline, rootState(staged)))
		throw new Error(`Plugin "${plugin.name}" with eager:false changed program settings; register only additive commands or declare eager:true.`)
	const advertised = new Set(manifest.commands)
	const actual = new Set(staged.commands.flatMap(names))
	if (advertised.size !== actual.size || [...actual].some((name) => !advertised.has(name))) {
		throw new Error(
			`Plugin "${plugin.name}" manifest commands [${[...advertised]}] do not match registered roots/aliases [${[...actual]}]. Rebuild its manifest.`,
		)
	}
	if (plugin.name !== manifest.name || !sameNames(plugin.commands ?? [], manifest.commands))
		throw new Error(`Plugin "${plugin.name}" export disagrees with its routing manifest. Rebuild the plugin.`)
	const occupied = new Set(live.commands.flatMap(names))
	const liveNodes = new Set(descendants(live))
	validateTree(staged, liveNodes)
	for (const name of staged.commands.flatMap(names)) {
		if (occupied.has(name)) throw new Error(`Plugin "${plugin.name}" command/alias "${name}" is already owned by another command.`)
		occupied.add(name)
	}
	// Validation is complete before the first live mutation.
	for (const command of [...staged.commands]) live.addCommand(command)
}

const names = (command: Command): string[] => [command.name(), ...command.aliases()]
const sameNames = (a: string[], b: string[]): boolean => a.length === b.length && a.every((name) => b.includes(name))
const descendants = (command: Command): Command[] => command.commands.flatMap((child) => [child, ...descendants(child)])
const validateTree = (root: Command, liveNodes: Set<Command>): void => {
	const visited = new Set<Command>()
	const visit = (parent: Command): void => {
		const occupied = new Set<string>()
		for (const child of parent.commands) {
			if (visited.has(child) || liveNodes.has(child) || child.parent !== parent)
				throw new Error('Plugin reused a command owned by another command tree.')
			visited.add(child)
			for (const name of names(child)) {
				if (occupied.has(name)) throw new Error(`Plugin registered conflicting command/alias "${name}".`)
				occupied.add(name)
			}
			visit(child)
		}
	}
	visit(root)
}
// Commander stores root hooks/options/settings on own fields. Snapshot their containers,
// excluding the additive command list, so root changes cannot silently disappear at attachment.
const rootState = (command: Command): Map<string, unknown> => {
	const fields = Object.entries(command).filter(([key]) => key !== 'commands')
	return new Map(fields.map(([key, value]) => [key, snapshotContainer(value)]))
}
const snapshotContainer = (value: unknown): unknown => {
	if (Array.isArray(value)) return [...value]
	if (value && typeof value === 'object') return { ...value }
	return value
}
const sameState = (before: Map<string, unknown>, after: Map<string, unknown>): boolean => {
	if (before.size !== after.size) return false
	return [...before].every(([key, value]) => sameContainer(value, after.get(key)))
}
const sameContainer = (value: unknown, other: unknown): boolean => {
	if (value === other) return true
	if (!value || !other || typeof value !== 'object' || typeof other !== 'object') return false
	const entries = Object.entries(value)
	if (entries.length !== Object.keys(other).length) return false
	return entries.every(([name, entry]) => (other as Record<string, unknown>)[name] === entry)
}
