# @vforsh/argus

CLI package for Argus.

The canonical user documentation lives in the repo root README:

- [../../README.md](../../README.md)

Use this package when you want the `argus` binary from npm:

```bash
npm install -g @vforsh/argus
argus --help
```

For local development in this repo:

```bash
bun install
npm run build:packages
bun packages/argus/src/bin.ts --help
```
