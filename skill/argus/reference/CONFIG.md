# Config defaults

Argus can load defaults for `argus chrome start` and `argus watcher start` from a repo-local config file.

## Discovery and precedence

- Auto-discovery order: `.argus/config.json`, `argus.config.json`, `argus/config.json`
- Use `--config <path>` to point at an explicit file (relative to `cwd` if not absolute)
- CLI flags override config values
- `watcher.start.artifacts` is resolved relative to the config file directory
- Use `argus config init` to create a starter config file

## Example

```json
{
	"$schema": "../schemas/argus.config.schema.json",
	"chrome": {
		"start": {
			"url": "http://localhost:3000",
			"devTools": true
		}
	},
	"watcher": {
		"start": {
			"id": "app",
			"url": "localhost:3000",
			"chromeHost": "127.0.0.1",
			"chromePort": 9222,
			"artifacts": "./artifacts",
			"pageIndicator": true
		}
	}
}
```
