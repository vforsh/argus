import path from 'node:path'

/** Repo root, resolved from this file so suites run from any e2e subfolder and any cwd. */
export const REPO_ROOT = path.resolve(import.meta.dir, '..', '..')

/** Built, unbundled CLI entry: what most suites exercise. */
export const BIN_PATH = path.join(REPO_ROOT, 'packages', 'argus', 'dist', 'bin.js')

/** Bundled CLI entry with lazy `dist/chunks/`, as published. */
export const BUNDLE_PATH = path.join(REPO_ROOT, 'packages', 'argus', 'dist', 'argus.js')

/** CLI source entry, runnable directly under Bun. */
export const SOURCE_BIN_PATH = path.join(REPO_ROOT, 'packages', 'argus', 'src', 'bin.ts')

/** Starts a watcher through the SDK from a JSON config argument and prints `{"id","host","port"}`. */
export const FIXTURE_WATCHER_PATH = path.join(REPO_ROOT, 'e2e', 'fixtures', 'start-watcher.ts')
