/** Fixed-capacity ordered storage. Logical indexes run from oldest to newest. */
export class CircularBuffer<T> {
	private values: T[] = []
	private head = 0
	private count = 0
	private readonly capacity: number

	/** Nonpositive capacities retain nothing; fractional capacities round up, like array slicing. */
	constructor(capacity: number) {
		this.capacity = Number.isNaN(capacity) ? Infinity : Math.max(0, Math.ceil(capacity))
	}

	get length(): number {
		return this.count
	}

	/** Return a retained item by logical index, or undefined outside the retained range. */
	at(index: number): T | undefined {
		if (!Number.isInteger(index) || index < 0 || index >= this.count) return undefined
		return this.values[(this.head + index) % this.capacity]
	}

	/** Append in constant time, returning the evicted item (or the input when capacity is zero). */
	push(value: T): T | undefined {
		if (this.capacity === 0) return value
		if (this.count < this.capacity) {
			this.values[(this.head + this.count++) % this.capacity] = value
			return undefined
		}
		const evicted = this.values[this.head]
		this.values[this.head] = value
		this.head = (this.head + 1) % this.capacity
		return evicted
	}

	/** Release all retained references; return the number removed. */
	clear(): number {
		const removed = this.count
		this.values = []
		this.head = 0
		this.count = 0
		return removed
	}
}
