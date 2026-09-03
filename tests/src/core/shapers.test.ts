import type { ColumnType } from '@src/core'
import { columnTypeShape, csvTableShape, deriveShapes, isCSVTable } from '@src/core'
import { createContract } from '@orkestrel/contract'
import { requireValue } from '@orkestrel/test'
import { describe, expect, it } from 'vitest'

// Each shape here compiles (via createContract) into a guard / parser /
// schema / generator that must agree in lockstep.

describe('columnTypeShape', () => {
	const types: readonly ColumnType[] = ['text', 'integer', 'real', 'boolean', 'json', 'blob']

	it('produces a shape for every ColumnType member', () => {
		for (const type of types) {
			expect(columnTypeShape(type)).toBeDefined()
		}
	})

	it('text: accepts a string, rejects a number', () => {
		const contract = createContract(columnTypeShape('text'))
		expect(contract.is('x')).toBe(true)
		expect(contract.is(5)).toBe(false)
	})

	it('integer: accepts a whole number, rejects a fractional number', () => {
		const contract = createContract(columnTypeShape('integer'))
		expect(contract.is(5)).toBe(true)
		expect(contract.is(5.5)).toBe(false)
	})

	it('real: accepts both whole and fractional numbers, rejects a string', () => {
		const contract = createContract(columnTypeShape('real'))
		expect(contract.is(5)).toBe(true)
		expect(contract.is(5.5)).toBe(true)
		expect(contract.is('5.5')).toBe(false)
	})

	it('boolean: accepts true/false, rejects a truthy number', () => {
		const contract = createContract(columnTypeShape('boolean'))
		expect(contract.is(true)).toBe(true)
		expect(contract.is(false)).toBe(true)
		expect(contract.is(1)).toBe(false)
	})

	it('json: accepts nested objects and arrays', () => {
		const contract = createContract(columnTypeShape('json'))
		expect(contract.is({ a: [1, 2, { b: 'x' }] })).toBe(true)
		expect(contract.is([1, 'x', null])).toBe(true)
	})

	it('blob: accepts a string (CSV carries blobs as text)', () => {
		const contract = createContract(columnTypeShape('blob'))
		expect(contract.is('binary-as-text')).toBe(true)
		expect(contract.is(5)).toBe(false)
	})
})

describe('csvTableShape', () => {
	const contract = createContract(csvTableShape)

	it('accepts a real CSVTable value', () => {
		expect(contract.is({ columns: ['a', 'b'], rows: [{ a: 1, b: 'x' }] })).toBe(true)
	})

	it('accepts an empty table', () => {
		expect(contract.is({ columns: [], rows: [] })).toBe(true)
	})

	it('rejects columns of the wrong type', () => {
		expect(contract.is({ columns: 'a', rows: [] })).toBe(false)
	})

	it('rejects rows containing primitives instead of records', () => {
		expect(contract.is({ columns: ['a'], rows: ['not-a-row'] })).toBe(false)
		expect(contract.is({ columns: ['a'], rows: [1, 2] })).toBe(false)
	})

	it('rejects a value missing required keys', () => {
		expect(contract.is({ columns: ['a'] })).toBe(false)
		expect(contract.is({ rows: [] })).toBe(false)
	})

	it('agrees with isCSVTable across a shared fixture set (parse ↔ guard soundness)', () => {
		const fixtures: readonly unknown[] = [
			{ columns: ['a', 'b'], rows: [{ a: 1, b: 'x' }] },
			{ columns: ['a'], rows: [Object.assign(Object.create(null), { a: 1 })] },
			{},
			{ columns: 'x' },
			{ columns: [], rows: [1] },
			null,
			[],
		]
		for (const fixture of fixtures) {
			expect(contract.is(fixture)).toBe(isCSVTable(fixture))
		}
	})
})

describe('deriveShapes', () => {
	it('derives text for a column with no non-empty cells', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: '' }, { a: undefined }] })
		const contract = createContract(requireValue(columns.a, 'no shape derived for column a'))
		expect(contract.is('x')).toBe(true)
		expect(contract.is(5)).toBe(false)
	})

	it('derives an inferred type for an all-string column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: '1' }, { a: '2' }] })
		const contract = createContract(requireValue(columns.a, 'no shape derived for column a'))
		expect(contract.is(1)).toBe(true)
		expect(contract.is(1.5)).toBe(false)
	})

	it('derives integer/real for an all-number column', () => {
		const integer = deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 2 }] })
		const integerContract = createContract(requireValue(integer.a, 'no shape derived for column a'))
		expect(integerContract.is(2)).toBe(true)
		expect(integerContract.is(2.5)).toBe(false)
		const real = deriveShapes({ columns: ['a'], rows: [{ a: 1.5 }] })
		const realContract = createContract(requireValue(real.a, 'no shape derived for column a'))
		expect(realContract.is(1.5)).toBe(true)
	})

	it('derives boolean for an all-boolean column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: true }, { a: false }] })
		const contract = createContract(requireValue(columns.a, 'no shape derived for column a'))
		expect(contract.is(true)).toBe(true)
		expect(contract.is(1)).toBe(false)
	})

	it('derives json for a mixed column', () => {
		const columns = deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 'x' }] })
		const contract = createContract(requireValue(columns.a, 'no shape derived for column a'))
		expect(contract.is(1)).toBe(true)
		expect(contract.is('x')).toBe(true)
	})
})
