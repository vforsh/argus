import type { LocateLabelRequest, LocatedElement, LocateResponse, LocateRoleRequest, LocateTextRequest } from '@vforsh/argus-core'
import type { CdpSessionHandle } from './connection.js'
import type { ElementRefRegistry } from './elementRefs.js'
import { listAccessibleElements, type AccessibleElementRecord } from './accessibility.js'
import { describeNodeByBackendId, resolveNodeIdByBackendId, toAttributesRecord } from './dom/selector.js'

const LABELABLE_ROLES = new Set(['button', 'checkbox', 'combobox', 'listbox', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox'])

export const locateByRole = async (
	session: CdpSessionHandle,
	elementRefs: ElementRefRegistry,
	request: LocateRoleRequest,
): Promise<LocateResponse> => {
	const matches = (await listAccessibleElements(session, elementRefs)).filter((element) => {
		if (normalizeText(element.role) !== normalizeText(request.role)) {
			return false
		}
		if (!request.name) {
			return true
		}
		return matchesText(element.name, request.name, request.exact ?? false)
	})

	return buildLocateResponse(session, request.all ?? false, matches)
}

export const locateByText = async (
	session: CdpSessionHandle,
	elementRefs: ElementRefRegistry,
	request: LocateTextRequest,
): Promise<LocateResponse> => {
	const matches = (await listAccessibleElements(session, elementRefs)).filter(
		(element) =>
			matchesText(element.name, request.text, request.exact ?? false) || matchesText(element.value ?? '', request.text, request.exact ?? false),
	)

	return buildLocateResponse(session, request.all ?? false, matches)
}

export const locateByLabel = async (
	session: CdpSessionHandle,
	elementRefs: ElementRefRegistry,
	request: LocateLabelRequest,
): Promise<LocateResponse> => {
	const matches = (await listAccessibleElements(session, elementRefs)).filter((element) => {
		if (!LABELABLE_ROLES.has(element.role)) {
			return false
		}
		return matchesText(element.name, request.label, request.exact ?? false)
	})

	return buildLocateResponse(session, request.all ?? false, await removeCompositeLabelWrappers(session, matches))
}

const NATIVE_LABELABLE_TAGS = new Set(['button', 'input', 'select', 'textarea'])

const removeCompositeLabelWrappers = async (session: CdpSessionHandle, matches: AccessibleElementRecord[]): Promise<AccessibleElementRecord[]> => {
	if (matches.length < 2) return matches

	const candidates = await Promise.all(
		matches.map(async (match) => {
			const [node, nodeId] = await Promise.all([
				describeNodeByBackendId(session, match.backendNodeId),
				resolveNodeIdByBackendId(session, match.backendNodeId),
			])
			const tag = node ? (node.localName ?? node.nodeName).toLowerCase() : ''
			return { match, nodeId, native: NATIVE_LABELABLE_TAGS.has(tag) }
		}),
	)
	const nativeCandidates = candidates.filter((candidate) => candidate.native && candidate.nodeId != null)
	if (nativeCandidates.length === 0) return matches

	const kept: AccessibleElementRecord[] = []
	for (const candidate of candidates) {
		if (candidate.native || candidate.nodeId == null) {
			kept.push(candidate.match)
			continue
		}
		const descendants = await session.sendAndWait('DOM.querySelectorAll', {
			nodeId: candidate.nodeId,
			selector: 'button,input,select,textarea',
		})
		const descendantIds = new Set(descendants.nodeIds ?? [])
		const wrapsMatchedNative = nativeCandidates.some(
			(native) =>
				native.nodeId != null &&
				descendantIds.has(native.nodeId) &&
				normalizeText(native.match.role) === normalizeText(candidate.match.role) &&
				normalizeText(native.match.name) === normalizeText(candidate.match.name),
		)
		if (!wrapsMatchedNative) kept.push(candidate.match)
	}
	return kept
}

const buildLocateResponse = async (session: CdpSessionHandle, all: boolean, matches: AccessibleElementRecord[]): Promise<LocateResponse> => {
	const selected = all ? matches : matches.slice(0, 1)
	const elements = await Promise.all(selected.map((element) => toLocatedElement(session, element)))
	return {
		ok: true,
		matches: matches.length,
		elements,
	}
}

const toLocatedElement = async (session: CdpSessionHandle, element: AccessibleElementRecord): Promise<LocatedElement> => {
	const node = await describeNodeByBackendId(session, element.backendNodeId)
	const attributes = node?.attributes ? toAttributesRecord(node.attributes) : undefined

	return {
		ref: element.ref,
		role: element.role,
		name: element.name,
		value: element.value,
		tag: node ? (node.localName ?? node.nodeName).toLowerCase() : undefined,
		attributes: attributes && Object.keys(attributes).length > 0 ? filterLocatorAttributes(attributes) : undefined,
	}
}

const filterLocatorAttributes = (attributes: Record<string, string>): Record<string, string> => {
	const filtered: Record<string, string> = {}
	for (const key of ['id', 'class', 'name', 'type', 'data-testid']) {
		if (attributes[key]) {
			filtered[key] = attributes[key]
		}
	}
	return filtered
}

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

const matchesText = (actual: string, expected: string, exact: boolean): boolean => {
	const left = normalizeText(actual)
	const right = normalizeText(expected)
	if (!left || !right) {
		return false
	}
	return exact ? left === right : left.includes(right)
}
