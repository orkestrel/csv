import { describe, expect, it } from 'vitest'
import {
	MAX_ERRORS,
	buildRow,
	coerceInferred,
	deriveHeader,
	inferRows,
	isCSVError,
	parseBoolean,
	parseCSV,
	parseInteger,
	parseJSON,
	parseReal,
	readRecords,
	resolveParseOptions,
	scanBreak,
	scanComment,
	scanField,
	scanQuoted,
	scanRecord,
	scanUnquoted,
} from '@src/core'
import { assertAndNarrow, buildMixedNewlineCSV, buildQuotedField } from '../../setup.js'

const START = { offset: 0, line: 1, column: 1 }

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
	it('returns undefined when comment is disabled', () => {
		expect(scanComment('#hi\na', START, resolveParseOptions({ comment: false }))).toBeUndefined()
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

	it('handles a wholly empty line under blanks "keep" and "skip"', () => {
		const kept = readRecords('a,b\n\nc,d', { blanks: 'keep' })
		expect(kept.records).toHaveLength(3)
		expect(kept.records[1]?.fields).toEqual([{ value: '', quoted: false }])
		const skipped = readRecords('a,b\n\nc,d', { blanks: 'skip' })
		expect(skipped.records).toHaveLength(2)
	})

	it('does not treat a whitespace-only line as blank', () => {
		const { records } = readRecords('a,b\n   \nc,d', { blanks: 'skip' })
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

describe('parseInteger', () => {
	it('accepts a canonical integer', () => {
		expect(parseInteger('42')).toBe(42)
		expect(parseInteger('-7')).toBe(-7)
		expect(parseInteger('0')).toBe(0)
	})

	it('rejects leading zeros, decimals, and non-numeric text', () => {
		expect(parseInteger('007')).toBeUndefined()
		expect(parseInteger('3.14')).toBeUndefined()
		expect(parseInteger('abc')).toBeUndefined()
	})

	it('rejects an out-of-safe-range magnitude', () => {
		expect(parseInteger('9999999999999999999')).toBeUndefined()
		expect(parseInteger(String(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER)
	})
})

describe('parseReal', () => {
	it('accepts a canonical integer or decimal', () => {
		expect(parseReal('42')).toBe(42)
		expect(parseReal('3.14')).toBe(3.14)
		expect(parseReal('-0.5')).toBe(-0.5)
	})

	it('rejects an out-of-safe-range integer part', () => {
		expect(parseReal('9999999999999999999')).toBeUndefined()
	})

	it('rejects non-canonical text', () => {
		expect(parseReal('abc')).toBeUndefined()
		expect(parseReal('1e10')).toBeUndefined()
	})
})

describe('parseBoolean', () => {
	it('accepts the exact canonical forms', () => {
		expect(parseBoolean('true')).toBe(true)
		expect(parseBoolean('false')).toBe(false)
	})

	it('rejects anything else', () => {
		expect(parseBoolean('True')).toBeUndefined()
		expect(parseBoolean('1')).toBeUndefined()
	})
})

describe('parseJSON', () => {
	it('parses valid JSON', () => {
		expect(parseJSON('{"a":1}')).toEqual({ a: 1 })
		expect(parseJSON('[1,2]')).toEqual([1, 2])
	})

	it('returns undefined on failure', () => {
		expect(parseJSON('not json')).toBeUndefined()
	})
})

describe('coerceInferred', () => {
	it('dispatches per ColumnType', () => {
		expect(coerceInferred('42', 'integer')).toBe(42)
		expect(coerceInferred('3.14', 'real')).toBe(3.14)
		expect(coerceInferred('true', 'boolean')).toBe(true)
		expect(coerceInferred('hi', 'text')).toBe('hi')
	})
})

describe('inferRows', () => {
	it('coerces every cell of a column to its inferred type', () => {
		const rows = inferRows([{ a: '1' }, { a: '2' }], ['a'])
		expect(rows).toEqual([{ a: 1 }, { a: 2 }])
	})

	it('turns an empty-string cell into undefined for a non-text column', () => {
		const rows = inferRows([{ a: '1' }, { a: '' }], ['a'])
		expect(rows).toEqual([{ a: 1 }, { a: undefined }])
	})

	it('leaves a text column as strings, empty string included', () => {
		const rows = inferRows([{ a: 'x' }, { a: '' }], ['a'])
		expect(rows).toEqual([{ a: 'x' }, { a: '' }])
	})

	it('does not mutate the input rows', () => {
		const input = [{ a: '1' }]
		inferRows(input, ['a'])
		expect(input).toEqual([{ a: '1' }])
	})
})

describe('parseCSV', () => {
	it('handles ragged rows: "collect" pads/drops with context + RAGGED_ROW, positioned at the offending record', () => {
		const { table, errors } = parseCSV('a,b,c\n1,2\n1,2,3,4', { ragged: 'collect' })
		expect(table.rows).toHaveLength(2)
		expect(table.rows[0]).toEqual({ a: '1', b: '2', c: undefined })
		expect(table.rows[1]).toEqual({ a: '1', b: '2', c: '3' })
		expect(errors).toHaveLength(2)
		const short = errors.find((error) => error.context?.actual === 2)
		expect(short).toBeDefined()
		if (short === undefined) return
		expect(short.code).toBe('RAGGED_ROW')
		expect(short.context).toEqual({ expected: 3, actual: 2, index: 0 })
		expect(short.line).toBe(2)
		const long = errors.find((error) => error.context?.actual === 4)
		expect(long).toBeDefined()
		if (long === undefined) return
		expect(long.code).toBe('RAGGED_ROW')
		expect(long.context).toEqual({ expected: 3, actual: 4, index: 1, dropped: ['4'] })
		expect(long.line).toBe(3)
	})

	it('handles ragged rows: "pad" silently pads/truncates', () => {
		const { table, errors } = parseCSV('a,b,c\n1,2\n1,2,3,4', { ragged: 'pad' })
		expect(errors).toHaveLength(0)
		expect(table.rows[0]).toEqual({ a: '1', b: '2', c: undefined })
		expect(table.rows[1]).toEqual({ a: '1', b: '2', c: '3' })
	})

	it('handles ragged rows: "error" excludes the row and collects RAGGED_ROW', () => {
		const { table, errors } = parseCSV('a,b,c\n1,2\n1,2,3,4', { ragged: 'error' })
		expect(table.rows).toHaveLength(0)
		expect(errors).toHaveLength(2)
		expect(errors.every((error) => error.code === 'RAGGED_ROW')).toBe(true)
	})

	it('disambiguates duplicate headers and collects DUPLICATE_HEADER at the header record', () => {
		const { table, errors } = parseCSV('id,id,name\n1,2,3')
		expect(table.columns).toEqual(['id', 'id_2', 'name'])
		expect(errors).toHaveLength(1)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('DUPLICATE_HEADER')
		expect(error.context).toEqual({ name: 'id', index: 1 })
		expect(error.line).toBe(1)
	})

	it('collects EMPTY_HEADER for a blank header name at the header record', () => {
		const { table, errors } = parseCSV(',b\n1,2')
		expect(table.columns).toEqual(['column1', 'b'])
		expect(errors).toHaveLength(1)
		const error = errors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.code).toBe('EMPTY_HEADER')
		expect(error.context).toEqual({ index: 0 })
		expect(error.line).toBe(1)
	})

	it('yields zero rows for a header-only input, and an empty table for empty input', () => {
		const headerOnly = parseCSV('a,b,c')
		expect(headerOnly.table).toEqual({ columns: ['a', 'b', 'c'], rows: [] })
		const empty = parseCSV('')
		expect(empty.table).toEqual({ columns: [], rows: [] })
		expect(empty.errors).toEqual([])
	})

	it('never lets a hostile header pollute Object.prototype', () => {
		const { table } = parseCSV('x,__proto__,constructor\n1,2,3')
		const row = table.rows[0]
		expect(row).toBeDefined()
		if (row === undefined) return
		expect(Object.getOwnPropertyDescriptor(row, '__proto__')?.value).toBe('2')
		expect(row.constructor).toBe('3')
		const plain: Record<string, unknown> = {}
		expect(plain.polluted).toBeUndefined()
		expect(Object.getPrototypeOf({})).toBe(Object.prototype)
	})

	it('infers column types end-to-end; buildInferenceTraps stay text', () => {
		const inferred = parseCSV('value\n1\n2\n3', { infer: true })
		expect(inferred.table.rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }])

		const notInferred = parseCSV('value\n1\n2\n3', { infer: false })
		expect(notInferred.table.rows).toEqual([{ value: '1' }, { value: '2' }, { value: '3' }])
	})

	it('throws the first collected error when strict is true; collects otherwise', () => {
		expect(() => parseCSV('a,b,c\n1,2', { strict: true, ragged: 'collect' })).toThrowError(
			'record has fewer fields than columns',
		)
		let caught: unknown
		try {
			parseCSV('a,b,c\n1,2', { strict: true, ragged: 'collect' })
		} catch (error) {
			caught = error
		}
		const thrown = assertAndNarrow(isCSVError, caught)
		expect(thrown.code).toBe('RAGGED_ROW')

		const { errors } = parseCSV('a,b,c\n1,2', { strict: false, ragged: 'collect' })
		expect(errors).toHaveLength(1)
	})

	it('uses positional columns at the widest record when header is false', () => {
		const { table } = parseCSV('1,2\n1,2,3', { header: false })
		expect(table.columns).toEqual(['column1', 'column2', 'column3'])
		expect(table.rows).toEqual([
			{ column1: '1', column2: '2', column3: undefined },
			{ column1: '1', column2: '2', column3: '3' },
		])
	})

	it('limit caps DATA records, not the header — the header is exempt from the cap', () => {
		const { table, errors } = parseCSV('h1,h2\n1,2\n3,4', { limit: 2 })
		expect(table.rows).toHaveLength(2)
		expect(errors.filter((error) => error.code === 'LIMIT_EXCEEDED')).toHaveLength(0)
	})

	it('limit reports LIMIT_EXCEEDED at the first over-cap DATA record, header exempt', () => {
		const { table, errors } = parseCSV('h\na\nb\nc', { limit: 2 })
		expect(table.rows).toEqual([{ h: 'a' }, { h: 'b' }])
		const limitErrors = errors.filter((error) => error.code === 'LIMIT_EXCEEDED')
		expect(limitErrors).toHaveLength(1)
		const error = limitErrors[0]
		expect(error).toBeDefined()
		if (error === undefined) return
		expect(error.line).toBe(4)
	})

	it('limit with header: false caps records unchanged (no header to exempt)', () => {
		const { table, errors } = parseCSV('a\nb\nc', { header: false, limit: 2 })
		expect(table.rows).toHaveLength(2)
		expect(errors.filter((error) => error.code === 'LIMIT_EXCEEDED')).toHaveLength(1)
	})

	it('an empty-name column runs through the same collision resolver, losing no data', () => {
		const { table, errors } = parseCSV('column2,\nfirst,second')
		expect(table.columns).toEqual(['column2', 'column2_2'])
		expect(new Set(table.columns).size).toBe(table.columns.length)
		expect(table.rows).toEqual([{ column2: 'first', column2_2: 'second' }])
		expect(errors.some((error) => error.code === 'EMPTY_HEADER')).toBe(true)
	})

	it('strict:true fails fast on a tokenizer error — identical to the first error collected non-strict', () => {
		const input = 'a,b\nc,"unterminated'
		const nonStrict = parseCSV(input, { strict: false })
		const first = nonStrict.errors[0]
		expect(first).toBeDefined()
		if (first === undefined) return
		let caught: unknown
		try {
			parseCSV(input, { strict: true })
		} catch (error) {
			caught = error
		}
		const thrown = assertAndNarrow(isCSVError, caught)
		expect(thrown.code).toBe(first.code)
		expect(thrown.line).toBe(first.line)
		expect(thrown.column).toBe(first.column)
		expect(thrown.offset).toBe(first.offset)
	})

	it('strict:true fails fast on a table-building error (ragged row, clean tokenize) — identical to non-strict', () => {
		const input = 'a,b,c\n1,2'
		const nonStrict = parseCSV(input, { strict: false, ragged: 'collect' })
		const first = nonStrict.errors[0]
		expect(first).toBeDefined()
		if (first === undefined) return
		let caught: unknown
		try {
			parseCSV(input, { strict: true, ragged: 'collect' })
		} catch (error) {
			caught = error
		}
		const thrown = assertAndNarrow(isCSVError, caught)
		expect(thrown.code).toBe(first.code)
		expect(thrown.line).toBe(first.line)
		expect(thrown.column).toBe(first.column)
		expect(thrown.offset).toBe(first.offset)
	})

	it('caps collected errors at MAX_ERRORS while table-building degradation stays unaffected', () => {
		const rows: string[] = []
		for (let index = 0; index < MAX_ERRORS + 10; index += 1) rows.push('1,2')
		const input = `a,b,c\n${rows.join('\n')}`
		const { table, errors } = parseCSV(input, { ragged: 'collect' })
		expect(errors).toHaveLength(MAX_ERRORS)
		expect(errors.every((error) => error.code === 'RAGGED_ROW')).toBe(true)
		expect(table.rows).toHaveLength(MAX_ERRORS + 10)
		expect(table.rows.every((row) => row.a === '1' && row.b === '2' && row.c === undefined)).toBe(
			true,
		)
	})
})
