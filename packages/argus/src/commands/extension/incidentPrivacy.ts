import { createHash } from 'node:crypto'
import { errorEvidence } from '@vforsh/argus-core'
const SAFE_ISSUES = new Set([
	'No native journal exists; host may not have started with diagnostics enabled.',
	'No retained lifecycle events are available.',
	'Oversized journal omitted',
	'Invalid journal record omitted',
	'Incomplete journal record omitted',
	'One native journal could not be read (rotation or permissions).',
	'Could not read all native journals (permissions or concurrent rotation).',
	'Native messaging hosts are not fully configured.',
	'No extension control watcher in registry; worker startup/registration is unknown.',
	'Extension control bridge is disconnected.',
	'Only first 32 extension transports probed.',
	'Invalid diagnostics response; worker readiness unknown',
	'Invalid targets response; target readiness unknown',
])

/** Remove arbitrary strings/content from incident exports; allow only explicit diagnostic metadata. */
export function redactIncident(value: unknown, key = ''): unknown {
	if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
	if (Array.isArray(value)) return value.map((item) => redactIncident(item, key))
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([name]) => !/cookie|token|authorization|password|payload|result|params|args/i.test(name))
				.map(([name, item]) => [name, redactIncident(item, name)]),
		)
	}
	if (typeof value !== 'string') return null
	if (key === 'issues') return SAFE_ISSUES.has(value) ? value : `[free-form error omitted; category: ${errorEvidence(value).category}]`
	if (key === 'createdAt') return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? value : '[redacted]'
	if (['session', 'correlationId', 'channel'].includes(key)) return /^(?:[a-f0-9-]{36}|wrapper-\d+)$/.test(value) ? value : '[redacted]'
	if (key === 'category') return errorEvidence(value).category
	if (key === 'reason')
		return ['install', 'update', 'chrome_update', 'shared_module_update', 'unsupported platform', 'process snapshot unavailable'].includes(value)
			? value
			: '[redacted]'
	if (['id', 'watcherId'].includes(key)) return `id-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
	if (['host', 'hostName'].includes(key)) return /^com\.vforsh\.argus\.(bridge|control)$/.test(value) ? value : '[redacted]'
	if (key === 'path') return ['/status', '/targets', '/extension/diagnostics', '/eval', '/attach'].includes(value) ? value : '[redacted]'
	if (['operation', 'type', 'source', 'transport', 'outcome', 'execution', 'state', 'resource'].includes(key))
		return /^[\w .;-]{1,160}$/.test(value) ? value : '[redacted]'
	if (['extensionVersion', 'nativeHostVersion', 'cliVersion', 'runtime', 'version'].includes(key))
		return /^v?\d+[.\w-]*$/.test(value) ? value : '[redacted]'
	if (key === 'stack')
		return (
			value
				.match(/[\w-]+\.(?:js|ts):\d+:\d+/g)
				?.slice(0, 6)
				.join('\n') ?? ''
		)
	if (['lastConfirmedPhase', 'workerState', 'processIdentity'].includes(key)) return value.slice(0, 512)
	return '[redacted]'
}
