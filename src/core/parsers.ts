import type { CSVParseResult, ParseOptions, Row } from './types.js'
import {
	BOOLEAN_FALSE,
	BOOLEAN_TRUE,
	INTEGER_PATTERN,
	MAX_ERRORS,
	REAL_PATTERN,
} from './constants.js'
import { CSVError } from './errors.js'
import { buildRow, deriveHeader, readRecords, resolveParseOptions } from './helpers.js'
import { inferRows } from './inferers.js'

// The coercer kind file, whose exported functions all carry the `parse`
// prefix: the table-building spine `parseCSV`, which composes the tokenizer
// and table-builder leaves that live in `helpers.ts`, and the flat cell
// coercers every inferred column value passes through.
//
// Dependency direction: `helpers.ts` is the leaf beneath this file and never
// imports back. `inferers.ts` sits between the two - it consumes the flat
// coercers below and `parseCSV` consumes `inferRows` above, so the two files
// import each other. Both edges resolve at call time inside a function body,
// never at module initialization, so neither module reads a binding the other
// has not yet defined.

/**
 * Parses `input` into a typed {@link CSVParseResult} - header mapping,
 * ragged-row handling, and optional type inference on top of
 * {@link readRecords}, {@link deriveHeader}, {@link buildRow}, and
 * {@link inferRows}.
 *
 * @remarks
 * Every row is built with a null prototype (see {@link buildRow}), so a
 * hostile header name (`__proto__`, `constructor`, `prototype`) becomes a
 * plain own property that can never reach `Object.prototype`.
 * `options.limit` caps the number of DATA records - the header record (when
 * `header: true`) is exempt from the cap. `strict: true` throws at the point
 * the FIRST error is discovered - a tokenizer error immediately after
 * {@link readRecords} returns, a header error immediately after
 * {@link deriveHeader} returns, or a row-building error the instant it is
 * found while iterating the body in record order - instead of scanning to
 * completion and throwing `errors[0]`; the thrown error is identical to the
 * `errors[0]` a non-strict call would collect for the same input. Otherwise
 * `parseCSV` never throws on malformed data, and errors are returned in
 * discovery order - never sorted.
 *
 * @param input - The raw CSV text (BOM optional)
 * @param options - Parse options (see {@link resolveParseOptions})
 * @returns The parsed table plus any errors collected
 * @throws {CSVError} `INVALID_OPTION` - see {@link resolveParseOptions}; or,
 * when `strict` is `true`, the first collected parse error
 *
 * @example
 * ```ts
 * parseCSV('a,b\n1,2').table // { columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] }
 * ```
 */
export function parseCSV(input: string, options?: ParseOptions): CSVParseResult {
	const resolved = resolveParseOptions(options)
	// `limit` caps DATA records (see TSDoc above), but `readRecords` caps RAW
	// records header-agnostically - with `header: true` the header would
	// otherwise consume one slot from the cap. Bump the raw limit by one to
	// exempt the header record; `header: false` passes `options` through
	// unchanged since there is no header to exempt.
	const readOptions =
		resolved.header && resolved.limit > 0 ? { ...options, limit: resolved.limit + 1 } : options
	const { records, errors: tokenErrors } = readRecords(input, readOptions)

	if (resolved.strict) {
		const firstTokenError = tokenErrors[0]
		if (firstTokenError !== undefined) throw firstTokenError
	}

	const errors: CSVError[] = [...tokenErrors]

	const header = deriveHeader(records, resolved)
	if (resolved.strict) {
		const firstHeaderError = header.errors[0]
		if (firstHeaderError !== undefined) throw firstHeaderError
	}
	for (const error of header.errors) {
		if (errors.length < MAX_ERRORS) errors.push(error)
	}

	const rows: Row[] = []
	header.body.forEach((record, index) => {
		const result = buildRow(record, header.columns, resolved)
		if (result.row !== undefined) rows.push(result.row)
		if (result.error !== undefined) {
			const error = new CSVError(
				result.error.code,
				result.error.message,
				{
					...(result.error.line !== undefined ? { line: result.error.line } : {}),
					...(result.error.column !== undefined ? { column: result.error.column } : {}),
					...(result.error.offset !== undefined ? { offset: result.error.offset } : {}),
				},
				{ ...result.error.context, index },
			)
			if (resolved.strict) throw error
			if (errors.length < MAX_ERRORS) errors.push(error)
		}
	})

	const finalRows = resolved.infer ? inferRows(rows, header.columns) : rows

	return { table: { columns: header.columns, rows: finalRows }, errors }
}

/**
 * Parses a raw cell string into a canonical integer - `undefined` for anything
 * else (leading zeros, decimals, out-of-safe-range magnitude, non-numeric
 * text).
 *
 * @remarks
 * Stricter than `@orkestrel/contract`'s `parseInteger`, which returns `7` for
 * `'007'` and `10000000000000000000` for `'9999999999999999999'`. A CSV cell
 * carrying either is data a spreadsheet wrote verbatim, so this coercer
 * refuses it and the column stays text.
 *
 * @param value - The raw cell text
 * @returns The integer, or `undefined` when `value` is not a canonical
 * integer within `Number.isSafeInteger` range
 *
 * @example
 * ```ts
 * parseInteger('42')  // 42
 * parseInteger('007') // undefined
 * ```
 */
export function parseInteger(value: string): number | undefined {
	if (!INTEGER_PATTERN.test(value)) return undefined
	const number = Number(value)
	return Number.isSafeInteger(number) ? number : undefined
}

/**
 * Parses a raw cell string into a canonical decimal (or integer) - `undefined`
 * for anything else.
 *
 * @remarks
 * `@orkestrel/contract` exports no `parseReal`; its nearest equivalent is
 * `parseNumber`, which returns `7.5` for `'007.5'`. This coercer refuses a
 * leading zero and an unsafe integer part, so a canonical CSV cell is the only
 * text it accepts.
 *
 * @param value - The raw cell text
 * @returns The number, or `undefined` when `value` is not a canonical
 * integer/decimal, or its integer part is out of `Number.isSafeInteger` range
 *
 * @example
 * ```ts
 * parseReal('3.14') // 3.14
 * parseReal('42')   // 42
 * ```
 */
export function parseReal(value: string): number | undefined {
	if (INTEGER_PATTERN.test(value)) return parseInteger(value)
	return REAL_PATTERN.test(value) ? Number(value) : undefined
}

/**
 * Parses a raw cell string into a strict boolean - `undefined` for anything
 * other than the exact canonical forms.
 *
 * @remarks
 * Stricter than `@orkestrel/contract`'s `parseBoolean`, which also accepts
 * `'1'` and `'0'`. A CSV column of `1` and `0` is numeric data, so this
 * coercer leaves it to {@link parseInteger}.
 *
 * @param value - The raw cell text
 * @returns `true` for {@link BOOLEAN_TRUE}, `false` for {@link BOOLEAN_FALSE},
 * `undefined` otherwise
 *
 * @example
 * ```ts
 * parseBoolean('true')  // true
 * parseBoolean('True')  // undefined
 * ```
 */
export function parseBoolean(value: string): boolean | undefined {
	if (value === BOOLEAN_TRUE) return true
	if (value === BOOLEAN_FALSE) return false
	return undefined
}
