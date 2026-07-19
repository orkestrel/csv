import { isCSVError } from '@src/core'
import {
	coerceCell,
	inferColumnType,
	positionalColumns,
	quoteField,
	renderCSV,
	renderTSV,
	resolveParseOptions,
	resolveRenderOptions,
	sanitizeField,
	stripBom,
	uniqueColumns,
} from '@src/core'
import { assertAndNarrow, buildInferenceTraps } from '../../setup'
import { describe, expect, it } from 'vitest'

/**
 * Invoke `fn` and capture whatever it throws (or `undefined` if it doesn't) —
 * lets a test assert on the caught error unconditionally instead of an
 * `expect` nested inside a `try`/`catch`.
 */
function captureError(fn: () => void): unknown {
	try {
		fn()
		return undefined
	} catch (error) {
		return error
	}
}

// The CSV core's pure helper surface — option resolution, type inference,
// cell coercion, header disambiguation, formula-injection guarding, quoting,
// and the CSV/TSV renderers. Mirrors every exported helpers.ts symbol
// (AGENTS §16).

describe('stripBom', () => {
	it('strips a single leading BOM', () => {
		expect(stripBom('﻿a,b')).toBe('a,b')
	})

	it('leaves text without a BOM unchanged', () => {
		expect(stripBom('a,b')).toBe('a,b')
	})

	it('keeps a mid-string BOM untouched', () => {
		expect(stripBom('a﻿b')).toBe('a﻿b')
	})
})

describe('resolveParseOptions', () => {
	it('merges defaults with the given options', () => {
		const resolved = resolveParseOptions({ delimiter: ';', header: false })
		expect(resolved.delimiter).toBe(';')
		expect(resolved.header).toBe(false)
		expect(resolved.quote).toBe('"')
	})

	it('throws INVALID_OPTION when delimiter is not one character', () => {
		expect(() => resolveParseOptions({ delimiter: ',,' })).toThrow('delimiter')
		const error = captureError(() => resolveParseOptions({ delimiter: '' }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it('throws INVALID_OPTION when quote is not one character', () => {
		const error = captureError(() => resolveParseOptions({ quote: '""' }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it('throws INVALID_OPTION when delimiter equals quote', () => {
		const error = captureError(() => resolveParseOptions({ delimiter: '"', quote: '"' }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it.each(['\r', '\n', '﻿'])('throws INVALID_OPTION when delimiter is %j', (bad) => {
		const error = captureError(() => resolveParseOptions({ delimiter: bad }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it('throws INVALID_OPTION when comment is an empty string', () => {
		const error = captureError(() => resolveParseOptions({ comment: '' }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
		'throws INVALID_OPTION when limit is %j',
		(limit) => {
			const error = captureError(() => resolveParseOptions({ limit }))
			expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
		},
	)

	it('accepts a valid limit', () => {
		expect(resolveParseOptions({ limit: 10 }).limit).toBe(10)
	})
})

describe('resolveRenderOptions', () => {
	it('merges defaults with the given options', () => {
		const resolved = resolveRenderOptions({ newline: '\n', bom: true })
		expect(resolved.newline).toBe('\n')
		expect(resolved.bom).toBe(true)
		expect(resolved.delimiter).toBe(',')
	})

	it('accepts \\r\\n and \\n newlines', () => {
		expect(resolveRenderOptions({ newline: '\r\n' }).newline).toBe('\r\n')
		expect(resolveRenderOptions({ newline: '\n' }).newline).toBe('\n')
	})

	it('throws INVALID_OPTION for any other newline', () => {
		const error = captureError(() => resolveRenderOptions({ newline: '\r' }))
		expect(isCSVError(error) && error.code === 'INVALID_OPTION').toBe(true)
	})

	it('throws INVALID_OPTION when delimiter/quote are invalid', () => {
		const delimiterError = captureError(() => resolveRenderOptions({ delimiter: 'ab' }))
		expect(isCSVError(delimiterError) && delimiterError.code === 'INVALID_OPTION').toBe(true)
		const quoteError = captureError(() => resolveRenderOptions({ delimiter: ',', quote: ',' }))
		expect(isCSVError(quoteError) && quoteError.code === 'INVALID_OPTION').toBe(true)
	})
})

describe('inferColumnType', () => {
	it('infers integer for whole-number cells', () => {
		expect(inferColumnType(['1', '2', '3'])).toBe('integer')
	})

	it('infers real when integers and decimals mix', () => {
		expect(inferColumnType(['1', '2.5', '3'])).toBe('real')
	})

	it('infers boolean when every cell is true/false', () => {
		expect(inferColumnType(['true', 'false', 'true'])).toBe('boolean')
	})

	it('ignores empty cells rather than demoting', () => {
		expect(inferColumnType(['1', '', '2'])).toBe('integer')
		expect(inferColumnType(['', '', ''])).toBe('text')
		expect(inferColumnType([])).toBe('text')
	})

	it('demotes an out-of-safe-range integer to text', () => {
		expect(inferColumnType(['9999999999999999999'])).toBe('text')
		expect(inferColumnType([String(Number.MAX_SAFE_INTEGER)])).toBe('integer')
	})

	it('demotes every classic inference trap to text', () => {
		const lines = buildInferenceTraps().split('\n')
		const [header, ...traps] = lines
		expect(header).toBe('value')
		for (const trap of traps) {
			expect(inferColumnType([trap])).toBe('text')
		}
	})
})

describe('coerceCell', () => {
	it('leaves text unchanged', () => {
		expect(coerceCell('hello', 'text')).toBe('hello')
	})

	it('leaves blob unchanged', () => {
		expect(coerceCell('raw bytes', 'blob')).toBe('raw bytes')
	})

	it('returns undefined for an empty string with a non-text type', () => {
		expect(coerceCell('', 'integer')).toBeUndefined()
		expect(coerceCell('', 'boolean')).toBeUndefined()
		expect(coerceCell('', 'json')).toBeUndefined()
	})

	it('coerces integer/real to Number', () => {
		expect(coerceCell('42', 'integer')).toBe(42)
		expect(coerceCell('3.14', 'real')).toBe(3.14)
	})

	it('coerces boolean strictly', () => {
		expect(coerceCell('true', 'boolean')).toBe(true)
		expect(coerceCell('false', 'boolean')).toBe(false)
	})

	it('parses json, falling back to the raw string on failure', () => {
		expect(coerceCell('{"a":1}', 'json')).toEqual({ a: 1 })
		expect(coerceCell('not json', 'json')).toBe('not json')
	})
})

describe('positionalColumns', () => {
	it('generates 1-based positional names', () => {
		expect(positionalColumns(3)).toEqual(['column1', 'column2', 'column3'])
	})

	it('returns an empty list for width 0', () => {
		expect(positionalColumns(0)).toEqual([])
	})
})

describe('uniqueColumns', () => {
	it('disambiguates duplicate names with _2, _3, ...', () => {
		expect(uniqueColumns(['name', 'name', 'name'])).toEqual(['name', 'name_2', 'name_3'])
	})

	it('replaces an empty or whitespace-only name with a positional name', () => {
		expect(uniqueColumns(['a', '', '  ', 'b'])).toEqual(['a', 'column2', 'column3', 'b'])
	})

	it('keeps incrementing past an engineered collision', () => {
		expect(uniqueColumns(['a', 'a', 'a_2'])).toEqual(['a', 'a_2', 'a_2_2'])
	})

	it('runs a generated positional name through the same collision resolver as a literal name', () => {
		expect(uniqueColumns(['column2', ''])).toEqual(['column2', 'column2_2'])
		expect(uniqueColumns(['', 'column1'])).toEqual(['column1', 'column1_2'])
	})

	it('produces a strictly unique, same-length list for a nasty mixed case', () => {
		const input = ['a', 'a', 'a_2', '', 'column4']
		const result = uniqueColumns(input)
		expect(result).toHaveLength(input.length)
		expect(new Set(result).size).toBe(result.length)
	})

	it('is deterministic — the same input twice yields the same output', () => {
		const input = ['a', 'a', 'a_2', '', 'column4']
		expect(uniqueColumns(input)).toEqual(uniqueColumns(input))
	})
})

describe('sanitizeField', () => {
	it.each(['=SUM(A1)', '@cmd', '\ttab', '\rcr', '\nlf'])(
		'prefixes a protective quote for %j',
		(field) => {
			expect(sanitizeField(field)).toBe(`'${field}`)
		},
	)

	it('leaves a plain signed number untouched', () => {
		expect(sanitizeField('-5')).toBe('-5')
		expect(sanitizeField('+3.14')).toBe('+3.14')
	})

	it('sanitizes a +/- field that is not a plain number', () => {
		expect(sanitizeField('+1 (555) 0123')).toBe("'+1 (555) 0123")
	})

	it('leaves an unrelated field untouched', () => {
		expect(sanitizeField('hello')).toBe('hello')
	})
})

describe('quoteField', () => {
	it('quotes when the field contains the delimiter, quote, CR, or LF (the floor)', () => {
		const options = resolveRenderOptions({ quotes: 'minimal' })
		expect(quoteField('a,b', options)).toBe('"a,b"')
		expect(quoteField('a"b', options)).toBe('"a""b"')
		expect(quoteField('a\rb', options)).toBe('"a\rb"')
		expect(quoteField('a\nb', options)).toBe('"a\nb"')
	})

	it('minimal only quotes what the floor requires', () => {
		const options = resolveRenderOptions({ quotes: 'minimal' })
		expect(quoteField('plain', options)).toBe('plain')
	})

	it('always quotes every field', () => {
		const options = resolveRenderOptions({ quotes: 'always' })
		expect(quoteField('plain', options)).toBe('"plain"')
	})

	it('nonnumeric quotes unless the field is a plain number', () => {
		const options = resolveRenderOptions({ quotes: 'nonnumeric' })
		expect(quoteField('42', options)).toBe('42')
		expect(quoteField('text', options)).toBe('"text"')
	})

	it('escapes with doubled quote characters under double escape', () => {
		const options = resolveRenderOptions({ quotes: 'always', escape: 'double' })
		expect(quoteField('a"b', options)).toBe('"a""b"')
	})

	it('escapes with a backslash under backslash escape, including backslashes themselves', () => {
		const options = resolveRenderOptions({ quotes: 'always', escape: 'backslash' })
		expect(quoteField('a"b', options)).toBe('"a\\"b"')
		expect(quoteField('a\\b', options)).toBe('"a\\\\b"')
	})
})

describe('renderCSV', () => {
	it('renders a CSVTable input', () => {
		const csv = renderCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] })
		expect(csv).toBe('a,b\r\n1,2')
	})

	it('renders a Row[] input using first-seen key union order', () => {
		const csv = renderCSV([
			{ a: 1, b: 2 },
			{ b: 3, c: 4 },
		])
		expect(csv).toBe('a,b,c\r\n1,2,\r\n,3,4')
	})

	it('honors an explicit columns subset', () => {
		const csv = renderCSV(
			{ columns: ['a', 'b', 'c'], rows: [{ a: 1, b: 2, c: 3 }] },
			{ columns: ['c', 'a'] },
		)
		expect(csv).toBe('c,a\r\n3,1')
	})

	it('omits the header row when header is false', () => {
		const csv = renderCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] }, { header: false })
		expect(csv).toBe('1,2')
	})

	it('renders blank for null/undefined and missing keys', () => {
		const csv = renderCSV([{ a: null, b: undefined }, { a: 1 }], { header: false })
		expect(csv).toBe(',\r\n1,')
	})

	it('serializes nested objects/arrays via JSON.stringify', () => {
		const csv = renderCSV([{ a: { x: 1 }, b: [1, 2] }], { header: false })
		expect(csv).toBe('"{""x"":1}","[1,2]"')
	})

	it('prepends the BOM when bom is true', () => {
		const csv = renderCSV({ columns: ['a'], rows: [{ a: 1 }] }, { bom: true, header: false })
		expect(csv.startsWith('﻿')).toBe(true)
	})

	it.each([
		['\n', '\n'],
		['\r\n', '\r\n'],
	])('uses the requested newline (%j)', (newline) => {
		const csv = renderCSV(
			{
				columns: ['a', 'b'],
				rows: [
					{ a: 1, b: 2 },
					{ a: 3, b: 4 },
				],
			},
			{ newline },
		)
		expect(csv).toBe(`a,b${newline}1,2${newline}3,4`)
	})

	it('emits no trailing newline after the last record', () => {
		const csv = renderCSV({ columns: ['a'], rows: [{ a: 1 }] })
		expect(csv.endsWith('\r\n')).toBe(false)
	})

	it('leaves a leading formula character untouched when sanitize is false', () => {
		const csv = renderCSV([{ a: '=x' }], { header: false, sanitize: false })
		expect(csv).toBe('=x')
	})

	it('sanitizes a leading formula character by default', () => {
		const csv = renderCSV([{ a: '=x' }], { header: false })
		expect(csv).toBe("'=x")
	})

	it('degrades a circular value to blank instead of throwing', () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		const csv = renderCSV([{ a: circular }], { header: false })
		expect(csv).toBe('')
	})
})

describe('renderTSV', () => {
	it('forces tab delimiters', () => {
		const tsv = renderTSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] })
		expect(tsv).toBe('a\tb\r\n1\t2')
	})

	it('overrides an explicit delimiter option with a tab', () => {
		const tsv = renderTSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] }, { delimiter: ';' })
		expect(tsv).toBe('a\tb\r\n1\t2')
	})
})

describe('assertAndNarrow usage sanity', () => {
	it('narrows a value satisfying a guard', () => {
		const value = assertAndNarrow(
			(candidate): candidate is string => typeof candidate === 'string',
			'ok',
		)
		expect(value).toBe('ok')
	})
})
