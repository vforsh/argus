import path from 'node:path'
import { getArgusHomeDir, readJsonFile, updateJsonFile } from '@vforsh/argus-core'

/**
 * Human labels for browser instances (`codex`, `chrome`), keyed by the extension's persistent
 * per-profile instance id. A label is only ever assigned explicitly — `argus ext browsers label`,
 * or a successful ticket bind, which proves that instance is the browser the agent drives.
 * Nothing is inferred from URLs or extension ids.
 */

/** How a label was assigned. */
export type BrowserLabelSource = 'manual' | 'bind'

export type BrowserLabel = {
	label: string
	source: BrowserLabelSource
	updatedAt: number
}

type BrowserLabelsFile = { version: 1; labels: Record<string, BrowserLabel> }

const EMPTY: BrowserLabelsFile = { version: 1, labels: {} }

const getLabelsPath = (): string => path.join(getArgusHomeDir(), 'browsers.json')

const isLabelsFile = (value: unknown): value is BrowserLabelsFile =>
	!!value && typeof value === 'object' && (value as BrowserLabelsFile).version === 1 && typeof (value as BrowserLabelsFile).labels === 'object'

/** Labels keyed by browser instance id. */
export const readBrowserLabels = async (): Promise<Record<string, BrowserLabel>> => (await readJsonFile(getLabelsPath(), EMPTY, isLabelsFile)).labels

/** Assign `label` to one browser instance, replacing its previous label. */
export const setBrowserLabel = async (instanceId: string, label: string, source: BrowserLabelSource): Promise<void> => {
	await updateJsonFile(getLabelsPath(), EMPTY, isLabelsFile, (file) => ({
		...file,
		labels: { ...file.labels, [instanceId]: { label, source, updatedAt: Date.now() } },
	}))
}
