import { AsyncLocalStorage } from 'node:async_hooks'
import type { ArgusMutationDispatch, ArgusRequestContext } from '@vforsh/argus-plugin-api'

/** Shared only by async work originating in one session request. */
export type RequestScope = ArgusRequestContext & { mutation?: ArgusMutationDispatch }
const requests = new AsyncLocalStorage<RequestScope>()

/** Run an action with its own deadline, cancellation, and mutation receipt. */
export const withRequestContext = <T>(scope: RequestScope, action: () => Promise<T>): Promise<T> => requests.run(scope, action)

/** Current request budget; one-shot invocations have no session deadline. */
export const getRequestContext = (): ArgusRequestContext => requests.getStore() ?? {}

/** Retain mutation uncertainty even if the command outlives its caller. */
export const markMutationDispatched = (mutation: ArgusMutationDispatch): void => {
	const scope = requests.getStore()
	if (scope) scope.mutation = mutation
}
