import type { ArgusCommandOption } from '../defineCommand.js'

/**
 * The `--json` flag, declared once.
 *
 * Sixty-four command definitions spelled out this same object literal, and two register files had
 * already invented private copies of it. Commands whose JSON output makes a different promise
 * ("newline-delimited requests", "bounded preview") still write their own description; the point is
 * that the plain case has exactly one spelling.
 */
export const jsonOption: ArgusCommandOption = { flags: '--json', description: 'Output JSON for automation' }
