import { CSVError, isCSVError } from '@src/core'
import { describe, expect, it } from 'vitest'

describe('isCSVError', () => {
	it('accepts a class-instance context', () => {
		class Context {
			readonly [key: string]: unknown
			readonly offset = 8
		}

		const context: Readonly<Record<string, unknown>> = new Context()
		expect(isCSVError(new CSVError('BAD_QUOTE', 'quoted field', undefined, context))).toBe(true)
	})

	it('accepts a callable context', () => {
		const members: Readonly<Record<string, unknown>> = { offset: 8 }
		const context = Object.assign(() => undefined, members)
		expect(isCSVError(new CSVError('BAD_QUOTE', 'quoted field', undefined, context))).toBe(true)
	})
})
