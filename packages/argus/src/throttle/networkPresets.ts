import type { ThrottleNetworkState } from '@vforsh/argus-core'

type NetworkPreset = {
	name: string
	condition: ThrottleNetworkState
}

const presets: NetworkPreset[] = [
	{
		name: 'slow-3g',
		condition: { offline: false, latency: 400, downloadThroughput: 51_200, uploadThroughput: 25_600 },
	},
	{
		name: 'fast-3g',
		condition: { offline: false, latency: 150, downloadThroughput: 192_000, uploadThroughput: 57_600 },
	},
	{
		name: '4g',
		condition: { offline: false, latency: 20, downloadThroughput: 4_194_304, uploadThroughput: 3_145_728 },
	},
	{
		name: 'offline',
		condition: { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
	},
]

const presetMap = new Map(presets.map((p) => [p.name, p.condition]))

/** Resolve a network preset by name. Returns null if not found. */
export const resolveNetworkPreset = (name: string): ThrottleNetworkState | null => presetMap.get(name) ?? null

/** List available preset names. */
export const listNetworkPresetNames = (): string[] => presets.map((p) => p.name)
