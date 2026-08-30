/**
 * Coerce an attach/detach payload to the target id the source handle expects.
 *
 * Both requests accept either an explicit `targetId` or a numeric `tabId`; the source handle takes
 * one string either way.
 */
export const resolveExtensionTargetId = (payload: { targetId?: string; tabId?: number }): string => payload.targetId ?? String(payload.tabId)
