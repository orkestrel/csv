import { describe, expect, it } from 'vitest'
import {
	parseBoolean as contractParseBoolean,
	parseInteger as contractParseInteger,
	parseNumber as contractParseNumber,
} from '@orkestrel/contract'
import { MAX_ERRORS, isCSVError, parseBoolean, parseCSV, parseInteger, parseReal } from '@src/core'
import { captureError } from '@orkestrel/test'
import { assertAndNarrow } from '../../setup.js'

// The coercers parsers.ts declares - the `parseCSV` entry point and the flat
// cell coercers column inference dispatches to. The tokenizer and
// table-builder leaves parseCSV composes are declared in helpers.ts, and
// their describes live in that module's mirror.

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

describe("@orkestrel/contract parsers, compared against this package's own coercers", () => {
	it('parseInteger("007") reads 7 from @orkestrel/contract, undefined from this package', () => {
		expect(contractParseInteger('007')).toBe(7)
		expect(parseInteger('007')).toBeUndefined()
	})

	it('parseNumber("007.5") reads 7.5 from @orkestrel/contract; this package has no parseNumber, and its parseReal refuses the leading zero', () => {
		expect(contractParseNumber('007.5')).toBe(7.5)
		expect(parseReal('007.5')).toBeUndefined()
	})

	it('parseBoolean("1") and parseBoolean("0") read true/false from @orkestrel/contract, undefined from this package', () => {
		expect(contractParseBoolean('1')).toBe(true)
		expect(contractParseBoolean('0')).toBe(false)
		expect(parseBoolean('1')).toBeUndefined()
		expect(parseBoolean('0')).toBeUndefined()
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
		expect(() => parseCSV('a,b,c\n1,2', { strict: true, ragged: 'collect' })).toThrow(
			'record has fewer fields than columns',
		)
		const caught = captureError(() => parseCSV('a,b,c\n1,2', { strict: true, ragged: 'collect' }))
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
		const caught = captureError(() => parseCSV(input, { strict: true }))
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
		const caught = captureError(() => parseCSV(input, { strict: true, ragged: 'collect' }))
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
