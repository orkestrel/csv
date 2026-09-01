import type { CSVParseResult, ParseOptions, Row } from './types.js'
import { MAX_ERRORS } from './constants.js'
import { CSVError } from './errors.js'
import { buildRow, deriveHeader, readRecords, resolveParseOptions } from './helpers.js'
import { inferRows } from './inferers.js'

// The table-building spine. `parseCSV` composes the tokenizer and
// table-builder leaves that live in `helpers.ts` - the kind file for a pure
// reusable leaf - into the one public parse entry point. This file is the
// coercer kind file, whose exported functions all carry the `parse` prefix.

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
