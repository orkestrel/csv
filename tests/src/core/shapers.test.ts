import type { ColumnType } from '@src/core'
import { columnTypeShape, csvTableShape, isCSVTable } from '@src/core'
import { createContract } from '@orkestrel/contract'
import { describe, expect, it } from 'vitest'

// Each shape here compiles (via createContract) into a guard / parser /
// schema / generator that must agree in lockstep (AGENTS section 14 / 16).

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

	it('agrees with isCSVTable across a shared fixture set (parse ↔ guard soundness, AGENTS §14)', () => {
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
