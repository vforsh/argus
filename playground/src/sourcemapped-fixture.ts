// Original source behind /sourcemapped-app.js. The bundle is served with a cache-busting query and
// points at a hashed map under /maps/, so Argus can only find it by reading the bundle's own
// `//# sourceMappingURL=` annotation.
export const sourcemappedFixture = {
	log(): void {
		console.log('sourcemapped fixture log')
	},
	boom(): void {
		throw new Error('sourcemapped fixture error')
	},
}
