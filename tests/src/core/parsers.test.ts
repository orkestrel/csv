import { describe, expect, it } from 'vitest'
import { MAX_ERRORS, isCSVError, parseCSV, readRecords } from '@src/core'
import { assertAndNarrow, buildMixedNewlineCSV, buildQuotedField } from '../../setup.js'

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
		expect(records[2]?.line).toBe(3)
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

	it('reports each record\'s start line/column/offset', () => {
		const { records } = readRecords('a,b\n1,2')
		expect(records[0]).toMatchObject({ line: 1, column: 1, offset: 0 })
		expect(records[1]).toMatchObject({ line: 2, column: 1, offset: 4 })
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
})
