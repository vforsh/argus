# @vforsh/argus-plugin-api

Stable TypeScript contract for Argus CLI plugins.

```ts
import type { ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import { ARGUS_PLUGIN_API_VERSION } from '@vforsh/argus-plugin-api'

const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'my-plugin',
	description: 'Short human description',
	commands: ['mycmd'],
	register({ program, host }) {
		program
			.command('title [id]')
			.option('--json')
			.action(
				host.defineWatcherCommand({
					build: () => ({ path: '/eval', method: 'POST', body: { expression: 'document.title', returnByValue: true } }),
					formatHuman: (response: { ok: true; result: unknown }, { output }) => output.writeHuman(String(response.result ?? '')),
				}),
			)
	},
}

export default plugin
```

Import plugin types from `@vforsh/argus-plugin-api`. `ctx.host` provides stable output helpers, watcher requests, `defineWatcherCommand`, and high-level `argus.eval` / `argus.dom.*` / `argus.screenshot` helpers.
