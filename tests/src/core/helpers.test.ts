import {
	BOM,
	MAX_ERRORS,
	advancePosition,
	assertValidSeparators,
	buildRow,
	deriveColumns,
	deriveHeader,
	isBreakChar,
	isCSVError,
	isRowList,
	needsQuote,
	quoteMinimal,
	quoteNonnumeric,
	quoteStyleToPolicy,
	readRecords,
	renderCSV,
	renderRecord,
	resolveParseOptions,
	resolveRenderOptions,
	sanitizeField,
	scanBreak,
	scanComment,
	scanField,
	scanQuoted,
	scanRecord,
	scanUnquoted,
	serializeCell,
	uniqueColumns,
	uniqueName,
	wrapQuoted,
} from '@src/core'
import { captureError } from '@orkestrel/test'
import { assertAndNarrow, buildMixedNewlineCSV, buildQuotedField } from '../../setup.js'
import { describe, expect, it } from 'vitest'

const START = { offset: 0, line: 1, column: 1 }

// The whole helpers.ts surface — separator validation, option resolution,
// header disambiguation, formula-injection guarding, quoting, the CSV
// renderer, and the tokenizer and table-builder leaves parseCSV composes.

describe('assertValidSeparators', () => {
	it('returns without throwing for a valid delimiter and quote pair', () => {
		expect(captureError(() => assertValidSeparators(',', '"'))).toBeUndefined()
	})

	it('throws INVALID_OPTION for a multi-character delimiter', () => {
		const error = assertAndNarrow(
			isCSVError,
			captureError(() => assertValidSeparators(',,', '"')),
		)
		expect(error.code).toBe('INVALID_OPTION')
		expect(error.message).toContain('delimiter')
	})

	it('throws INVALID_OPTION for a multi-character quote', () => {
		const error = assertAndNarrow(
			isCSVError,
			captureError(() => assertValidSeparators(',', '""')),
		)
		expect(error.code).toBe('INVALID_OPTION')
		expect(error.message).toContain('quote')
	})

	it('throws INVALID_OPTION when the delimiter and quote are the same character', () => {
		const error = assertAndNarrow(
			isCSVError,
			captureError(() => assertValidSeparators(',', ',')),
		)
		expect(error.code).toBe('INVALID_OPTION')
		expect(error.message).toContain('same character')
	})

	it('throws INVALID_OPTION for CR, LF, or a byte-order-mark in either position', () => {
		for (const char of ['\r', '\n', BOM]) {
			const asDelimiter = assertAndNarrow(
				isCSVError,
				captureError(() => assertValidSeparators(char, '"')),
			)
			expect(asDelimiter.code).toBe('INVALID_OPTION')
			expect(asDelimiter.message).toContain('delimiter')
			const asQuote = assertAndNarrow(
				isCSVError,
				captureError(() => assertValidSeparators(',', char)),
			)
			expect(asQuote.code).toBe('INVALID_OPTION')
			expect(asQuote.message).toContain('quote')
		}
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

	it('omits absent location and context from INVALID_OPTION errors', () => {
		const caught = captureError(() => resolveParseOptions({ delimiter: '' }))
		const error = assertAndNarrow(isCSVError, caught)

		expect(Object.hasOwn(error, 'line')).toBe(false)
		expect(Object.hasOwn(error, 'column')).toBe(false)
		expect(Object.hasOwn(error, 'offset')).toBe(false)
		expect(Object.hasOwn(error, 'context')).toBe(false)
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

describe('isRowList', () => {
	it('accepts a readonly Row[] value', () => {
		expect(isRowList([{ a: 1 }, { b: 2 }])).toBe(true)
	})

	it('accepts an empty array', () => {
		expect(isRowList([])).toBe(true)
	})

	it('rejects a CSVTable value', () => {
		expect(isRowList({ columns: ['a'], rows: [{ a: 1 }] })).toBe(false)
	})

	it('rejects a CSVTable with empty columns/rows', () => {
		expect(isRowList({ columns: [], rows: [] })).toBe(false)
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

	it('renders tab-separated text for a tab delimiter', () => {
		const tsv = renderCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] }, { delimiter: '\t' })
		expect(tsv).toBe('a\tb\r\n1\t2')
	})
})

describe('advancePosition', () => {
	it('shifts offset and column by one and leaves line unchanged by default', () => {
		expect(advancePosition(START)).toEqual({ offset: 1, line: 1, column: 2 })
	})

	it('shifts offset and column by an explicit count', () => {
		expect(advancePosition(START, 2)).toEqual({ offset: 2, line: 1, column: 3 })
	})
})

describe('isBreakChar', () => {
	it('reports true for CR and LF', () => {
		expect(isBreakChar('\r')).toBe(true)
		expect(isBreakChar('\n')).toBe(true)
	})

	it('reports false for a letter, an empty string, and a tab', () => {
		expect(isBreakChar('a')).toBe(false)
		expect(isBreakChar('')).toBe(false)
		expect(isBreakChar('\t')).toBe(false)
	})
})

describe('scanBreak', () => {
	it('consumes a bare LF', () => {
		expect(scanBreak('a\nb', { offset: 1, line: 1, column: 2 })).toEqual({
			offset: 2,
			line: 2,
			column: 1,
		})
	})

	it('consumes a bare CR', () => {
		expect(scanBreak('a\rb', { offset: 1, line: 1, column: 2 })).toEqual({
			offset: 2,
			line: 2,
			column: 1,
		})
	})

	it('consumes a CRLF pair as ONE break', () => {
		expect(scanBreak('a\r\nb', { offset: 1, line: 1, column: 2 })).toEqual({
			offset: 3,
			line: 2,
			column: 1,
		})
	})

	it('returns undefined when not at a break', () => {
		expect(scanBreak('ab', START)).toBeUndefined()
	})
})

describe('scanComment', () => {
	it('returns undefined when no comment marker is configured', () => {
		expect(scanComment('#hi\na', START, resolveParseOptions())).toBeUndefined()
	})

	it('returns undefined when the text does not start with the comment marker', () => {
		expect(scanComment('a,b', START, resolveParseOptions({ comment: '#' }))).toBeUndefined()
	})

	it('consumes through the break after a comment line', () => {
		const next = scanComment('#hi\na', START, resolveParseOptions({ comment: '#' }))
		expect(next).toEqual({ offset: 4, line: 2, column: 1 })
	})

	it('consumes to end-of-input when the comment has no trailing break', () => {
		const next = scanComment('#hi', START, resolveParseOptions({ comment: '#' }))
		expect(next).toEqual({ offset: 3, line: 1, column: 4 })
	})
})

describe('scanUnquoted', () => {
	it('scans up to the delimiter', () => {
		const scan = scanUnquoted('ab,c', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: false })
		expect(scan.next).toEqual({ offset: 2, line: 1, column: 3 })
		expect(scan.errors).toHaveLength(0)
	})

	it('scans up to a break', () => {
		const scan = scanUnquoted('ab\nc', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: false })
		expect(scan.next.offset).toBe(2)
	})

	it('scans to end-of-input', () => {
		const scan = scanUnquoted('ab', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: false })
		expect(scan.next.offset).toBe(2)
	})

	it('collects BAD_QUOTE for an interior quote, keeping it literal', () => {
		const scan = scanUnquoted('a"b', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'a"b', quoted: false })
		expect(scan.errors).toHaveLength(1)
		expect(scan.errors[0]?.code).toBe('BAD_QUOTE')
	})

	it('trims only when options.trim is true', () => {
		const scan = scanUnquoted('  ab  ,', START, resolveParseOptions({ trim: true }))
		expect(scan.field.value).toBe('ab')
		const untrimmed = scanUnquoted('  ab  ,', START, resolveParseOptions())
		expect(untrimmed.field.value).toBe('  ab  ')
	})
})

describe('scanQuoted', () => {
	it('scans a simple quoted field', () => {
		const scan = scanQuoted('"ab",c', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: true })
		expect(scan.next.offset).toBe(4)
		expect(scan.errors).toHaveLength(0)
	})

	it('unescapes a doubled quote under the double escape style', () => {
		const scan = scanQuoted('"a""b"', START, resolveParseOptions({ escape: 'double' }))
		expect(scan.field).toEqual({ value: 'a"b', quoted: true })
	})

	it('unescapes backslash-quote and backslash-backslash under the backslash escape style', () => {
		const scan = scanQuoted('"a\\"b\\\\c"', START, resolveParseOptions({ escape: 'backslash' }))
		expect(scan.field).toEqual({ value: 'a"b\\c', quoted: true })
	})

	it('a doubled quote is NOT an escape under the backslash escape style', () => {
		const scan = scanQuoted('"a""b"', START, resolveParseOptions({ escape: 'backslash' }))
		expect(scan.field).toEqual({ value: 'a"b"', quoted: true })
		expect(scan.errors).toHaveLength(1)
		expect(scan.errors[0]?.code).toBe('BAD_QUOTE')
	})

	it('preserves an embedded CRLF verbatim', () => {
		const scan = scanQuoted('"x\r\ny"', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'x\r\ny', quoted: true })
	})

	it('collects UNTERMINATED_QUOTE at the OPENING quote position', () => {
		const open = { offset: 2, line: 1, column: 3 }
		const scan = scanQuoted('c,"unterminated', open, resolveParseOptions())
		expect(scan.errors).toHaveLength(1)
		expect(scan.errors[0]?.code).toBe('UNTERMINATED_QUOTE')
		expect(scan.errors[0]?.offset).toBe(2)
		expect(scan.errors[0]?.column).toBe(3)
		expect(scan.field.value).toBe('unterminated')
	})

	it('collects BAD_QUOTE for an illegal char after a closing quote, appending the remainder literally', () => {
		const scan = scanQuoted('"ab"c,x', START, resolveParseOptions())
		expect(scan.errors).toHaveLength(1)
		expect(scan.errors[0]?.code).toBe('BAD_QUOTE')
		expect(scan.errors[0]?.offset).toBe(4)
		expect(scan.field).toEqual({ value: 'abc', quoted: true })
	})
})

describe('scanField', () => {
	it('dispatches to scanQuoted when at the quote char', () => {
		const scan = scanField('"ab"', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: true })
	})

	it('dispatches to scanUnquoted otherwise', () => {
		const scan = scanField('ab', START, resolveParseOptions())
		expect(scan.field).toEqual({ value: 'ab', quoted: false })
	})
})

describe('scanRecord', () => {
	it('scans a full record ending at a break', () => {
		const scan = scanRecord('a,b\nc', START, resolveParseOptions())
		expect(scan.record.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: 'b', quoted: false },
		])
		expect(scan.record.start).toEqual(START)
		expect(scan.next).toEqual({ offset: 4, line: 2, column: 1 })
	})

	it('scans a full record ending at end-of-input', () => {
		const scan = scanRecord('a,b', START, resolveParseOptions())
		expect(scan.record.fields).toHaveLength(2)
		expect(scan.next.offset).toBe(3)
	})
})

describe('readRecords', () => {
	it('round-trips a quoted field containing a delimiter, CR, LF, and an escaped quote', () => {
		const { records, errors } = readRecords(`a,${buildQuotedField()},b`)
		expect(errors).toHaveLength(0)
		expect(records).toHaveLength(1)
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		expect(record.fields[1]).toEqual({ value: 'a,b\r\nc"d', quoted: true })
	})

	it('collects UNTERMINATED_QUOTE at the position of the opening quote', () => {
		const input = 'a,b\nc,"unterminated'
		const { records, errors } = readRecords(input)
		expect(records).toHaveLength(2)
		expect(errors).toHaveLength(1)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('UNTERMINATED_QUOTE')
		expect(error.line).toBe(2)
		expect(error.column).toBe(3)
		expect(error.offset).toBe(6)
	})

	it('collects BAD_QUOTE for an illegal char after a closing quote, keeping both fields', () => {
		const { records, errors } = readRecords('"ab"c,x')
		expect(errors).toHaveLength(1)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('BAD_QUOTE')
		expect(error.line).toBe(1)
		expect(error.column).toBe(5)
		expect(error.offset).toBe(4)
		expect(records).toHaveLength(1)
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		expect(record.fields).toHaveLength(2)
		expect(record.fields[0]).toEqual({ value: 'abc', quoted: true })
		expect(record.fields[1]).toEqual({ value: 'x', quoted: false })
	})

	it('handles mixed CRLF / LF / bare-CR separators with correct record count and line numbers', () => {
		const csv = `${buildMixedNewlineCSV()}\n"bad`
		const { records, errors } = readRecords(csv)
		expect(records).toHaveLength(5)
		expect(records[2]?.fields).toEqual([
			{ value: '3', quoted: false },
			{ value: '4', quoted: false },
		])
		expect(records[2]?.start.line).toBe(3)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('UNTERMINATED_QUOTE')
		expect(error.line).toBe(5)
	})

	it('preserves an embedded CRLF inside a quoted field verbatim', () => {
		const { records } = readRecords('a,"x\r\ny"')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		expect(record.fields[1]).toEqual({ value: 'x\r\ny', quoted: true })
	})

	it('yields identical records with or without a trailing newline', () => {
		const noTrailing = readRecords('a,b\n1,2')
		const trailing = readRecords('a,b\n1,2\n')
		// CRLF separators shift byte offsets relative to LF ones, so only the
		// field content (not position) is compared against the CRLF variant.
		const crlfTrailing = readRecords('a,b\r\n1,2\r\n')
		expect(trailing.records).toEqual(noTrailing.records)
		expect(crlfTrailing.records.map((record) => record.fields)).toEqual(
			noTrailing.records.map((record) => record.fields),
		)
	})

	it('strips exactly one leading BOM; a mid-file BOM stays as data', () => {
		const bom = '﻿'
		const { records } = readRecords(`${bom}a,b\n1,${bom}2`)
		expect(records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: 'b', quoted: false },
		])
		expect(records[1]?.fields).toEqual([
			{ value: '1', quoted: false },
			{ value: `${bom}2`, quoted: false },
		])
	})

	it('distinguishes an unquoted empty field from a quoted empty field', () => {
		const unquoted = readRecords('a,,b')
		expect(unquoted.records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: '', quoted: false },
			{ value: 'b', quoted: false },
		])
		const quoted = readRecords('a,"",b')
		expect(quoted.records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: '', quoted: true },
			{ value: 'b', quoted: false },
		])
	})

	it('treats a missing trailing field as two fields', () => {
		const { records } = readRecords('a,')
		expect(records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: '', quoted: false },
		])
	})

	it('keeps a wholly empty line as a record when blanks is true, and drops it when false', () => {
		const kept = readRecords('a,b\n\nc,d', { blanks: true })
		expect(kept.records).toHaveLength(3)
		expect(kept.records[1]?.fields).toEqual([{ value: '', quoted: false }])
		const dropped = readRecords('a,b\n\nc,d', { blanks: false })
		expect(dropped.records).toHaveLength(2)
	})

	it('does not treat a whitespace-only line as blank', () => {
		const { records } = readRecords('a,b\n   \nc,d', { blanks: false })
		expect(records).toHaveLength(3)
		expect(records[1]?.fields).toEqual([{ value: '   ', quoted: false }])
	})

	it('skips comment lines while keeping later line numbers correct', () => {
		const input = '# a comment\na,b\n# another\nc,"bad'
		const { records, errors } = readRecords(input, { comment: '#' })
		expect(records).toHaveLength(2)
		expect(records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: 'b', quoted: false },
		])
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.line).toBe(4)
	})

	it('trims only unquoted field values', () => {
		const { records } = readRecords('  a  ,"  b  "', { trim: true })
		expect(records[0]?.fields).toEqual([
			{ value: 'a', quoted: false },
			{ value: '  b  ', quoted: true },
		])
	})

	it('stops scanning after LIMIT_EXCEEDED, emitting only up to the cap', () => {
		const { records, errors } = readRecords('1\n2\n3\n4\n5', { limit: 2 })
		expect(records).toHaveLength(2)
		expect(errors).toHaveLength(1)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('LIMIT_EXCEEDED')
	})

	it('caps collected errors at MAX_ERRORS', () => {
		const lines: string[] = []
		for (let index = 0; index < MAX_ERRORS + 10; index += 1) lines.push('"ab"c')
		const { errors } = readRecords(lines.join('\n'))
		expect(errors).toHaveLength(MAX_ERRORS)
	})

	it('supports the backslash escape style; a doubled quote is NOT an escape in that mode', () => {
		const { records, errors } = readRecords('"a\\"b\\\\c"', { escape: 'backslash' })
		expect(errors).toHaveLength(0)
		expect(records[0]?.fields).toEqual([{ value: 'a"b\\c', quoted: true }])

		const doubled = readRecords('"a""b"', { escape: 'backslash' })
		expect(doubled.records[0]?.fields).toEqual([{ value: 'a"b"', quoted: true }])
		expect(doubled.errors).toHaveLength(1)
		const doubledError = doubled.errors[0]
		expect(doubledError).toBeDefined()
		if (doubledError === undefined) return
		expect(doubledError.code).toBe('BAD_QUOTE')
	})

	it('parses tab-separated text via delimiter "\\t"', () => {
		const { records } = readRecords('a\tb\n1\t2', { delimiter: '\t' })
		expect(records.map((record) => record.fields)).toEqual([
			[
				{ value: 'a', quoted: false },
				{ value: 'b', quoted: false },
			],
			[
				{ value: '1', quoted: false },
				{ value: '2', quoted: false },
			],
		])
	})

	it('returns an empty result for empty input (or input that is only a BOM)', () => {
		expect(readRecords('')).toEqual({ records: [], errors: [] })
		expect(readRecords('﻿')).toEqual({ records: [], errors: [] })
	})

	it("reports each record's start position", () => {
		const { records } = readRecords('a,b\n1,2')
		expect(records[0]?.start).toEqual({ offset: 0, line: 1, column: 1 })
		expect(records[1]?.start).toEqual({ offset: 4, line: 2, column: 1 })
	})
})

describe('deriveHeader', () => {
	it('disambiguates duplicate raw names and collects DUPLICATE_HEADER', () => {
		const { records } = readRecords('id,id,name\n1,2,3')
		const header = deriveHeader(records, resolveParseOptions())
		expect(header.columns).toEqual(['id', 'id_2', 'name'])
		expect(header.errors).toHaveLength(1)
		expect(header.errors[0]?.code).toBe('DUPLICATE_HEADER')
		expect(header.errors[0]?.context).toEqual({ name: 'id', index: 1 })
	})

	it('collects EMPTY_HEADER for a blank name', () => {
		const { records } = readRecords(',b\n1,2')
		const header = deriveHeader(records, resolveParseOptions())
		expect(header.columns).toEqual(['column1', 'b'])
		expect(header.errors).toHaveLength(1)
		expect(header.errors[0]?.code).toBe('EMPTY_HEADER')
		expect(header.errors[0]?.context).toEqual({ index: 0 })
	})

	it('uses positional columns at the widest record when header is false', () => {
		const { records } = readRecords('1,2\n1,2,3')
		const header = deriveHeader(records, resolveParseOptions({ header: false }))
		expect(header.columns).toEqual(['column1', 'column2', 'column3'])
		expect(header.body).toHaveLength(2)
		expect(header.errors).toHaveLength(0)
	})

	it('returns empty results for no records', () => {
		expect(deriveHeader([], resolveParseOptions())).toEqual({ columns: [], body: [], errors: [] })
	})
})

describe('buildRow', () => {
	it('builds an exact-width record with no error', () => {
		const { records } = readRecords('1,2')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		const result = buildRow(record, ['a', 'b'], resolveParseOptions())
		expect(result.row).toEqual({ a: '1', b: '2' })
		expect(result.error).toBeUndefined()
	})

	it('"collect" pads a short record and collects RAGGED_ROW', () => {
		const { records } = readRecords('1,2')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		const result = buildRow(record, ['a', 'b', 'c'], resolveParseOptions({ ragged: 'collect' }))
		expect(result.row).toEqual({ a: '1', b: '2', c: undefined })
		expect(result.error?.code).toBe('RAGGED_ROW')
		expect(result.error?.context).toEqual({ expected: 3, actual: 2 })
	})

	it('"collect" truncates a long record and reports dropped values', () => {
		const { records } = readRecords('1,2,3,4')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		const result = buildRow(record, ['a', 'b', 'c'], resolveParseOptions({ ragged: 'collect' }))
		expect(result.row).toEqual({ a: '1', b: '2', c: '3' })
		expect(result.error?.context).toEqual({ expected: 3, actual: 4, dropped: ['4'] })
	})

	it('"pad" pads/truncates silently', () => {
		const { records } = readRecords('1,2')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		const result = buildRow(record, ['a', 'b', 'c'], resolveParseOptions({ ragged: 'pad' }))
		expect(result.row).toEqual({ a: '1', b: '2', c: undefined })
		expect(result.error).toBeUndefined()
	})

	it('"error" omits the row, returning only the error', () => {
		const { records } = readRecords('1,2')
		const record = records[0]
		expect(record).toBeDefined()
		if (record === undefined) return
		const result = buildRow(record, ['a', 'b', 'c'], resolveParseOptions({ ragged: 'error' }))
		expect(result.row).toBeUndefined()
		expect(result.error?.code).toBe('RAGGED_ROW')
	})
})
