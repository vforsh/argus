import { ARGUS_PLUGIN_API_VERSION } from '@vforsh/argus-plugin-api'
import packageJson from '../../../package.json' with { type: 'json' }

/** Reject unsupported contracts before executing registration, including manifest-only discovery. */
export const assertPluginCompatibility = (plugin: { apiVersion: unknown; name: string; minArgusVersion?: string }): void => {
	if (plugin.apiVersion !== ARGUS_PLUGIN_API_VERSION) {
		throw new Error(
			`Plugin "${plugin.name}" requires API ${String(plugin.apiVersion)}; Argus ${packageJson.version} supports API ${ARGUS_PLUGIN_API_VERSION}. Update Argus or install a compatible plugin.`,
		)
	}
	if (!plugin.minArgusVersion) return
	const minimum = parseVersion(plugin.minArgusVersion)
	const current = parseVersion(packageJson.version)!
	if (!minimum)
		throw new Error(
			`Plugin "${plugin.name}" declares invalid minArgusVersion "${plugin.minArgusVersion}"; use a semantic version such as 0.5.23.`,
		)
	if (compareVersions(current, minimum) < 0) {
		throw new Error(
			`Plugin "${plugin.name}" requires Argus >=${plugin.minArgusVersion}; installed ${packageJson.version}. Update @vforsh/argus before loading it.`,
		)
	}
}

type Version = { numbers: number[]; prerelease: string[] }
const parseVersion = (value: string): Version | null => {
	const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
		value,
	)
	if (!match) return null
	const prerelease = match[4]?.split('.') ?? []
	if (prerelease.some((part) => /^0\d+$/.test(part))) return null
	return { numbers: match.slice(1, 4).map(Number), prerelease }
}
const compareVersions = (left: Version, right: Version): number => {
	for (let i = 0; i < 3; i++) if (left.numbers[i] !== right.numbers[i]) return left.numbers[i] - right.numbers[i]
	if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length)
	for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i++) {
		const a = left.prerelease[i]
		const b = right.prerelease[i]
		if (a === b) continue
		if (a === undefined || b === undefined) return a === undefined ? -1 : 1
		const an = /^\d+$/.test(a)
		const bn = /^\d+$/.test(b)
		if (an && bn) return Number(a) - Number(b)
		if (an !== bn) return an ? -1 : 1
		return a < b ? -1 : 1
	}
	return 0
}
