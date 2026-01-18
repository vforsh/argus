# GameX Plugin Example

This example demonstrates how to create a simple Argus plugin using JavaScript.

## Structure

```
.argus/
├── config.json           # Plugin configuration
└── plugins/
    └── gameX.js          # Plugin implementation
```

## Usage

From this directory, run:

```bash
# See available commands
argus --help

# Run gameX commands
argus gameX jump --height 200
argus gameX shoot --target enemy1
```

## Key Concepts

1. **Plugin Export**: The plugin exports a default object with a `command` property (Commander.js Command instance)
2. **Setup Hook**: Optional `setup()` function called when plugin loads
3. **Teardown Hook**: Optional `teardown()` function called on CLI exit
4. **Configuration**: Plugins are registered in `.argus/config.json`
