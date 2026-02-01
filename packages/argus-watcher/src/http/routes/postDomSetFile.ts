import type { DomSetFileRequest, DomSetFileResponse } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { emitRequest } from './types.js'
import { setFileInputFiles } from '../../cdp/dom.js'
import { respondJson, respondInvalidBody, respondError, readJsonBody } from '../httpUtils.js'

export const handle: RouteHandler = async (req, res, _url, ctx) => {
	const payload = await readJsonBody<DomSetFileRequest>(req, res)
	if (!payload) {
		return
	}

	if (!payload.selector || typeof payload.selector !== 'string') {
		return respondInvalidBody(res, 'selector is required')
	}

	if (!Array.isArray(payload.files) || payload.files.length === 0) {
		return respondInvalidBody(res, 'files array is required and must not be empty')
	}

	const all = payload.all ?? false
	if (typeof all !== 'boolean') {
		return respondInvalidBody(res, 'all must be a boolean')
	}

	emitRequest(ctx, res, 'dom/set-file')

	try {
		const { allNodeIds, updatedCount } = await setFileInputFiles(ctx.cdpSession, {
			selector: payload.selector,
			files: payload.files,
			all,
			text: payload.text,
		})

		if (!all && allNodeIds.length > 1) {
			return respondJson(
				res,
				{
					ok: false,
					error: {
						message: `Selector matched ${allNodeIds.length} elements; pass all=true to set files on all matches`,
						code: 'multiple_matches',
					},
				},
				400,
			)
		}

		const response: DomSetFileResponse = { ok: true, matches: allNodeIds.length, updated: updatedCount }
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}
