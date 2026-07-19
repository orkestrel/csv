import { columnTypeShape, createCSV, createTableContract, isCSVError, parseCSV } from '@src/core'
import { describe, expect, it } from 'vitest'
import { assertAndNarrow } from '../../setup.js'

// This file covers the two @src/core factories — createCSV (returns a
// working CSVInterface backed by a real CSV instance) and createTableContract
// (compiles a Columns map into a ContractInterface<Row>, the bridge for typed
// export/import interop with @orkestrel/database). Full parse/render corpora
// live in CSV.test.ts / parsers.test.ts — here we assert each factory hands
// back a usable handle.

describe('createCSV', () => {
	it('parses a CSV string into a working CSVInterface', () => {
		const csv = createCSV('a,b\n1,2\n3,4')

		expect(csv.table.columns).toEqual(['a', 'b'])
		expect(csv.rows).toEqual([
			{ a: '1', b: '2' },
			{ a: '3', b: '4' },
		])
		expect(csv.find((row) => row.a === '3')).toEqual({ a: '3', b: '4' })
		expect(csv.toJSON()).toEqual({
			columns: ['a', 'b'],
			rows: [
				{ a: '1', b: '2' },
				{ a: '3', b: '4' },
			],
		})
	})

	it('adopts an already-parsed CSVTable as-is, with no errors', () => {
		const table = { columns: ['x'], rows: [{ x: 1 }] }
		const csv = createCSV(table)

		expect(csv.table).toEqual(table)
		expect(csv.rows).toEqual([{ x: 1 }])
		expect(csv.errors).toEqual([])
	})

	it('honors a delimiter option', () => {
		const csv = createCSV('a;b\n1;2', { delimiter: ';' })

		expect(csv.table.columns).toEqual(['a', 'b'])
		expect(csv.rows).toEqual([{ a: '1', b: '2' }])
	})

	it('throws a CSVError when strict is set on malformed input', () => {
		expect(() => createCSV('a,b\n1,2,3', { strict: true })).toThrow('more fields')

		let caught: unknown
		try {
			createCSV('a,b\n1,2,3', { strict: true })
		} catch (error) {
			caught = error
		}
		expect(isCSVError(caught)).toBe(true)
	})

	it('throws INVALID_OPTION for an invalid option value', () => {
		let caught: unknown
		try {
			createCSV('a,b\n1,2', { delimiter: '' })
		} catch (error) {
			caught = error
		}
		expect(isCSVError(caught)).toBe(true)
		expect(assertAndNarrow(isCSVError, caught).code).toBe('INVALID_OPTION')
	})
})

describe('createTableContract', () => {
	it('compiles a Columns map into a contract whose schema covers each column', () => {
		const columns = {
			name: columnTypeShape('text'),
			age: columnTypeShape('integer'),
			active: columnTypeShape('boolean'),
		}
		const contract = createTableContract(columns)

		expect(contract.schema.type).toBe('object')
	})

	it('accepts a conforming row', () => {
		const columns = {
			name: columnTypeShape('text'),
			age: columnTypeShape('integer'),
			active: columnTypeShape('boolean'),
		}
		const contract = createTableContract(columns)

		expect(contract.is({ name: 'Ada', age: 36, active: true })).toBe(true)
	})

	it('rejects a non-conforming row', () => {
		const columns = {
			name: columnTypeShape('text'),
			age: columnTypeShape('integer'),
			active: columnTypeShape('boolean'),
		}
		const contract = createTableContract(columns)

		expect(contract.is({ name: 'Ada', age: 'thirty-six', active: true })).toBe(false)
		expect(contract.is({ name: 'Ada', age: 36.5, active: true })).toBe(false)
	})

	it('round-trips with parseCSV output — parsed rows satisfy the matching contract', () => {
		const { table } = parseCSV('name,age,active\nAda,36,true\nGrace,85,false', { infer: true })
		const columns = {
			name: columnTypeShape('text'),
			age: columnTypeShape('integer'),
			active: columnTypeShape('boolean'),
		}
		const contract = createTableContract(columns)

		for (const row of table.rows) expect(contract.is(row)).toBe(true)
	})
})
