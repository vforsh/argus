/**
 * Cross-frame eval: the CLI can only talk to the top-level page, so an `--iframe` expression is
 * wrapped in a postMessage round-trip that the iframe's Argus helper script answers.
 */

/** Configuration for wrapping an expression for iframe eval via postMessage. */
export type IframeWrapConfig = {
	selector: string
	namespace: string
	timeoutMs: number
}

/**
 * Wrap an expression to eval it in an iframe via postMessage.
 * The iframe must have the argus helper script loaded.
 */
export const wrapForIframeEval = (code: string, config: IframeWrapConfig): string => {
	const { selector, namespace, timeoutMs } = config
	const evalType = `${namespace}:eval`
	const resultType = `${namespace}:eval-result`

	// Escape the code for embedding in a string
	const escapedCode = JSON.stringify(code)

	return `(async () => {
  const iframe = document.querySelector(${JSON.stringify(selector)});
  if (!iframe) throw new Error('Iframe not found: ${selector.replace(/'/g, "\\'")}');
  if (!iframe.contentWindow) throw new Error('Iframe has no contentWindow');
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Iframe eval timeout after ${timeoutMs}ms'));
    }, ${timeoutMs});
    const handler = (e) => {
      if (e.data?.type !== '${resultType}' || e.data.id !== id) return;
      clearTimeout(timeout);
      window.removeEventListener('message', handler);
      if (e.data.ok) resolve(e.data.result);
      else reject(new Error(e.data.error));
    };
    window.addEventListener('message', handler);
    iframe.contentWindow.postMessage({ type: '${evalType}', id, code: ${escapedCode} }, '*');
  });
})()`
}
