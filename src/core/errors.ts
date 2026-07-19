import type { CSVErrorCode } from './types.js'

// AGENTS §12: invalid operations and programmer errors `throw`, always a
// `CSVError` carrying a machine-readable `code` so a `catch` branches on
// `error.code` instead of parsing the message. A parse-time malformation
// (an unterminated quote, a ragged row) is instead COLLECTED into
// `CSVParseResult.errors` / `CSVInterface.errors` unless `strict` is set, in
// which case it throws immediately.

/**
 * An error surfaced by the CSV layer - either thrown for a programmer error /
 * `strict`-mode parse failure, or collected into a result's `errors` list.
 *
 * @remarks
 * Carries a {@link CSVErrorCode} and, for a parse-time malformation, the
 * 1-based `line` / `column` and 0-based `offset` into the source text where
 * it was found, plus an optional `context` bag naming the offending field /
 * record.
 */
export class CSVError extends Error {
	readonly code: CSVErrorCode
	readonly line?: number
	readonly column?: number
	readonly offset?: number
	readonly context?: Readonly<Record<string, unknown>>

	constructor(
		code: CSVErrorCode,
		message: string,
		location?: Readonly<{ readonly line?: number; readonly column?: number; readonly offset?: number }>,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		this.name = 'CSVError'
		this.code = code
		this.line = location?.line
		this.column = location?.column
		this.offset = location?.offset
		this.context = context
	}
}

/**
 * Narrow an unknown caught value to a {@link CSVError}.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns `true` when `value` is a {@link CSVError}
 *
 * @example
 * ```ts
 * try {
 * 	parseCSV(text, { strict: true })
 * } catch (error) {
 * 	if (isCSVError(error) && error.code === 'RAGGED_ROW') console.warn(error.line)
 * }
 * ```
 */
export function isCSVError(value: unknown): value is CSVError {
	return value instanceof CSVError
}
