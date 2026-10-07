import { chmodSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outdir = path.join(root, 'packages/argus/dist')
// tsc output stays available for SDK exports and integration tests. Only generated chunks are removed.
rmSync(path.join(outdir, 'chunks'), { recursive: true, force: true })
await build({
	entryPoints: { argus: path.join(outdir, 'bin.js') },
	outdir,
	bundle: true,
	splitting: true,
	format: 'esm',
	platform: 'node',
	target: 'node20.19',
	external: ['esbuild', 'oxfmt'],
	chunkNames: 'chunks/[name]-[hash]',
	banner: { js: "import { createRequire as __argusCreateRequire } from 'node:module'; const require = __argusCreateRequire(import.meta.url);" },
})
chmodSync(path.join(outdir, 'argus.js'), 0o755)
