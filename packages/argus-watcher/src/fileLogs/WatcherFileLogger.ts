import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import type { LogEvent, WatcherChrome, WatcherMatch } from 'argus-core'

type PageInfo = {
	url: string
	title: string | null
}

export type WatcherFileLoggerOptions = {
	watcherId: string
	startedAt: number
	logsDir: string
	chrome: WatcherChrome
	match?: WatcherMatch
}

export class WatcherFileLogger {
	private readonly watcherId: string
	private readonly startedAt: number
	private readonly startedAtIso: string
	private readonly logsDir: string
	private readonly chrome: WatcherChrome
	private readonly match?: WatcherMatch
	private currentStream: fs.WriteStream | null = null
	private writePromise: Promise<void> = Promise.resolve()
	private fileIndex = 1
	private needsNewFile = true
	private hasCreatedFile = false
	private currentPageUrl: string | null = null
	private currentPageTitle: string | null = null
	private closed = false
	private failed = false

	constructor(options: WatcherFileLoggerOptions) {
		this.watcherId = options.watcherId
		this.startedAt = options.startedAt
		this.startedAtIso = toSafeTimestamp(options.startedAt)
		this.logsDir = options.logsDir
		this.chrome = options.chrome
		this.match = options.match
	}

	writeEvent(event: Omit<LogEvent, 'id'>): void {
		if (this.closed || this.failed) {
			return
		}
		this.enqueueGuarded(async () => {
			const previousPageUrl = this.currentPageUrl
			if (!this.currentPageUrl && event.pageUrl) {
				this.currentPageUrl = event.pageUrl
			}
			if (!this.currentPageTitle && event.pageTitle) {
				this.currentPageTitle = event.pageTitle
			}
			await this.ensureStream()
			const line = formatLogLine(event, previousPageUrl)
			await this.writeToStream(line)
		})
	}

	rotate(info: PageInfo): void {
		if (this.closed || this.failed) {
			return
		}
		this.enqueueGuarded(async () => {
			this.currentPageUrl = info.url
			this.currentPageTitle = info.title ?? null
			if (this.hasCreatedFile) {
				this.fileIndex += 1
			}
			this.needsNewFile = true
			await this.closeCurrentStream()
		})
	}

	close(): Promise<void> {
		if (this.closed) {
			return this.writePromise
		}
		this.closed = true
		this.enqueue(async () => {
			await this.closeCurrentStream()
		})
		return this.writePromise
	}

	private async ensureStream(): Promise<void> {
		if (this.currentStream && !this.needsNewFile) {
			return
		}

		await fsPromises.mkdir(this.logsDir, { recursive: true })
		const filePath = path.join(this.logsDir, this.buildFilename())
		const stream = fs.createWriteStream(filePath, { flags: 'a' })
		stream.on('error', (error) => this.handleError(error))

		this.currentStream = stream
		this.needsNewFile = false
		this.hasCreatedFile = true

		const header = renderHeader({
			watcherId: this.watcherId,
			startedAt: this.startedAt,
			chrome: this.chrome,
			match: this.match,
			pageUrl: this.currentPageUrl,
			pageTitle: this.currentPageTitle,
		})
		await this.writeToStream(header)
	}

	private buildFilename(): string {
		return `watcher-${this.watcherId}-${this.startedAtIso}-${this.fileIndex}.log`
	}

	private async closeCurrentStream(): Promise<void> {
		if (!this.currentStream) {
			return
		}
		const stream = this.currentStream
		this.currentStream = null
		await new Promise<void>((resolve) => {
			stream.end(() => resolve())
		})
	}

	private async writeToStream(contents: string): Promise<void> {
		if (!this.currentStream) {
			return
		}
		await new Promise<void>((resolve, reject) => {
			this.currentStream?.write(contents, (error) => {
				if (error) {
					reject(error)
					return
				}
				resolve()
			})
		})
	}

	private enqueue(task: () => Promise<void>): void {
		this.writePromise = this.writePromise.then(task).catch((error) => this.handleError(error))
	}

	private enqueueGuarded(task: () => Promise<void>): void {
		this.enqueue(async () => {
			if (this.failed) {
				return
			}
			await task()
		})
	}

	private handleError(_error: unknown): void {
		this.failed = true
		if (this.currentStream) {
			this.currentStream.destroy()
			this.currentStream = null
		}
	}
}

type HeaderContext = {
	watcherId: string
	startedAt: number
	chrome: WatcherChrome
	match?: WatcherMatch
	pageUrl: string | null
	pageTitle: string | null
}

const renderHeader = (context: HeaderContext): string => {
	const matchText = context.match ? safeStringify(context.match) : '(none)'
	const pageUrl = context.pageUrl ?? '(unknown)'
	const pageTitle = context.pageTitle ?? '(unknown)'
	return [
		'---',
		`watcherId: ${context.watcherId}`,
		`startedAt: ${new Date(context.startedAt).toISOString()}`,
		`chrome: ${context.chrome.host}:${context.chrome.port}`,
		`match: ${matchText}`,
		`pageUrl: ${pageUrl}`,
		`pageTitle: ${pageTitle}`,
		'---',
		'',
	].join('\n')
}

const formatLogLine = (event: Omit<LogEvent, 'id'>, previousPageUrl: string | null): string => {
	const timestamp = new Date(event.ts).toISOString()
	let line = `${timestamp} [${event.level}] ${event.text}`
	const location = formatLocation(event)
	if (location) {
		line += ` at ${location}`
	}
	if (event.pageUrl && event.pageUrl !== previousPageUrl) {
		line += ` page=${event.pageUrl}`
	}
	return `${line}\n`
}

const formatLocation = (event: Omit<LogEvent, 'id'>): string | null => {
	if (!event.file) {
		return null
	}
	let location = event.file
	if (event.line != null) {
		location += `:${event.line}`
		if (event.column != null) {
			location += `:${event.column}`
		}
	}
	return location
}

const toSafeTimestamp = (ts: number): string => new Date(ts).toISOString().replace(/:/g, '-')

const safeStringify = (value: unknown): string => {
	try {
		return JSON.stringify(value)
	} catch {
		return String(value)
	}
}
