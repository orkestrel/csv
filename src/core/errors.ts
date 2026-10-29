import type { CSVErrorCode } from './types.js'
import { holds, INTRINSICS, isRecord } from '@orkestrel/contract'

// Invalid operations and programmer errors `throw`, always a `CSVError`
// carrying a machine-readable `code` so a `catch` branches on `error.code`
// instead of parsing the message. A parse-time malformation (an unterminated
// quote, a ragged row) is instead COLLECTED into `CSVParseResult.errors` /
// `CSVInterface.errors` unless `strict` is set, in which case it throws
// immediately.

/**
 * Represents an error surfaced by the CSV layer — either thrown for a
 * programmer error / `strict`-mode parse failure, or collected into a
 * result's `errors` list.
 *
 * @remarks
 * Carries a {@link CSVErrorCode} and, for a parse-time malformation, the
 * 1-based `line` / `column` and 0-based `offset` into the source text where
 * it was found, plus an optional `context` bag naming the offending field /
 * record.
 */
export class CSVError extends Error {
	readonly code: CSVErrorCode
	declare readonly line?: number
	declare readonly column?: number
	declare readonly offset?: number
	declare readonly context?: Readonly<Record<string, unknown>>

	constructor(
		code: CSVErrorCode,
		message: string,
		location?: Readonly<{
			readonly line?: number
			readonly column?: number
			readonly offset?: number
		}>,
		context?: Readonly<Record<string, unknown>>,
	) {
		super(message)
		INTRINSICS.define(this, Symbol.for('@orkestrel/csv.CSVError'), { value: this })
		this.name = 'CSVError'
		this.code = code
		if (location?.line !== undefined) this.line = location.line
		if (location?.column !== undefined) this.column = location.column
		if (location?.offset !== undefined) this.offset = location.offset
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught value to a {@link CSVError}.
 *
 * @remarks
 * Recognizes branded errors across package copies and subclasses by their code
 * and declared members. Refuses transparent proxies and unbranded look-alikes.
 *
 * @param value - The value to test (typically a `catch` binding)
 * @returns True if `value` is a {@link CSVError}; false otherwise
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
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		if (INTRINSICS.describe(value, Symbol.for('@orkestrel/csv.CSVError'))?.value !== value)
			return false
		const code: unknown = INTRINSICS.reflect.read(value, 'code')
		if (
			code !== 'UNTERMINATED_QUOTE' &&
			code !== 'BAD_QUOTE' &&
			code !== 'RAGGED_ROW' &&
			code !== 'DUPLICATE_HEADER' &&
			code !== 'EMPTY_HEADER' &&
			code !== 'LIMIT_EXCEEDED' &&
			code !== 'INVALID_OPTION'
		)
			return false
		const context: unknown = INTRINSICS.reflect.read(value, 'context')
		return (
			(context === undefined || isRecord(context)) &&
			['line', 'column', 'offset'].every((key) => {
				const member: unknown = INTRINSICS.reflect.read(value, key)
				return member === undefined || typeof member === 'number'
			})
		)
	})
}
