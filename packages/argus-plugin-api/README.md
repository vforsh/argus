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

`@vforsh/argus/plugin` remains available as a compatibility re-export, but new plugins should target this package directly.
