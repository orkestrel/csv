import { isCSVError } from '@src/core'
import {
	deriveColumns,
	deriveShapes,
	inferColumnType,
	needsQuote,
	quoteMinimal,
	quoteNonnumeric,
	renderCSV,
	renderRecord,
	renderTSV,
	resolveParseOptions,
	resolveRenderOptions,
	sanitizeField,
	quoteStyleToPolicy,
	serializeCell,
	uniqueColumns,
	uniqueName,
	wrapQuoted,
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

describe('uniqueName', () => {
	it('returns the name unchanged when not taken', () => {
		expect(uniqueName('a', new Set())).toBe('a')
	})

	it('suffixes _2 on first collision', () => {
		expect(uniqueName('a', new Set(['a']))).toBe('a_2')
	})

	it('keeps incrementing past an engineered collision', () => {
		expect(uniqueName('a', new Set(['a', 'a_2']))).toBe('a_3')
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

describe('needsQuote', () => {
	it('is true for a field containing the delimiter, quote, CR, or LF (the floor)', () => {
		const options = resolveRenderOptions()
		expect(needsQuote('a,b', options)).toBe(true)
		expect(needsQuote('a"b', options)).toBe(true)
		expect(needsQuote('a\rb', options)).toBe(true)
		expect(needsQuote('a\nb', options)).toBe(true)
	})

	it('is false for a plain field', () => {
		expect(needsQuote('plain', resolveRenderOptions())).toBe(false)
	})
})

describe('wrapQuoted', () => {
	it('escapes with doubled quote characters under double escape', () => {
		const options = resolveRenderOptions({ escape: 'double' })
		expect(wrapQuoted('a"b"c', options)).toBe('"a""b""c"')
	})

	it('escapes with a backslash under backslash escape, doubling literal backslashes', () => {
		const options = resolveRenderOptions({ escape: 'backslash' })
		expect(wrapQuoted('a"b', options)).toBe('"a\\"b"')
		expect(wrapQuoted('a\\b', options)).toBe('"a\\\\b"')
	})

	it('uses a custom quote character', () => {
		const options = resolveRenderOptions({ quote: "'", delimiter: ',' })
		expect(wrapQuoted("a'b", options)).toBe("'a''b'")
	})

	it('is the policy selected by quoteStyleToPolicy for "always"', () => {
		expect(quoteStyleToPolicy('always')).toBe(wrapQuoted)
	})
})

describe('quoteMinimal', () => {
	it('quotes only what the floor requires', () => {
		const options = resolveRenderOptions({ quotes: 'minimal' })
		expect(quoteMinimal('a,b', options)).toBe('"a,b"')
		expect(quoteMinimal('plain', options)).toBe('plain')
	})

	it('escapes with doubled quote characters under double escape', () => {
		const options = resolveRenderOptions({ quotes: 'minimal', escape: 'double' })
		expect(quoteMinimal('a"b', options)).toBe('"a""b"')
	})

	it('escapes with a backslash under backslash escape, including backslashes themselves', () => {
		const options = resolveRenderOptions({ quotes: 'minimal', escape: 'backslash' })
		expect(quoteMinimal('a"b,c', options)).toBe('"a\\"b,c"')
		expect(quoteMinimal('a\\b,c', options)).toBe('"a\\\\b,c"')
	})
})

describe('quoteNonnumeric', () => {
	it('quotes unless the field is a plain number', () => {
		const options = resolveRenderOptions({ quotes: 'nonnumeric' })
		expect(quoteNonnumeric('42', options)).toBe('42')
		expect(quoteNonnumeric('text', options)).toBe('"text"')
	})
})

describe('quoteStyleToPolicy', () => {
	it('selects quoteMinimal for "minimal"', () => {
		expect(quoteStyleToPolicy('minimal')).toBe(quoteMinimal)
	})

	it('selects wrapQuoted for "always"', () => {
		expect(quoteStyleToPolicy('always')).toBe(wrapQuoted)
	})

	it('selects quoteNonnumeric for "nonnumeric"', () => {
		expect(quoteStyleToPolicy('nonnumeric')).toBe(quoteNonnumeric)
	})
})

describe('deriveColumns', () => {
	it('derives the first-seen key union across rows', () => {
		expect(
			deriveColumns([
				{ a: 1, b: 2 },
				{ b: 3, c: 4 },
			]),
		).toEqual(['a', 'b', 'c'])
	})

	it('returns an empty list for no rows', () => {
		expect(deriveColumns([])).toEqual([])
	})
})

describe('renderRecord', () => {
	it('renders a row to a delimited line via the given quote policy', () => {
		const options = resolveRenderOptions()
		expect(renderRecord({ a: 1, b: 2 }, ['a', 'b'], options, quoteMinimal)).toBe('1,2')
	})

	it('applies sanitize before quoting', () => {
		const options = resolveRenderOptions()
		expect(renderRecord({ a: '=x' }, ['a'], options, quoteMinimal)).toBe("'=x")
	})
})

describe('serializeCell', () => {
	it('serializes null/undefined to blank', () => {
		expect(serializeCell(null, '')).toBe('')
		expect(serializeCell(undefined, 'NULL')).toBe('NULL')
	})

	it('leaves a string unchanged', () => {
		expect(serializeCell('hi', '')).toBe('hi')
	})

	it('stringifies number/boolean/bigint', () => {
		expect(serializeCell(42, '')).toBe('42')
		expect(serializeCell(true, '')).toBe('true')
		expect(serializeCell(10n, '')).toBe('10')
	})

	it('JSON-stringifies objects/arrays', () => {
		expect(serializeCell({ a: 1 }, '')).toBe('{"a":1}')
		expect(serializeCell([1, 2], '')).toBe('[1,2]')
	})

	it('degrades a circular value to blank', () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular
		expect(serializeCell(circular, '')).toBe('')
	})
})

describe('deriveShapes', () => {
	it('derives text for a column with no non-empty cells', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: '' }, { a: undefined }] })
		expect(columns.a).toBeDefined()
	})

	it('derives an inferred type for an all-string column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: '1' }, { a: '2' }] })
		expect(columns.a).toBeDefined()
	})

	it('derives integer/real for an all-number column', () => {
		const integer = deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 2 }] })
		expect(integer.a).toBeDefined()
		const real = deriveShapes({ columns: ['a'], rows: [{ a: 1.5 }] })
		expect(real.a).toBeDefined()
	})

	it('derives boolean for an all-boolean column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: true }, { a: false }] })
		expect(columns.a).toBeDefined()
	})

	it('derives json for a mixed column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 'x' }] })
		expect(columns.a).toBeDefined()
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
