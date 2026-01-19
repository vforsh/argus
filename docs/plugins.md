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

Add to `.argus/config.json`:

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
	config?: Record<string, unknown> // Plugin config from argus.config.json
	cwd: string // Current working directory
	configDir: string // Directory containing argus config
	argusConfig: ArgusConfig // Full argus configuration
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
