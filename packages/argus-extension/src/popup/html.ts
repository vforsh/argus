/**
 * Escape a string for interpolation into popup HTML.
 *
 * Quotes are escaped, unlike the two `div.textContent` + `innerHTML` copies this replaces:
 * that idiom escapes `&`, `<`, and `>` but leaves `"` intact, and every call site here
 * interpolates into an attribute (`title="${escapeHtml(title)}"`). A tab whose title
 * contained a double quote would break out of the attribute.
 */
export const escapeHtml = (text: string): string =>
	text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;')
