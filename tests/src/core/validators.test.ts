import { isCSVTable, isColumnType } from '@src/core'
import { describe, expect, it } from 'vitest'

// Every guard here is total (AGENTS section 14): never throws, returns
// `false` for any off-shape input. `isRow`'s own behavior (accepting a plain
// object literal or a null-prototype object, rejecting null/primitives/
// arrays/functions) is `@orkestrel/contract`'s `isRecord`, covered in that
// package's own suite - not retested here.

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

	// Leniency lock (residual-risk guard): `isCSVTable` delegates its row
	// check to `isRecord`, which accepts ANY object-shaped value regardless of
	// what its property values are - it never inspects cell contents or
	// forbids extra top-level keys. `csvTableShape` (shapers.ts) is stricter
	// by design. These two cases pin the lenient structural contract so a
	// future consolidation onto `csvTableShape` cannot happen silently.
	it('accepts a row holding a non-JSON value as a cell (leniency lock)', () => {
		expect(isCSVTable({ columns: ['a'], rows: [{ a: () => {} }] })).toBe(true)
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
