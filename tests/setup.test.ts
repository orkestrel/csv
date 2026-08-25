// The shared test infrastructure's own proof. `tests/setup.ts` is the fixture module every
// Vitest project of this workspace loads first, so its narrowing helper and its adversarial
// CSV builders are the ground the parser and renderer suites stand on. Each contract below is
// asserted against a hand-written expectation or a runtime predicate, never against the
// builder that produced the value, so a fixture that drifts cannot agree with itself here.
//
// `tests/setup.ts` is host-independent by construction — it imports no `node:*` module, no DOM,
// and no production code — so the whole of its contract is reachable in the Node `setup`
// project and no half of it is deferred to another suite.
//
// The CSV semantics named here are the fixtures' own structure, read by splitting text. This
// file drives no parser and no renderer: what the package does with these documents is proved
// by the suites that consume them.

import { describe, expect, it } from 'vitest'
import {
	assertAndNarrow,
	buildInferenceTraps,
	buildMixedNewlineCSV,
	buildQuotedField,
	buildRaggedCSV,
	TEST_SEED,
} from './setup.js'

/** A row shape for the accepting case, so the narrowed result is read without a cast. */
interface NamedRow {
	readonly name: string
}

/** Accepts a record carrying a string `name`, and nothing else. */
function isNamedRow(value: unknown): value is NamedRow {
	return (
		typeof value === 'object' &&
		value !== null &&
		'name' in value &&
		typeof Reflect.get(value, 'name') === 'string'
	)
}

/** Accepts text, and nothing else. */
function isText(value: unknown): value is string {
	return typeof value === 'string'
}

/**
 * Reports whether a naive numeric read of `text` returns the same text — the coercion an
 * inference trap must defeat.
 */
function survivesNumericRead(text: string): boolean {
	const value = Number(text)
	return Number.isFinite(value) && String(value) === text
}

/** Reports whether `line` carries no characters. */
function isBlank(line: string): boolean {
	return line.length === 0
}

describe('TEST_SEED', () => {
	it('is a non-negative safe integer, so every suite seeds a generator from the same value', () => {
		expect(Number.isSafeInteger(TEST_SEED)).toBe(true)
		expect(TEST_SEED).toBeGreaterThanOrEqual(0)
	})
})

describe('assertAndNarrow', () => {
	it('returns the accepted value itself, narrowed to the guard type', () => {
		const value: unknown = { name: 'header' }

		const row = assertAndNarrow(isNamedRow, value)

		expect(row).toBe(value)
		expect(row.name).toBe('header')
	})

	it('defers to the guard rather than to a check of its own', () => {
		const value: unknown = { name: 'header' }

		expect(assertAndNarrow(isNamedRow, value)).toBe(value)
		expect(() => assertAndNarrow(isText, value)).toThrow(Error)
	})

	it('throws naming the refused value, so a failure reads without a debugger', () => {
		expect(() => assertAndNarrow(isText, { id: 7 })).toThrow(
			'expected value to satisfy guard, got {"id":7}',
		)
	})

	it('reports a refused value that JSON renders as nothing', () => {
		expect(() => assertAndNarrow(isText, undefined)).toThrow(
			'expected value to satisfy guard, got undefined',
		)
	})
})

describe('buildQuotedField', () => {
	it('wraps a body carrying a delimiter, a record separator, and an escaped quote', () => {
		const body = buildQuotedField().slice(1, -1)

		expect(buildQuotedField().startsWith('"')).toBe(true)
		expect(buildQuotedField().endsWith('"')).toBe(true)
		expect(body).toContain(',')
		expect(body).toContain('\r\n')
		expect(body).toContain('""')
	})

	it('escapes every quote in the body, so the fixture stays one field', () => {
		const body = buildQuotedField().slice(1, -1)

		expect(body.replaceAll('""', '')).not.toContain('"')
	})

	it('unescapes to the text the quoting exists to carry', () => {
		const body = buildQuotedField().slice(1, -1)

		expect(body.replaceAll('""', '"')).toBe('a,b\r\nc"d')
	})
})

describe('buildRaggedCSV', () => {
	it('follows its header with a row short of it and a row past it', () => {
		const lines = buildRaggedCSV().split('\n')
		const widths = lines.map((line) => line.split(',').length)
		const [header, short, long] = widths

		expect(widths).toHaveLength(3)
		expect(header).toBe(3)
		expect(short).toBeLessThan(3)
		expect(long).toBeGreaterThan(3)
	})

	it('quotes nothing, so a field count reads off a plain split', () => {
		expect(buildRaggedCSV()).not.toContain('"')
	})
})

describe('buildMixedNewlineCSV', () => {
	it('separates records with a CRLF, a bare LF, and a bare CR', () => {
		const csv = buildMixedNewlineCSV()

		expect(csv).toContain('\r\n')
		expect(/(?<!\r)\n/.test(csv)).toBe(true)
		expect(/\r(?!\n)/.test(csv)).toBe(true)
	})

	it('carries the same records whichever separator delimits them', () => {
		expect(buildMixedNewlineCSV().split(/\r\n|\n|\r/)).toEqual(['a,b', '1,2', '3,4', '5,6'])
	})
})

describe('buildInferenceTraps', () => {
	it('heads a single column named for the trapped value', () => {
		expect(buildInferenceTraps().split('\n')[0]).toBe('value')
	})

	it('lists only values a naive numeric read gets wrong', () => {
		const rows = buildInferenceTraps().split('\n').slice(1)

		expect(rows.filter(survivesNumericRead)).toEqual([])
	})

	it('carries the traps a consumer names, one per row and none blank', () => {
		const rows = buildInferenceTraps().split('\n').slice(1)

		expect(rows).toContain('007')
		expect(rows).toContain('1e5')
		expect(rows).toContain('0x1F')
		expect(rows).toContain('NaN')
		expect(rows.filter(isBlank)).toEqual([])
	})
})
