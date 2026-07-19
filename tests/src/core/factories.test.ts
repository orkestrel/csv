import type { CsvInterface } from '@src/core'
import { createCsv, Csv } from '@src/core'
import { describe, expect, expectTypeOf, it } from 'vitest'

// The Csv factory — that `createCsv` returns a working CsvInterface
// backed by a real Csv instance.

describe('createCsv', () => {
	it('returns a Csv instance', () => {
		const instance = createCsv()

		expect(instance).toBeInstanceOf(Csv)
	})

	it('honors the id option', () => {
		const instance = createCsv({ id: 'example' })

		expect(instance.id).toBe('example')
	})

	it('createCsv returns a CsvInterface', () => {
		expectTypeOf(createCsv()).toEqualTypeOf<CsvInterface>()
	})
})
