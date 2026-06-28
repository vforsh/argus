import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Generate (once) the RSA keypair that pins the Argus extension's Chrome ID.
 *
 * Chrome derives an unpacked extension's ID from its `key` field (the base64
 * SPKI public key) when present, otherwise from the install path. Pinning the
 * key here makes the ID identical on every machine and path, so the CLI can
 * hardcode it and `argus extension setup` needs no ID argument.
 *
 * - Writes `key.pem` (private key, PKCS8 PEM) once; gitignored. Back it up if
 *   you later want to sign a CRX — the public key/ID derive from it.
 * - Updates `manifest.json` `key` in place.
 * - Prints `{ publicKey, extensionId }` so the CLI constant can be updated.
 *
 * Idempotent: re-running with an existing key.pem re-derives the same values.
 */

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const packageDir = path.resolve(scriptDir, '..')
const keyPath = path.join(packageDir, 'key.pem')
const manifestPath = path.join(packageDir, 'manifest.json')

const privateKeyPem = readOrCreatePrivateKey(keyPath)
const publicKey = derivePublicKeyBase64(privateKeyPem)
const extensionId = deriveExtensionId(publicKey)

updateManifestKey(manifestPath, publicKey)

console.log(JSON.stringify({ publicKey, extensionId }, null, 2))

function readOrCreatePrivateKey(targetPath) {
	if (existsSync(targetPath)) {
		return readFileSync(targetPath, 'utf8')
	}
	const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
	const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
	writeFileSync(targetPath, pem, { mode: 0o600 })
	return pem
}

function derivePublicKeyBase64(privateKeyPem) {
	const publicKey = createPublicKey(privateKeyPem)
	return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

function deriveExtensionId(publicKeyBase64) {
	const der = Buffer.from(publicKeyBase64, 'base64')
	const hash = createHash('sha256').update(der).digest()
	const hex = hash.subarray(0, 16).toString('hex')
	let id = ''
	for (const ch of hex) {
		id += String.fromCharCode(parseInt(ch, 16) + 'a'.charCodeAt(0))
	}
	return id
}

function updateManifestKey(targetPath, publicKeyBase64) {
	const manifest = JSON.parse(readFileSync(targetPath, 'utf8'))
	manifest.key = publicKeyBase64
	writeFileSync(targetPath, JSON.stringify(manifest, null, '\t') + '\n')
}
