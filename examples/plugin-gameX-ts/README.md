# GameX TypeScript Plugin Example

This example demonstrates how to create a type-safe Argus plugin using TypeScript.

## Structure

```
src/
└── gameX.ts              # TypeScript plugin source
.argus/
├── config.json           # Plugin configuration
└── plugins/
    └── gameX.js          # Compiled JavaScript (generated)
tsconfig.json             # TypeScript configuration
```

## Setup

1. Install dependencies (if not already installed):

```bash
npm install
```

2. Compile TypeScript:

```bash
npx tsc
```

This will compile `src/gameX.ts` to `.argus/plugins/gameX.js`.

## Usage

After compilation, run:

```bash
# See available commands
argus --help

# Run gameX commands
argus gameX jump --height 200
argus gameX shoot --target enemy1
```

## Development Workflow

1. Edit `src/gameX.ts`
2. Run `npx tsc` to compile
3. Test with `argus gameX <command>`

For continuous compilation during development:

```bash
npx tsc --watch
```

## Key Differences from JavaScript

1. **Type Safety**: Options are typed with interfaces
2. **IDE Support**: Full autocomplete and type checking
3. **Compilation Step**: TypeScript must be compiled to JavaScript before use
