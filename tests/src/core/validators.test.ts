import { isCSVTable, isColumnType, isRow, isRowList } from '@src/core'
import { describe, expect, it } from 'vitest'

// Every guard here is total (AGENTS section 14): never throws, returns
// `false` for any off-shape input.

describe('isRow', () => {
	it('accepts a plain object literal, empty or populated', () => {
		expect(isRow({})).toBe(true)
		expect(isRow({ a: 1 })).toBe(true)
	})

	it('accepts a null-prototype object (the parser deliberately produces these)', () => {
		const nullProto = Object.create(null)
		nullProto.a = 1
		expect(isRow(nullProto)).toBe(true)
		expect(isRow(Object.create(null))).toBe(true)
	})

	it('rejects null, undefined, and primitives', () => {
		expect(isRow(null)).toBe(false)
		expect(isRow(undefined)).toBe(false)
		expect(isRow(42)).toBe(false)
		expect(isRow('x')).toBe(false)
	})

	it('rejects arrays and functions', () => {
		expect(isRow([])).toBe(false)
		expect(isRow(() => {})).toBe(false)
	})
})

describe('isCSVTable', () => {
	it('accepts a well-formed table', () => {
		expect(isCSVTable({ columns: ['a', 'b'], rows: [{ a: 1, b: 'x' }] })).toBe(true)
	})

	it('accepts a table whose rows include a null-prototype row', () => {
		const nullProtoRow = Object.create(null)
		nullProtoRow.a = 1
		expect(isCSVTable({ columns: ['a'], rows: [nullProtoRow] })).toBe(true)
	})

	it('rejects rows containing an array instead of a row record', () => {
		expect(isCSVTable({ columns: ['a'], rows: [[1, 2]] })).toBe(false)
	})

	it('rejects columns containing a number instead of a string', () => {
		expect(isCSVTable({ columns: ['a', 1], rows: [] })).toBe(false)
	})

	it('rejects a value missing required keys', () => {
		expect(isCSVTable({ columns: ['a'] })).toBe(false)
		expect(isCSVTable({ rows: [] })).toBe(false)
		expect(isCSVTable({})).toBe(false)
	})

	it('rejects non-object and null values', () => {
		expect(isCSVTable(null)).toBe(false)
		expect(isCSVTable(undefined)).toBe(false)
		expect(isCSVTable('table')).toBe(false)
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

describe('isColumnType', () => {
	it('accepts all six ColumnType literals', () => {
		expect(isColumnType('text')).toBe(true)
		expect(isColumnType('integer')).toBe(true)
		expect(isColumnType('real')).toBe(true)
		expect(isColumnType('boolean')).toBe(true)
		expect(isColumnType('json')).toBe(true)
		expect(isColumnType('blob')).toBe(true)
	})

	it('rejects an unknown literal, empty string, null, and a number', () => {
		expect(isColumnType('float')).toBe(false)
		expect(isColumnType('')).toBe(false)
		expect(isColumnType(null)).toBe(false)
		expect(isColumnType(7)).toBe(false)
	})
})
