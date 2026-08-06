import { formatA1Cell, parseA1Cell } from './a1.js'

/** Structural mutation coordinates used to plan deterministic shift checks. */
export type StructuralMutationCoordinates = {
	action: 'add' | 'remove'
	dimension: 'rows' | 'columns'
	index: number
	count: number
	side?: 'before' | 'after'
}

/** One pre-mutation source cell and its expected post-mutation destination. */
export type StructuralProbe = { role: 'anchor' | 'following'; sourceA1: string; destinationA1: string | null }

/** Plan anchor and following-cell checks around one row/column mutation. */
export const planStructuralProbes = (input: StructuralMutationCoordinates, anchorA1: string): StructuralProbe[] => {
	const anchor = parseA1Cell(anchorA1)
	if (!anchor || anchor.sheet) throw new Error(`Structural expectation must use an unqualified A1 cell, got ${anchorA1}.`)
	const axis = input.dimension === 'rows' ? anchor.row + 1 : anchor.column + 1
	const start = input.action === 'add' && input.side === 'after' ? input.index + 1 : input.index
	const end = input.action === 'remove' ? input.index + input.count - 1 : start - 1
	const anchorDestination = shiftedAxis(input, axis, start, end)
	const followingAxis = input.action === 'add' ? start : end + 1
	const followingDestination = input.action === 'add' ? followingAxis + input.count : input.index
	const probes: StructuralProbe[] = [
		{
			role: 'anchor',
			sourceA1: anchorA1.toUpperCase(),
			destinationA1: anchorDestination == null ? null : withAxis(anchor, input.dimension, anchorDestination),
		},
		{
			role: 'following',
			sourceA1: withAxis(anchor, input.dimension, followingAxis),
			destinationA1: withAxis(anchor, input.dimension, followingDestination),
		},
	]
	return probes.filter(
		(probe, index) =>
			probes.findIndex((candidate) => candidate.sourceA1 === probe.sourceA1 && candidate.destinationA1 === probe.destinationA1) === index,
	)
}

const shiftedAxis = (input: StructuralMutationCoordinates, axis: number, start: number, end: number): number | null => {
	if (input.action === 'add') return axis >= start ? axis + input.count : axis
	if (axis >= input.index && axis <= end) return null
	return axis > end ? axis - input.count : axis
}

const withAxis = (anchor: NonNullable<ReturnType<typeof parseA1Cell>>, dimension: 'rows' | 'columns', axis: number): string =>
	dimension === 'rows' ? formatA1Cell(anchor.column, axis - 1) : formatA1Cell(axis - 1, anchor.row)
