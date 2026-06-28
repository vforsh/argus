import { createHash } from 'node:crypto'

/**
 * Stable Chrome extension ID for the Argus CDP Bridge.
 *
 * The extension's `manifest.json` pins a public `key`, so Chrome derives this
 * exact ID on every machine and install path (instead of a path-dependent id).
 * Because the ID is constant, `argus extension setup`/`install` need no ID
 * argument and the native messaging host manifest never has to be rewritten.
 *
 * Source of truth: `packages/argus-extension/key.pem` (gitignored). Regenerate
 * both values with `bun run --cwd packages/argus-extension generate-key`, which
 * updates the manifest `key` and prints the matching id. The drift guard in
 * `packages/argus/test/extension-id.test.ts` keeps these three in sync.
 */
export const ARGUS_EXTENSION_ID = 'ibhecpfiodfmkpflcnnkkgnjifheefhb'

/** Base64 SPKI public key pinned as the extension manifest `key` field. */
export const ARGUS_EXTENSION_PUBLIC_KEY =
	'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAt1lmJWE8y/3by5FlIta/a35cckp3mOVkFSmn8imDO+6S4xsD7naFwonrRMlMMd6lljOBG+sa5YgiMEeR1XwwyZlSDqXIOaNdizChK8wjtjhYldRmax9NQCbhejFWRyIDsR+B7xmbRsroCnSG667JR6D3q8L5v2Qbd/4rH+zZniqUdZKOPJEyjOBEbWoytX3nTWbJvCy+AHznAtnkIWysQyibUkMIBxDGNBSpx507Cc6kMrWZpnCSkjKtRj7qLpMEat4xQdkOhh3mZCisSimQoMD2Axhnqmyacj8IoKDQX+xkb6qLArO7nWr6QD4rOVWrTdgSBg+4TfW3C2zDCP5UhwIDAQAB'

/**
 * Derive a Chrome extension ID from a base64 SPKI public key, matching Chrome's
 * algorithm: SHA-256 of the DER public key, first 16 bytes, each hex nibble
 * mapped 0-f -> a-p.
 *
 * @param publicKeyBase64 - Base64-encoded DER (SPKI) public key, i.e. the value
 *   of the manifest `key` field.
 * @returns The 32-character extension ID.
 */
export const deriveExtensionId = (publicKeyBase64: string): string => {
	const der = Buffer.from(publicKeyBase64, 'base64')
	const hash = createHash('sha256').update(der).digest()
	const hex = hash.subarray(0, 16).toString('hex')
	let id = ''
	for (const char of hex) {
		id += String.fromCharCode(parseInt(char, 16) + 'a'.charCodeAt(0))
	}
	return id
}
