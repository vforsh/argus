import type { LogEvent } from '@vforsh/argus-core'
import { previewValue } from '@vforsh/argus-core'

export const previewLogEvent = (event: LogEvent): LogEvent => ({
	...event,
	args: event.args.map((arg) => previewValue(arg)),
})
