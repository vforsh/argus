import { codedError } from '../errors.js'
import type { NetRequestBodyPart, NetworkRequestDetail } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import { formatError } from '@vforsh/argus-core'

export type ReadNetworkBodyResult = {
	body: string
	base64Encoded: boolean
	mimeType: string | null
}

/**
 * Read one captured network body lazily from CDP.
 * The buffer keeps only availability metadata so large payloads do not accumulate in memory.
 */
export const readNetworkBody = async (options: {
	session: CdpSessionHandle
	request: Pick<NetworkRequestDetail, 'requestId' | 'mimeType' | 'requestHeaders'>
	sessionId?: string | null
	part: NetRequestBodyPart
}): Promise<ReadNetworkBodyResult> => {
	const commandOptions = options.sessionId ? { timeoutMs: 5_000, sessionId: options.sessionId } : { timeoutMs: 5_000 }

	if (options.part === 'request') {
		const result = await options.session.sendAndWait('Network.getRequestPostData', { requestId: options.request.requestId }, commandOptions)

		if (typeof result.postData !== 'string') {
			throw codedError('body_not_available', 'Request body not available for this request')
		}

		return {
			body: result.postData,
			base64Encoded: false,
			mimeType: pickRequestMimeType(options.request.requestHeaders),
		}
	}

	const result = await options.session.sendAndWait('Network.getResponseBody', { requestId: options.request.requestId }, commandOptions)

	if (typeof result.body !== 'string') {
		throw codedError('body_not_available', 'Response body not available for this request')
	}

	return {
		body: result.body,
		base64Encoded: result.base64Encoded === true,
		mimeType: options.request.mimeType ?? null,
	}
}

export const normalizeNetBodyError = (error: unknown, part: NetRequestBodyPart): Error => {
	const message = unwrapNetBodyErrorMessage(formatError(error))
	if (isMissingNetBodyError(message)) {
		return codedError('body_not_available', `${capitalizePart(part)} body not available for this request`)
	}

	return error instanceof Error ? error : new Error(message)
}

const pickRequestMimeType = (headers: Record<string, string> | undefined): string | null => {
	if (!headers) {
		return null
	}

	for (const [name, value] of Object.entries(headers)) {
		if (name.toLowerCase() !== 'content-type') {
			continue
		}
		const trimmed = value.trim()
		return trimmed || null
	}

	return null
}

const isMissingNetBodyError = (message: string): boolean =>
	/no post data available/i.test(message) ||
	/no data found for resource/i.test(message) ||
	/no resource .* found/i.test(message) ||
	/no resource with given id(?:entifier)? .* found/i.test(message)

const unwrapNetBodyErrorMessage = (message: string): string => {
	if (!message.startsWith('{')) {
		return message
	}

	try {
		const parsed = JSON.parse(message) as { message?: unknown }
		return typeof parsed.message === 'string' ? parsed.message : message
	} catch {
		return message
	}
}

const capitalizePart = (part: NetRequestBodyPart): string => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`
