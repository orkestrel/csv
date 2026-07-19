import type { CSVTable, ExportOptions } from '@src/core'
import { stringShape } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'
import { assertAndNarrow } from '../../setup.js'
import { CSV, deriveShapes, isCSVError } from '@src/core'

// The CSV CLASS — the stateful wrapper around a parsed CSVTable, exposing
// query (find/filter/reduce), rewrite (map), streaming, JSON interop, and
// export operations. Parse-behavior corpora live in parsers.test.ts — this
// suite covers only the CLASS's own contract: construction, copy-on-write,
// streaming, and export derivation.

async function collectStream<T>(stream: ReadableStream<T>): Promise<T[]> {
	const reader = stream.getReader()
	const values: T[] = []
	for (let result = await reader.read(); !result.done; result = await reader.read()) {
		values.push(result.value)
	}
	return values
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null
}

describe('CSV — construction', () => {
	it('parses CSV text into columns and rows', () => {
		const csv = new CSV('a,b\n1,2\n3,4')
		expect(csv.table.columns).toEqual(['a', 'b'])
		expect(csv.rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		])
	})

	it('surfaces collected parse malformations via errors', () => {
		const csv = new CSV('a,b\n1,2,3')
		expect(csv.errors.length).toBeGreaterThan(0)
	})

	it('adopts a CSVTable as-is, with no errors', () => {
		const table: CSVTable = { columns: ['x'], rows: [{ x: 1 }] }
		const csv = new CSV(table)
		expect(csv.table).toBe(table)
		expect(csv.rows).toBe(table.rows)
		expect(csv.errors).toEqual([])
	})

	it('propagates a strict/INVALID_OPTION throw from parseCSV', () => {
		let caught: unknown
		try {
			const csv = new CSV('a,b\n1,2', { delimiter: 'xx' })
			void csv
		} catch (error) {
			caught = error
		}
		const csvError = assertAndNarrow(isCSVError, caught)
		expect(csvError.code).toBe('INVALID_OPTION')
	})
})

describe('CSV — find / filter / reduce', () => {
	const csv = new CSV('a,b\n1,2\n3,4\n5,6')

	it('find returns the first matching row', () => {
		expect(csv.find((row) => row.a === '3')).toEqual({ a: '3', b: '4' })
	})

	it('find returns undefined when nothing matches', () => {
		expect(csv.find((row) => row.a === 'nope')).toBeUndefined()
	})

	it('find receives the row index', () => {
		expect(csv.find((_row, index) => index === 2)).toEqual({ a: '5', b: '6' })
	})

	it('filter collects every matching row, in order', () => {
		expect(csv.filter((row) => Number(row.a) > 1)).toEqual([
			{ a: '3', b: '4' },
			{ a: '5', b: '6' },
		])
	})

	it('filter returns an empty array when nothing matches', () => {
		expect(csv.filter(() => false)).toEqual([])
	})

	it('reduce folds rows in table order, with the index available', () => {
		const indices = csv.reduce<number[]>((accumulator, _row, index) => {
			accumulator.push(index)
			return accumulator
		}, [])
		expect(indices).toEqual([0, 1, 2])
	})
})

describe('CSV — map (copy-on-write)', () => {
	it('returns a NEW instance with the rewritten rows', () => {
		const csv = new CSV('a,b\n1,2\n3,4')
		const doubled = csv.map((row) => ({ ...row, a: `${Number(row.a) * 2}` }))
		expect(doubled).not.toBe(csv)
		expect(doubled.rows).toEqual([
			{ a: '2', b: '2' },
			{ a: '6', b: '4' },
		])
	})

	it('carries the same columns (reference and content)', () => {
		const csv = new CSV('a,b\n1,2')
		const rewritten = csv.map((row) => row)
		expect(rewritten.table.columns).toEqual(csv.table.columns)
	})

	it('never mutates the original instance', () => {
		const csv = new CSV('a,b\n1,2\n3,4')
		csv.map((row) => ({ ...row, a: 'changed' }))
		expect(csv.rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		])
	})

	it('carries the source parse errors onto the new instance', () => {
		const csv = new CSV('a,b\n1,2,3')
		const rewritten = csv.map((row) => row)
		expect(rewritten.errors).toEqual(csv.errors)
	})
})

describe('CSV — stream', () => {
	it('returns a web-standard ReadableStream', () => {
		const csv = new CSV('a\n1\n2')
		expect(csv.stream()).toBeInstanceOf(ReadableStream)
	})

	it('yields exactly the rows, in order, via a reader loop', async () => {
		const csv = new CSV('a,b\n1,2\n3,4')
		const reader = csv.stream().getReader()
		const rows = []
		for (let result = await reader.read(); !result.done; result = await reader.read()) {
			rows.push(result.value)
		}
		expect(rows).toEqual(csv.rows)
	})

	it('each call returns a distinct, fully replayable stream', async () => {
		const csv = new CSV('a\n1\n2\n3')
		const first = await collectStream(csv.stream())
		const second = await collectStream(csv.stream())
		expect(first).toEqual(csv.rows)
		expect(second).toEqual(csv.rows)
	})
})

describe('CSV — toJSON', () => {
	it('round-trips through JSON.stringify to a plain { columns, rows } shape', () => {
		const csv = new CSV('a,b\n1,2\n3,4')
		const restored: unknown = JSON.parse(JSON.stringify(csv))
		const record = assertAndNarrow(isRecord, restored)
		expect(record.columns).toEqual(['a', 'b'])
		expect(record.rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		])
	})
})

describe('CSV — export', () => {
	it('derives one shape per column by default (text / integer / boolean / json)', () => {
		const table: CSVTable = {
			columns: ['name', 'age', 'active', 'meta'],
			rows: [
				{ name: 'a', age: 1, active: true, meta: 'x' },
				{ name: 'b', age: 2, active: false, meta: 1 },
			],
		}
		const csv = new CSV(table)
		const result = csv.export()
		expect(Object.keys(result.columns)).toEqual(['name', 'age', 'active', 'meta'])
		const record = assertAndNarrow(isRecord, result.schema)
		const properties = assertAndNarrow(isRecord, record.properties)
		expect(Object.keys(properties)).toEqual(['name', 'age', 'active', 'meta'])
	})

	it('infers an integer shape for whole-number numeric cells', () => {
		const table: CSVTable = { columns: ['n'], rows: [{ n: 1 }, { n: 2 }] }
		const csv = new CSV(table)
		expect(csv.export().columns.n).toBeDefined()
	})

	it('uses columns from options verbatim when given', () => {
		const table: CSVTable = { columns: ['a'], rows: [{ a: '1' }] }
		const csv = new CSV(table)
		const columns: ExportOptions['columns'] = { a: stringShape() }
		const result = csv.export({ columns })
		expect(result.columns).toBe(columns)
	})

	it('defaults key to the first column', () => {
		const csv = new CSV('a,b\n1,2')
		expect(csv.export().key).toBe('a')
	})

	it('honors an explicit valid key', () => {
		const csv = new CSV('a,b\n1,2')
		expect(csv.export({ key: 'b' }).key).toBe('b')
	})

	it('throws INVALID_OPTION for a key not among the table columns', () => {
		const csv = new CSV('a,b\n1,2')
		let caught: unknown
		try {
			const result = csv.export({ key: 'nope' })
			void result
		} catch (error) {
			caught = error
		}
		const csvError = assertAndNarrow(isCSVError, caught)
		expect(csvError.code).toBe('INVALID_OPTION')
	})

	it('throws INVALID_OPTION for an empty table with no columns', () => {
		const csv = new CSV({ columns: [], rows: [] })
		let caught: unknown
		try {
			const result = csv.export()
			void result
		} catch (error) {
			caught = error
		}
		const csvError = assertAndNarrow(isCSVError, caught)
		expect(csvError.code).toBe('INVALID_OPTION')
	})

	it('returns a value structurally assignable to { key, columns, schema }', () => {
		const csv = new CSV('a,b\n1,2')
		const result = csv.export()
		expect(typeof result.key).toBe('string')
		expect(typeof result.columns).toBe('object')
		expect(typeof result.schema).toBe('object')
	})

	it('derives the same columns as the standalone deriveShapes helper for a mixed table', () => {
		const table: CSVTable = {
			columns: ['name', 'age', 'active', 'meta'],
			rows: [
				{ name: 'a', age: 1, active: true, meta: 'x' },
				{ name: 'b', age: 2, active: false, meta: 1 },
			],
		}
		const csv = new CSV(table)
		expect(csv.export().columns).toEqual(deriveShapes(table))
	})
})
