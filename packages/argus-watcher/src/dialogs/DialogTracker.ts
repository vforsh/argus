import type { DialogStatus } from '@vforsh/argus-core'

/**
 * Keeps the watcher’s current JavaScript dialog state in one place.
 * Chrome only allows one active dialog per page, so a single-slot tracker is enough.
 */
export class DialogTracker {
	private activeDialog: DialogStatus | null = null

	open(dialog: DialogStatus): void {
		this.activeDialog = { ...dialog }
	}

	close(): DialogStatus | null {
		const current = this.activeDialog
		this.activeDialog = null
		return current ? { ...current } : null
	}

	clear(): void {
		this.activeDialog = null
	}

	getActive(): DialogStatus | null {
		return this.activeDialog ? { ...this.activeDialog } : null
	}
}
