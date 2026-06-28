import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Bundle the built Argus extension into the CLI package's `dist/extension` so
 * `argus extension path` can point users at a ready-to-load unpacked folder —
 * no separate build step on the consumer side.
 *
 * Best-effort rebuilds the extension first (esbuild), then validates and copies
 * the loadable artifacts. If the rebuild fails but a prior build exists, the
 * existing artifacts are used; if no built service worker is found, this errors
 * rather than shipping a broken extension.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const extensionDir = path.join(repoRoot, 'packages', 'argus-extension')
const targetDir = path.join(repoRoot, 'packages', 'argus', 'dist', 'extension')
const releaseFiles = ['manifest.json', 'icons', 'dist', 'src/popup/popup.html']

buildExtension()

const serviceWorker = path.join(extensionDir, 'dist', 'background', 'service-worker.js')
if (!existsSync(serviceWorker)) {
	console.error(
		`Cannot package extension: missing ${path.relative(repoRoot, serviceWorker)}. Run \`bun run --cwd packages/argus-extension build\` first.`,
	)
	process.exitCode = 1
} else {
	copyExtension()
}

function buildExtension() {
	const result = spawnSync('bun', ['run', 'build'], { cwd: extensionDir, stdio: 'inherit' })
	if (result.status !== 0) {
		console.warn('Extension build did not succeed; falling back to existing dist if present.')
	}
}

function copyExtension() {
	rmSync(targetDir, { recursive: true, force: true })
	mkdirSync(targetDir, { recursive: true })

	for (const relativePath of releaseFiles) {
		const sourcePath = path.join(extensionDir, relativePath)
		if (!existsSync(sourcePath)) {
			console.error(`Cannot package extension: missing ${path.relative(repoRoot, sourcePath)}.`)
			process.exitCode = 1
			return
		}
		const destinationPath = path.join(targetDir, relativePath)
		mkdirSync(path.dirname(destinationPath), { recursive: true })
		cpSync(sourcePath, destinationPath, { recursive: true })
	}

	// Drop nested release archives so we don't ship a zip inside the package.
	rmSync(path.join(targetDir, 'dist', 'release'), { recursive: true, force: true })
}
