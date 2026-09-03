import { coerceInferred, inferColumnType, inferRows } from '@src/core'
import { buildInferenceTraps } from '../../setup.js'
import { describe, expect, it } from 'vitest'

describe('inferColumnType', () => {
	it('infers integer for whole-number cells', () => {
		expect(inferColumnType(['1', '2', '3'])).toBe('integer')
	})

	it('infers real when integers and decimals mix', () => {
		expect(inferColumnType(['1', '2.5', '3'])).toBe('real')
	})

	it('infers boolean when every cell is true/false', () => {
		expect(inferColumnType(['true', 'false', 'true'])).toBe('boolean')
	})

	it('ignores empty cells rather than demoting', () => {
		expect(inferColumnType(['1', '', '2'])).toBe('integer')
		expect(inferColumnType(['', '', ''])).toBe('text')
		expect(inferColumnType([])).toBe('text')
	})

	it('demotes an out-of-safe-range integer to text', () => {
		expect(inferColumnType(['9999999999999999999'])).toBe('text')
		expect(inferColumnType([String(Number.MAX_SAFE_INTEGER)])).toBe('integer')
	})

	it('demotes every classic inference trap to text', () => {
		const lines = buildInferenceTraps().split('\n')
		const [header, ...traps] = lines
		expect(header).toBe('value')
		for (const trap of traps) {
			expect(inferColumnType([trap])).toBe('text')
		}
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
