# Runtime Code Inspection

Argus can inspect runtime JS/CSS resources exposed through CDP.

## Commands

```bash
argus code ls app
argus code ls app --pattern inline
argus code read http://127.0.0.1:3333/ --id app
argus code read inline://42 --id app --offset 20 --limit 80
argus code grep '/featureFlag/' --id app
argus code grep 'argusRuntimeProbe' --id app --url inline
```

## What It Does

- `code ls`: list runtime scripts/stylesheets discovered via CDP
- `code read`: return line-numbered source for one resource
- `code grep`: search sources with a plain string or `/regex/flags`

## Behavior Notes

- Resource URLs can be real URLs or synthetic inline IDs like `inline://42` and `inline-css://style-sheet-1`.
