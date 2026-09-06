import { describe, expect, test } from 'bun:test'
import { applyQueryParams, isHttpUrl, parseParamPair, parseParamsString, resolveNavigationUrl } from '../src/url/queryParams.js'

describe('parseParamPair', () => {
	test('splits on the first "="', () => {
		expect(parseParamPair('a=b=c')).toEqual({ key: 'a', value: 'b=c' })
	})

	test('allows an empty value', () => {
		expect(parseParamPair('a=')).toEqual({ key: 'a', value: '' })
	})

	test('rejects a missing "="', () => {
		expect(parseParamPair('noequals')).toEqual({ error: 'Invalid --param "noequals": missing "=".' })
	})

	test('rejects an empty key', () => {
		expect(parseParamPair('=value')).toEqual({ error: 'Invalid --param "=value": empty key.' })
	})
})

describe('parseParamsString', () => {
	test('parses multiple pairs', () => {
		const parsed = parseParamsString('a=1&b=2')
		expect(parsed).toBeInstanceOf(URLSearchParams)
		expect((parsed as URLSearchParams).get('a')).toBe('1')
		expect((parsed as URLSearchParams).get('b')).toBe('2')
	})

	test('percent-decodes keys and values', () => {
		const parsed = parseParamsString('a%20b=c%26d') as URLSearchParams
		expect(parsed.get('a b')).toBe('c&d')
	})

	test('treats an empty string as no params', () => {
		expect(Array.from((parseParamsString('  ') as URLSearchParams).entries())).toEqual([])
	})

	test('rejects a pair without "="', () => {
		expect(parseParamsString('a=1&broken')).toEqual({ error: 'Invalid --params "broken": missing "=".' })
	})

	test('rejects an empty key', () => {
		expect(parseParamsString('=1')).toEqual({ error: 'Invalid --params "=1": empty key.' })
	})
})

describe('isHttpUrl', () => {
	test('accepts http and https', () => {
		expect(isHttpUrl('http://a/')).toBe(true)
		expect(isHttpUrl('https://a/')).toBe(true)
	})

	test('rejects everything else', () => {
		expect(isHttpUrl('about:blank')).toBe(false)
		expect(isHttpUrl('file:///tmp/x.html')).toBe(false)
	})
})

describe('applyQueryParams', () => {
	test('returns the URL unchanged when no overrides are given', () => {
		expect(applyQueryParams('about:blank', {})).toEqual({ url: 'about:blank' })
	})

	test('overwrites existing params and keeps the rest', () => {
		const result = applyQueryParams('http://h/p?keep=1&over=old', { param: ['over=new'] })
		expect(result).toEqual({ url: 'http://h/p?keep=1&over=new' })
	})

	test('preserves the path', () => {
		expect(applyQueryParams('http://h/deep/path', { param: ['x=1'] })).toEqual({ url: 'http://h/deep/path?x=1' })
	})

	test('applies --params before --param so an explicit pair wins', () => {
		const result = applyQueryParams('http://h/', { param: ['a=fromParam'], params: 'a=fromParams&b=2' })
		expect(result).toEqual({ url: 'http://h/?a=fromParam&b=2' })
	})

	test('refuses a non-http URL', () => {
		expect(applyQueryParams('about:blank', { param: ['a=1'] })).toEqual({
			error: 'URL "about:blank" is not http/https. Cannot update query params.',
		})
	})

	test('propagates a bad pair', () => {
		expect(applyQueryParams('http://h/', { param: ['nope'] })).toEqual({ error: 'Invalid --param "nope": missing "=".' })
	})

	test('propagates a bad params string', () => {
		expect(applyQueryParams('http://h/', { params: 'nope' })).toEqual({ error: 'Invalid --params "nope": missing "=".' })
	})
})

describe('resolveNavigationUrl', () => {
	const current = 'http://127.0.0.1:3333/a/b?old=1#frag'

	test('passes an absolute URL through', () => {
		expect(resolveNavigationUrl('https://example.com/x', current)).toEqual({ url: 'https://example.com/x' })
	})

	test('passes a non-http scheme through', () => {
		expect(resolveNavigationUrl('about:blank', current)).toEqual({ url: 'about:blank' })
	})

	test('adds http:// to a scheme-less host', () => {
		expect(resolveNavigationUrl('example.com/x', current)).toEqual({ url: 'http://example.com/x' })
	})

	test('adds http:// to host:port rather than reading it as a scheme', () => {
		expect(resolveNavigationUrl('localhost:3000', current)).toEqual({ url: 'http://localhost:3000' })
	})

	test('resolves an absolute path against the current URL', () => {
		expect(resolveNavigationUrl('/b', current)).toEqual({ url: 'http://127.0.0.1:3333/b' })
	})

	test('resolves a query-only input, keeping the path', () => {
		expect(resolveNavigationUrl('?x=1', current)).toEqual({ url: 'http://127.0.0.1:3333/a/b?x=1' })
	})

	test('resolves a hash-only input, keeping path and query', () => {
		expect(resolveNavigationUrl('#top', current)).toEqual({ url: 'http://127.0.0.1:3333/a/b?old=1#top' })
	})

	test('resolves dot-relative inputs', () => {
		expect(resolveNavigationUrl('./c', current)).toEqual({ url: 'http://127.0.0.1:3333/a/c' })
		expect(resolveNavigationUrl('../c', current)).toEqual({ url: 'http://127.0.0.1:3333/c' })
	})

	test('trims surrounding whitespace', () => {
		expect(resolveNavigationUrl('  /b  ', current)).toEqual({ url: 'http://127.0.0.1:3333/b' })
	})

	test('rejects an empty input', () => {
		expect(resolveNavigationUrl('   ', current)).toEqual({ error: 'URL must be a non-empty string.' })
	})

	test('rejects a relative input when no current URL is known', () => {
		expect(resolveNavigationUrl('/b', null)).toEqual({
			error: 'Cannot resolve relative URL "/b": the page has no current URL.',
		})
	})

	test('still resolves an absolute input with no current URL', () => {
		expect(resolveNavigationUrl('https://example.com/', null)).toEqual({ url: 'https://example.com/' })
	})
})
