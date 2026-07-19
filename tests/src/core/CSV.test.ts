import type { CsvInterface } from '@src/core'
import { Csv } from '@src/core'
import { describe, expect, it } from 'vitest'

// The Csv entity — id assignment (explicit / generated) and independence
// across instances. Factory-level assertions live in factories.test.ts.

describe('Csv', () => {
	it('round-trips an explicit id', () => {
		const instance: CsvInterface = new Csv({ id: 'example' })

		expect(instance.id).toBe('example')
	})

	it('generates a non-empty id when none is given', () => {
		const instance = new Csv()

		expect(typeof instance.id).toBe('string')
		expect(instance.id.length).toBeGreaterThan(0)
	})

	it('gives distinct instances distinct generated ids', () => {
		const a = new Csv()
		const b = new Csv()

		expect(a.id).not.toBe(b.id)
	})
})
