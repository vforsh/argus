# @vforsh/argus-plugin-api

Stable TypeScript contract for Argus CLI plugins.

```ts
import type { ArgusPluginV1 } from '@vforsh/argus-plugin-api'
import { ARGUS_PLUGIN_API_VERSION } from '@vforsh/argus-plugin-api'

const plugin: ArgusPluginV1 = {
	apiVersion: ARGUS_PLUGIN_API_VERSION,
	name: 'my-plugin',
	register({ program }) {
		program.command('mycmd').action(() => {})
	},
}

export default plugin
```

Import plugin types from `@vforsh/argus-plugin-api`.
