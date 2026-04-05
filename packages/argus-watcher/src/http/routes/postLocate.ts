import type { LocateLabelRequest, LocateResponse, LocateRoleRequest, LocateTextRequest } from '@vforsh/argus-core'
import type { RouteHandler } from './types.js'
import { respondMultipleMatches } from './domSelectorRoute.js'
import { emitRequest } from './types.js'
import { locateByLabel, locateByRole, locateByText } from '../../cdp/locate.js'
import { respondError, respondInvalidBody, respondJson, readJsonBody } from '../httpUtils.js'

type LocatePayload = {
	all?: unknown
	exact?: unknown
	role?: unknown
	text?: unknown
	label?: unknown
}

type LocateHandlerConfig<TPayload extends LocatePayload> = {
	endpoint: 'locate/role' | 'locate/text' | 'locate/label'
	requiredField: 'role' | 'text' | 'label'
	run: (ctx: Parameters<RouteHandler>[3], payload: TPayload) => Promise<LocateResponse>
}

function createLocateHandler<TPayload extends LocatePayload>(config: LocateHandlerConfig<TPayload>): RouteHandler {
	return async (req, res, _url, ctx) => {
		const payload = await readJsonBody<TPayload>(req, res)
		if (!payload) {
			return
		}
		if (!validateRequiredString(res, payload[config.requiredField], config.requiredField)) {
			return
		}
		if (!validateLocateOptions(res, payload)) {
			return
		}

		emitRequest(ctx, res, config.endpoint)
		const allowMultiple = payload.all === true
		await handleLocateRequest(res, allowMultiple, () => config.run(ctx, payload))
	}
}

export const handleLocateRole = createLocateHandler<LocateRoleRequest>({
	endpoint: 'locate/role',
	requiredField: 'role',
	run: (ctx, payload) => locateByRole(ctx.cdpSession, ctx.elementRefs, payload),
})

export const handleLocateText = createLocateHandler<LocateTextRequest>({
	endpoint: 'locate/text',
	requiredField: 'text',
	run: (ctx, payload) => locateByText(ctx.cdpSession, ctx.elementRefs, payload),
})

export const handleLocateLabel = createLocateHandler<LocateLabelRequest>({
	endpoint: 'locate/label',
	requiredField: 'label',
	run: (ctx, payload) => locateByLabel(ctx.cdpSession, ctx.elementRefs, payload),
})

const handleLocateRequest = async (res: Parameters<RouteHandler>[1], all: boolean, run: () => Promise<LocateResponse>): Promise<void> => {
	try {
		const response = await run()
		if (!all && response.matches > 1) {
			return respondMultipleMatches(res, response.matches, 'return')
		}
		respondJson(res, response)
	} catch (error) {
		respondError(res, error)
	}
}

const validateLocateOptions = (res: Parameters<RouteHandler>[1], payload: { all?: unknown; exact?: unknown }): boolean => {
	if (payload.all != null && typeof payload.all !== 'boolean') {
		respondInvalidBody(res, 'all must be a boolean')
		return false
	}
	if (payload.exact != null && typeof payload.exact !== 'boolean') {
		respondInvalidBody(res, 'exact must be a boolean')
		return false
	}
	return true
}

const validateRequiredString = (res: Parameters<RouteHandler>[1], value: unknown, label: string): boolean => {
	if (typeof value === 'string' && value.trim() !== '') {
		return true
	}

	respondInvalidBody(res, `${label} is required`)
	return false
}
