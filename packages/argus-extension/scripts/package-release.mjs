import { mkdtempSync, mkdirSync, cpSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, '..')
const outputPath = resolveOutputPath(process.argv[2])

const requiredPaths = ['manifest.json', 'icons', 'dist', 'src/popup/popup.html']
for (const relativePath of requiredPaths) {
	const absolutePath = path.join(packageDir, relativePath)
	if (!existsSync(absolutePath)) {
		throw new Error(`Missing required extension artifact: ${relativePath}. Run npm run build first.`)
	}
}

const stagingRoot = mkdtempSync(path.join(os.tmpdir(), 'argus-extension-release-'))
const archiveRoot = path.join(stagingRoot, 'extension')

try {
	copyReleaseFiles(archiveRoot)
	createZipArchive(archiveRoot, outputPath)
	console.log(`Created ${outputPath}`)
} finally {
	rmSync(stagingRoot, { recursive: true, force: true })
}

function resolveOutputPath(outputArg) {
	if (!outputArg) {
		return path.join(packageDir, 'dist', 'release', 'argus-extension.zip')
	}

	return path.resolve(process.cwd(), outputArg)
}

function copyReleaseFiles(archiveRoot) {
	const releaseFiles = ['manifest.json', 'icons', 'dist', 'src/popup/popup.html']

	for (const relativePath of releaseFiles) {
		const sourcePath = path.join(packageDir, relativePath)
		const destinationPath = path.join(archiveRoot, relativePath)
		mkdirSync(path.dirname(destinationPath), { recursive: true })
		cpSync(sourcePath, destinationPath, { recursive: true })
	}
}

function createZipArchive(archiveRoot, archivePath) {
	mkdirSync(path.dirname(archivePath), { recursive: true })
	rmSync(archivePath, { force: true })

	const result = spawnSync('zip', ['-qr', archivePath, '.'], {
		cwd: archiveRoot,
		stdio: 'inherit',
	})

	if (result.error) {
		throw result.error
	}

	if (result.status !== 0) {
		throw new Error(`zip exited with status ${result.status ?? 'unknown'}`)
	}
}
