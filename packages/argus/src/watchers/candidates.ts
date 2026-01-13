import type { WatcherRecord } from '@vforsh/argus-core'
import type { Output } from '../output/io.js'
import { formatWatcherLine } from '../output/format.js'

export const writeWatcherCandidates = (watchers: WatcherRecord[], output: Output): void => {
	for (const watcher of watchers) {
		output.writeWarn(formatWatcherLine(watcher))
	}
}
