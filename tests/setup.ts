// Base test setup — environment-agnostic helpers loaded first by every
// Vitest project. Keep this file free of `node:*`, of `document` / `window` /
// Vue, AND guard-agnostic — it must NOT import from `@src/core` so it can be
// shared by tests that exercise different layers of the CSV surface.

// ── Deterministic randomness ──────────────────────────────────────────────────
// The single house seed for tests that need generated/random input. Keeping
// the seed centralized here means every suite that wants determinism uses the
// same starting point.
export const TEST_SEED = 42

// ── Assert-and-narrow ──────────────────────────────────────────────────────────

/**
 * Assert that `value` satisfies `guard` and return it narrowed to `T` —
 * throws with a clear message when the guard rejects, so a test reads the
 * narrowed value directly instead of an `as` cast or an `if`-guarded
 * `expect` (both AGENTS-forbidden; §1 / §16).
 *
 * @param guard - The total type guard to narrow with
 * @param value - The candidate value (typically a parse/render result)
 * @returns `value`, narrowed to `T`
 *
 * @example
 * ```ts
 * const row = assertAndNarrow(isRecord, parsed.rows[0])
 * ```
 */
export function assertAndNarrow<T>(guard: (value: unknown) => value is T, value: unknown): T {
	if (!guard(value))
		throw new Error(`expected value to satisfy guard, got ${JSON.stringify(value)}`)
	return value
}

// ── Deterministic adversarial CSV builders ────────────────────────────────────
// Pure string/data builders producing the classic CSV edge cases so parser
// and renderer tests share one source of adversarial fixtures instead of
// hand-rolling them inline.

/**
 * A quoted CSV field containing a delimiter, a CR, an LF, and an escaped
 * quote — the canonical field that forces quoting and exercises embedded
 * newline / escape handling in one fixture.
 *
 * @returns A single quoted CSV field, delimiter-and-newline-safe as written
 *
 * @example
 * ```ts
 * const field = buildQuotedField() // '"a,b\r\nc""d"'
 * ```
 */
export function buildQuotedField(): string {
	return '"a,b\r\nc""d"'
}

/**
 * A ragged CSV document — a three-column header, one row with fewer fields
 * than the header, and one row with more.
 *
 * @returns CSV text with a short row and a long row relative to its header
 *
 * @example
 * ```ts
 * const csv = buildRaggedCSV()
 * ```
 */
export function buildRaggedCSV(): string {
	return 'a,b,c\n1,2\n1,2,3,4'
}

/**
 * A CSV document whose records are separated by every newline convention in
 * one document — CRLF, bare LF, and bare CR.
 *
 * @returns CSV text mixing `\r\n`, `\n`, and `\r` record separators
 *
 * @example
 * ```ts
 * const csv = buildMixedNewlineCSV()
 * ```
 */
export function buildMixedNewlineCSV(): string {
	return 'a,b\r\n1,2\n3,4\r5,6'
}

/**
 * The classic type-inference trap strings — values that LOOK numeric or
 * boolean-ish but must not silently coerce in a naive inferrer (a leading
 * zero, a phone number, scientific notation, a hex literal, an
 * out-of-range integer, `NaN` / `Infinity` as text, an ambiguous date, a
 * decimal comma).
 *
 * @returns One header plus one row per trap value
 *
 * @example
 * ```ts
 * const csv = buildInferenceTraps()
 * ```
 */
export function buildInferenceTraps(): string {
	const traps = [
		'007',
		'+1 (555) 0123',
		'1e5',
		'0x1F',
		'9999999999999999999',
		'NaN',
		'Infinity',
		'01/02/03',
		'3,14',
	]
	return ['value', ...traps].join('\n')
}

// ── Call recorder (a real callback, not a mock) ──────────────────────────────
//
// AGENTS §16.1: when a test only needs to count calls or inspect arguments, use a
// recorder — a real listener that records every invocation — rather than a test-
// framework spy. `handler` is a genuine callback; `calls` is each invocation's
// argument tuple, in order.

/** A real call-recording callback over an argument tuple (AGENTS §16.1). */
export interface TestRecorderInterface<TArgs extends readonly unknown[]> {
	readonly calls: readonly TArgs[]
	readonly count: number
	readonly handler: (...args: TArgs) => void
	clear(): void
}

/**
 * Create a {@link TestRecorderInterface} — a real callback that records each
 * invocation's arguments, for asserting what fired and with what (AGENTS §16.1).
 *
 * @typeParam TArgs - The argument tuple the recorded handler receives
 * @returns A recorder whose `handler` records into `calls`
 */
export function createRecorder<TArgs extends readonly unknown[]>(): TestRecorderInterface<TArgs> {
	const calls: TArgs[] = []
	return {
		get calls() {
			return calls
		},
		get count() {
			return calls.length
		},
		handler(...args: TArgs) {
			calls.push(args)
		},
		clear() {
			calls.length = 0
		},
	}
}
