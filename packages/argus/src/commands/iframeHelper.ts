import * as fs from 'node:fs/promises'

/** Options for the iframe-helper command. */
export type IframeHelperOptions = {
	out?: string
	log?: boolean
	iife?: boolean
	namespace?: string
}

/**
 * Execute the iframe-helper command.
 * Outputs a helper script for cross-origin iframe eval via postMessage.
 */
export const runIframeHelper = async (options: IframeHelperOptions): Promise<void> => {
	const script = generateIframeHelperScript({
		log: options.log ?? true,
		iife: options.iife ?? false,
		namespace: options.namespace ?? 'argus',
	})

	if (options.out) {
		await fs.writeFile(options.out, script, 'utf-8')
		console.error(`Written to ${options.out}`)
	} else {
		process.stdout.write(script)
	}
}

type GenerateConfig = {
	log: boolean
	iife: boolean
	namespace: string
}

const generateIframeHelperScript = (config: GenerateConfig): string => {
	const { log, iife, namespace } = config

	const logLine = log ? `console.log('[Argus] iframe helper loaded');\n` : ''
	const evalType = `${namespace}:eval`
	const resultType = `${namespace}:eval-result`

	const header = `/**
 * Argus iframe helper script.
 *
 * Include this script in a cross-origin iframe to enable eval via postMessage.
 * The parent page can then execute JavaScript in this iframe's context.
 *
 * Usage from parent:
 *   const id = crypto.randomUUID();
 *   iframe.contentWindow.postMessage({ type: '${evalType}', id, code: 'document.title' }, '*');
 *
 *   window.addEventListener('message', (e) => {
 *     if (e.data?.type === '${resultType}' && e.data.id === id) {
 *       if (e.data.ok) console.log('Result:', e.data.result);
 *       else console.error('Error:', e.data.error);
 *     }
 *   });
 *
 * Message format:
 *   Request:  { type: '${evalType}', id: string, code: string }
 *   Response: { type: '${resultType}', id: string, ok: boolean, result?: any, error?: string }
 */
`

	let script = `${header}window.addEventListener('message', async (event) => {
  if (event.data?.type !== '${evalType}') return;
  const { id, code } = event.data;
  try {
    const result = await eval(code);
    parent.postMessage({ type: '${resultType}', id, ok: true, result }, '*');
  } catch (err) {
    parent.postMessage({ type: '${resultType}', id, ok: false, error: String(err) }, '*');
  }
});
${logLine}`

	if (iife) {
		script = `(function() {\n${script}})();\n`
	}

	return script
}
