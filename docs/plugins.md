# Argus Plugin System

Extend Argus CLI with custom commands using plugins.

## Quick Start

### 1. Create a plugin file

Create `.argus/plugins/myCommands.js`:

```javascript
import { Command } from 'commander'

const myCommands = new Command('myapp').description('My app commands')

myCommands
	.command('deploy')
	.option('--env <name>', 'Environment')
	.action(async (options) => {
		console.log(`Deploying to: ${options.env}`)
	})

export default {
	command: myCommands,
}
```

### 2. Register in config

Add to your Argus config file (for example, `.argus/config.json`):

```json
{
	"plugins": ["./plugins/myCommands.js"]
}
```

### 3. Use it

```bash
argus myapp deploy --env production
```

## Plugin API

### Basic Structure

```typescript
import { Command } from 'commander'
import type { ArgusPlugin } from '@vforsh/argus-core'

const plugin: ArgusPlugin = {
	// Required: Commander.js Command instance
	command: new Command('name'),

	// Optional: Setup hook
	setup: async (context) => {
		// Initialize, validate, etc.
	},

	// Optional: Cleanup hook
	teardown: async () => {
		// Cleanup resources
	},
}

export default plugin
```

### Plugin Context

The `setup` hook receives a context object:

```typescript
interface PluginContext {
	config?: Record<string, unknown> // Plugin config from argus config
	cwd: string // Current working directory
	configDir: string // Directory containing argus config
	argusConfig: ArgusConfig // Full argus configuration
	argus: PluginArgusApi // API for interacting with watchers
}
```

## Configuration

### String Format (Simple)

```json
{
	"plugins": ["./plugins/gameX.js", "npm-plugin-package"]
}
```

### Object Format (Advanced)

```json
{
	"plugins": [
		{
			"name": "gameX",
			"module": "./plugins/gameX.js",
			"enabled": true,
			"config": {
				"gameUrl": "http://localhost:3000",
				"apiKey": "..."
			}
		}
	]
}
```

## Executing JavaScript in the Page

Plugins can evaluate JavaScript in the watched page using `context.argus.eval()`. This uses the same eval mechanism as the `argus eval` CLI command.

### Basic Usage

```javascript
import { Command } from 'commander'

const plugin = new Command('myplugin')

plugin.command('get-title').action(async () => {
	const result = await context.argus.eval({ expression: 'document.title' })
	console.log('Page title:', result.result)
})

export default { command: plugin }
```

### With Options

```javascript
const result = await context.argus.eval({
	expression: 'fetch("/api/data").then(r => r.json())',
	watcherId: 'my-watcher', // Optional: specific watcher id
	timeoutMs: 10000, // Optional: timeout in ms
	retryCount: 3, // Optional: retry on transport failure
	awaitPromise: true, // Default: true
	returnByValue: true, // Default: true
	failOnException: false, // Default: true - set false to get exception in result
})

if (result.exception) {
	console.error('Error:', result.exception.text)
} else {
	console.log('Result:', result.result)
}
```

### Handling Errors

The `eval()` method throws `ArgusPluginApiError` on failure, which includes error codes and candidate watchers:

```javascript
import { ArgusPluginApiError } from '@vforsh/argus'

try {
	const result = await context.argus.eval({ expression: '1 + 1' })
} catch (error) {
	if (error instanceof ArgusPluginApiError) {
		switch (error.code) {
			case 'expression_required':
				console.error('Expression is required')
				break
			case 'watcher_required':
				console.error('Multiple watchers found, specify one:')
				error.candidates?.forEach((w) => console.log(`  - ${w.id}`))
				break
			case 'watcher_not_found':
				console.error('No watchers found')
				break
			case 'eval_exception':
				console.error('JS Exception:', error.exception?.text)
				break
			case 'eval_transport':
				console.error('Connection failed:', error.message)
				break
		}
	}
}
```

### Watcher Discovery

Use `context.argus.listWatchers()` to discover available watchers:

```javascript
const watchers = await context.argus.listWatchers()
for (const { watcher, reachable, error } of watchers) {
	console.log(`${watcher.id}: ${reachable ? 'online' : error}`)
}

// Filter by cwd
const projectWatchers = await context.argus.listWatchers({ byCwd: '/my/project' })
```

Use `context.argus.resolveWatcher()` to resolve a watcher using the same logic as `argus eval`:

```javascript
const result = await context.argus.resolveWatcher()
if (result.ok) {
	console.log('Selected watcher:', result.watcher.id)
} else {
	console.error(result.error)
	result.candidates?.forEach((w) => console.log(`  Candidate: ${w.id}`))
}
```

## Advanced Examples

### Subcommands

```javascript
const game = new Command('game')

const player = game.command('player').description('Player commands')

player.command('list').action(async () => {
	// argus game player list
})

export default { command: game }
```

### Accessing Argus Services

```javascript
import { loadRegistry } from '@vforsh/argus-core'

const plugin = new Command('myplugin')

plugin.command('info').action(async () => {
	const registry = await loadRegistry()
	console.log('Active watchers:', registry.watchers.length)
})

export default { command: plugin }
```

### TypeScript Plugin

Create `src/myPlugin.ts`:

```typescript
import { Command } from 'commander'
import type { ArgusPlugin, PluginContext } from '@vforsh/argus-core'

interface DeployOptions {
	env: string
}

const myPlugin = new Command('myapp').description('My app commands')

myPlugin
	.command('deploy')
	.requiredOption('--env <name>', 'Environment')
	.action(async (options: DeployOptions) => {
		console.log(`Deploying to: ${options.env}`)
	})

const plugin: ArgusPlugin = {
	command: myPlugin,
	setup: async (context: PluginContext) => {
		console.log('Plugin initialized')
	},
}

export default plugin
```

Compile with:

```bash
npx tsc
```

Then reference the compiled `.js` file in your config.

## Publishing as NPM Package

### Directory Structure

```
my-argus-plugin/
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts
└── dist/
    └── index.js
```

### package.json

```json
{
	"name": "my-argus-plugin",
	"version": "1.0.0",
	"description": "My custom Argus plugin",
	"type": "module",
	"main": "dist/index.js",
	"types": "dist/index.d.ts",
	"keywords": ["argus-plugin", "argus"],
	"scripts": {
		"build": "tsc",
		"dev": "tsc --watch"
	},
	"peerDependencies": {
		"commander": "^14.0.0",
		"@vforsh/argus-core": "^1.0.0"
	},
	"devDependencies": {
		"commander": "^14.0.2",
		"@vforsh/argus-core": "^1.0.0",
		"typescript": "^5.0.0"
	}
}
```

### Usage

Install:

```bash
npm install my-argus-plugin --save-dev
```

Configure:

```json
{
	"plugins": ["my-argus-plugin"]
}
```

## Troubleshooting

### Plugin Not Found

**Error**: `Cannot resolve plugin module: ./plugins/myPlugin.js`

**Solutions**:

- Check file path in config
- Verify file exists
- Use relative path from config directory

### Commander.js Version Mismatch

**Error**: `Plugin "command" must be a Commander.js Command instance`

**Solutions**:

- Ensure you're instantiating Command: `new Command('name')`
- Check Commander.js version matches Argus (^14.0.0)

### TypeScript Import Errors

**Error**: `Cannot find module '@vforsh/argus-core'`

**Solutions**:

- Install dependencies: `npm install`
- Ensure `@vforsh/argus-core` is in dependencies

### Duplicate Command Names

**Error**: `Duplicate plugin commands detected: myapp`

**Solutions**:

- Ensure each plugin exports a unique command name
- Check for conflicts with built-in commands

## Debug Mode

Enable verbose plugin logging:

```bash
DEBUG=argus:plugins argus mycommand
```

## Examples

See the `examples/` directory for complete working examples:

- `examples/plugin-gameX/` - JavaScript plugin
- `examples/plugin-gameX-ts/` - TypeScript plugin

## Best Practices

1. **Naming**: Use descriptive, unique command names
2. **Documentation**: Add `.description()` and `.addHelpText()` to commands
3. **Validation**: Validate options in your action handlers
4. **Error Handling**: Use try-catch and provide clear error messages
5. **Testing**: Test plugins in isolation before publishing
6. **Dependencies**: Keep dependencies minimal
7. **Versioning**: Follow semantic versioning for npm packages
