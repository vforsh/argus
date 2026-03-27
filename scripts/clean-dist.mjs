import { rm } from 'node:fs/promises'
import path from 'node:path'

const targets = process.argv.slice(2)
const distDirs = targets.length > 0 ? targets.map((target) => path.resolve(target, 'dist')) : [path.resolve('dist')]

await Promise.all(distDirs.map((distDir) => rm(distDir, { recursive: true, force: true })))
