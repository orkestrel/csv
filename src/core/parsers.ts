import type {
	ColumnType,
	CSVParseResult,
	FieldScan,
	HeaderResult,
	ParseOptions,
	Position,
	RawField,
	RawRecord,
	RecordsResult,
	RecordScan,
	Row,
	RowResult,
} from './types.js'
import {
	BOM,
	BOOLEAN_FALSE,
	BOOLEAN_TRUE,
	INTEGER_PATTERN,
	MAX_ERRORS,
	POSITIONAL_COLUMN_PREFIX,
	REAL_PATTERN,
} from './constants.js'
import { CSVError } from './errors.js'
import { inferColumnType, resolveParseOptions, uniqueColumns } from './helpers.js'

// The CSV tokenizer + table-builder spine (AGENTS §5 / §14). Every step is a
// flat, exported leaf threading a `Position` through the source text - no
// nested function declarations, no recursion (CSV records never nest).
// `readRecords` / `parseCSV` are the orchestration spines that compose the
// leaves in sequence.

/**
 * Advance a {@link Position} by `count` NON-line-break characters.
 *
 * @param position - The starting position
 * @param count - The number of code units to advance (default `1`)
 * @returns The advanced position (`line` unchanged, `column`/`offset` shifted by `count`)
 *
 * @example
 * ```ts
 * advancePosition({ offset: 0, line: 1, column: 1 }) // { offset: 1, line: 1, column: 2 }
 * ```
 */
export function advancePosition(position: Position, count = 1): Position {
	return { offset: position.offset + count, line: position.line, column: position.column + count }
}

/**
 * Whether `char` starts a record separator (CR or LF).
 *
 * @param char - A single character
 * @returns `true` for `'\r'` or `'\n'`
 */
export function isBreakChar(char: string): boolean {
	return char === '\r' || char === '\n'
}

/**
 * Consume exactly one line break (CRLF, bare LF, or bare CR) at `position` -
 * a CRLF pair counts as ONE break.
 *
 * @param source - The source text
 * @param position - The position to test
 * @returns The position immediately after the break (next line, column `1`);
 * `undefined` when `position` is not at a break
 *
 * @example
 * ```ts
 * scanBreak('a\r\nb', { offset: 1, line: 1, column: 2 }) // { offset: 3, line: 2, column: 1 }
 * ```
 */
export function scanBreak(source: string, position: Position): Position | undefined {
	const char = source.charAt(position.offset)
	if (char === '\r') {
		const width = source.charAt(position.offset + 1) === '\n' ? 2 : 1
		return { offset: position.offset + width, line: position.line + 1, column: 1 }
	}
	if (char === '\n') return { offset: position.offset + 1, line: position.line + 1, column: 1 }
	return undefined
}

/**
 * Consume a comment line at `position`, when `options.comment` names one
 * starting there - through the end of that line INCLUDING its break (or
 * end-of-input).
 *
 * @param source - The source text
 * @param position - The position to test
 * @param options - The resolved parse options
 * @returns The position after the whole comment line; `undefined` when
 * `options.comment` is `false` or the text at `position` does not start with it
 *
 * @example
 * ```ts
 * scanComment('#hi\na', { offset: 0, line: 1, column: 1 }, resolveParseOptions({ comment: '#' }))
 * // { offset: 4, line: 2, column: 1 }
 * ```
 */
export function scanComment(
	source: string,
	position: Position,
	options: Required<ParseOptions>,
): Position | undefined {
	if (options.comment === false) return undefined
	if (!source.startsWith(options.comment, position.offset)) return undefined
	let cursor = position
	while (cursor.offset < source.length) {
		const brk = scanBreak(source, cursor)
		if (brk !== undefined) return brk
		cursor = advancePosition(cursor)
	}
	return cursor
}

/**
 * Scan one unquoted field starting at `position` - content runs until the
 * delimiter, a line break, or end-of-input.
 *
 * @remarks
 * A quote character appearing mid-field yields a `BAD_QUOTE` error (at that
 * character's position), kept literal in the value. `options.trim` strips
 * leading/trailing spaces and tabs (never full whitespace) from the result.
 *
 * @param source - The source text
 * @param position - The position to start scanning at
 * @param options - The resolved parse options
 * @returns The scanned field, the position immediately after it, and any errors found
 *
 * @example
 * ```ts
 * scanUnquoted('ab,c', { offset: 0, line: 1, column: 1 }, resolveParseOptions())
 * // { field: { value: 'ab', quoted: false }, next: {...}, errors: [] }
 * ```
 */
export function scanUnquoted(
	source: string,
	position: Position,
	options: Required<ParseOptions>,
): FieldScan {
	let cursor = position
	let value = ''
	const errors: CSVError[] = []
	while (cursor.offset < source.length) {
		const char = source.charAt(cursor.offset)
		if (char === options.delimiter || isBreakChar(char)) break
		if (char === options.quote)
			errors.push(new CSVError('BAD_QUOTE', 'quote character inside an unquoted field', cursor))
		value += char
		cursor = advancePosition(cursor)
	}
	const trimmed = options.trim ? value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') : value
	return { field: { value: trimmed, quoted: false }, next: cursor, errors }
}

/**
 * Scan one quoted field starting at `position` - `position` must be AT the
 * opening quote character.
 *
 * @remarks
 * Honors `options.escape`: `'double'` treats a doubled quote (`""`) as one
 * literal quote; `'backslash'` treats a backslash before the quote or another
 * backslash as an escape (a doubled quote is NOT an escape in this mode).
 * End-of-input before the closing quote yields `UNTERMINATED_QUOTE`
 * positioned at the OPENING quote, the field taking everything to
 * end-of-input. Text after the closing quote other than the delimiter, a
 * break, or end-of-input yields `BAD_QUOTE` at the offending character, with
 * the remainder up to the next delimiter/break appended literally.
 *
 * @param source - The source text
 * @param position - The position of the opening quote
 * @param options - The resolved parse options
 * @returns The scanned field, the position immediately after it, and any errors found
 *
 * @example
 * ```ts
 * scanQuoted('"ab"', { offset: 0, line: 1, column: 1 }, resolveParseOptions())
 * // { field: { value: 'ab', quoted: true }, next: {...}, errors: [] }
 * ```
 */
export function scanQuoted(
	source: string,
	position: Position,
	options: Required<ParseOptions>,
): FieldScan {
	const open = position
	let cursor = advancePosition(position) // consume the opening quote
	let value = ''
	while (true) {
		if (cursor.offset >= source.length) {
			const error = new CSVError('UNTERMINATED_QUOTE', 'quoted field never closed', open)
			return { field: { value, quoted: true }, next: cursor, errors: [error] }
		}
		const char = source.charAt(cursor.offset)

		if (options.escape === 'backslash' && char === '\\') {
			const after = source.charAt(cursor.offset + 1)
			if (after === options.quote || after === '\\') {
				value += after
				cursor = advancePosition(cursor, 2)
				continue
			}
			value += char
			cursor = advancePosition(cursor)
			continue
		}

		if (char === options.quote) {
			if (options.escape === 'double' && source.charAt(cursor.offset + 1) === options.quote) {
				value += options.quote
				cursor = advancePosition(cursor, 2)
				continue
			}
			cursor = advancePosition(cursor) // consume the closing quote
			if (cursor.offset >= source.length)
				return { field: { value, quoted: true }, next: cursor, errors: [] }
			const after = source.charAt(cursor.offset)
			if (after === options.delimiter || isBreakChar(after))
				return { field: { value, quoted: true }, next: cursor, errors: [] }
			const error = new CSVError('BAD_QUOTE', 'unexpected character after a closing quote', cursor)
			let tail = ''
			while (
				cursor.offset < source.length &&
				source.charAt(cursor.offset) !== options.delimiter &&
				!isBreakChar(source.charAt(cursor.offset))
			) {
				tail += source.charAt(cursor.offset)
				cursor = advancePosition(cursor)
			}
			return { field: { value: value + tail, quoted: true }, next: cursor, errors: [error] }
		}

		if (isBreakChar(char)) {
			// Not scanBreak: a quoted field keeps the literal break characters in
			// its value, and scanBreak only advances the cursor without yielding them.
			if (char === '\r' && source.charAt(cursor.offset + 1) === '\n') {
				value += '\r\n'
				cursor = { offset: cursor.offset + 2, line: cursor.line + 1, column: 1 }
			} else {
				value += char
				cursor = { offset: cursor.offset + 1, line: cursor.line + 1, column: 1 }
			}
			continue
		}

		value += char
		cursor = advancePosition(cursor)
	}
}

/**
 * Scan one field at `position` - dispatches to {@link scanQuoted} when the
 * character there is `options.quote`, else {@link scanUnquoted}.
 *
 * @param source - The source text
 * @param position - The position to start scanning at
 * @param options - The resolved parse options
 * @returns The scanned field, the position immediately after it, and any errors found
 */
export function scanField(
	source: string,
	position: Position,
	options: Required<ParseOptions>,
): FieldScan {
	return source.charAt(position.offset) === options.quote
		? scanQuoted(source, position, options)
		: scanUnquoted(source, position, options)
}

/**
 * Scan one full record at `position` - fields separated by
 * `options.delimiter`, ending at a break (consumed via {@link scanBreak}) or
 * end-of-input.
 *
 * @param source - The source text
 * @param position - The position the record starts at
 * @param options - The resolved parse options
 * @returns The scanned record (`record.start` is `position`), the position
 * immediately after it, and any errors found across its fields
 *
 * @example
 * ```ts
 * scanRecord('a,b\nc', { offset: 0, line: 1, column: 1 }, resolveParseOptions())
 * ```
 */
export function scanRecord(
	source: string,
	position: Position,
	options: Required<ParseOptions>,
): RecordScan {
	const fields: RawField[] = []
	const errors: CSVError[] = []
	let cursor = position
	while (true) {
		const scan = scanField(source, cursor, options)
		fields.push(scan.field)
		errors.push(...scan.errors)
		cursor = scan.next
		if (cursor.offset >= source.length) break
		if (source.charAt(cursor.offset) === options.delimiter) {
			cursor = advancePosition(cursor)
			continue
		}
		const brk = scanBreak(source, cursor)
		if (brk !== undefined) {
			cursor = brk
			break
		}
		break
	}
	return { record: { fields, start: position }, next: cursor, errors }
}

/**
 * Splits `input` into raw, un-mapped {@link RawRecord}s - the tokenizer phase
 * beneath {@link parseCSV}.
 *
 * @remarks
 * A single leading UTF-8 byte-order-mark is stripped before scanning; every
 * reported {@link Position} is relative to the text AFTER that removal. A
 * record separator at end-of-input does not produce a trailing empty
 * record, so a trailing-newline input and a no-trailing-newline input yield
 * identical records. Once {@link MAX_ERRORS} errors have been collected,
 * further malformations are silently no longer recorded - each leaf still
 * CONSTRUCTS its `CSVError` (the cap bounds the collected list, not leaf
 * allocation).
 *
 * @param input - The raw CSV text (BOM optional)
 * @param options - Parse options (see {@link resolveParseOptions}); `header`,
 * `ragged`, `infer`, and `strict` are ignored here - they apply only in
 * {@link parseCSV}
 * @returns The raw records plus any errors collected while splitting
 * @throws {CSVError} `INVALID_OPTION` - see {@link resolveParseOptions}
 *
 * @example
 * ```ts
 * readRecords('a,b\n1,2').records[0].fields // [{value:'a',quoted:false},{value:'b',quoted:false}]
 * ```
 */
export function readRecords(input: string, options?: ParseOptions): RecordsResult {
	const resolved = resolveParseOptions(options)
	const text = input.startsWith(BOM) ? input.slice(BOM.length) : input
	const errors: CSVError[] = []
	const records: RawRecord[] = []

	let position: Position = { offset: 0, line: 1, column: 1 }
	let emitted = 0
	let stopped = false

	while (position.offset < text.length && !stopped) {
		const recordStart = position

		const afterComment = scanComment(text, position, resolved)
		if (afterComment !== undefined) {
			position = afterComment
			continue
		}

		const scan = scanRecord(text, position, resolved)
		for (const error of scan.errors) {
			if (errors.length < MAX_ERRORS) errors.push(error)
		}
		position = scan.next

		const first = scan.record.fields[0]
		const isBlank =
			scan.record.fields.length === 1 && first !== undefined && !first.quoted && first.value === ''
		if (isBlank && resolved.blanks === 'skip') continue

		if (resolved.limit > 0 && emitted >= resolved.limit) {
			if (errors.length < MAX_ERRORS)
				errors.push(new CSVError('LIMIT_EXCEEDED', 'record limit exceeded', recordStart))
			stopped = true
			break
		}

		records.push(scan.record)
		emitted += 1
	}

	return { records, errors }
}

/**
 * Resolve a table's header from its raw records - disambiguates the first
 * record's names when `options.header` is `true`, or generates positional
 * names sized to the widest record otherwise.
 *
 * @remarks
 * `header: true` disambiguates via {@link uniqueColumns}, collecting
 * `EMPTY_HEADER` for a blank raw name and `DUPLICATE_HEADER` for a repeat of
 * an earlier raw name, both positioned at the header record's
 * {@link Position}. `header: false` generates positional names sized to the
 * widest record, and every record is body.
 *
 * @param records - The raw records (from {@link readRecords})
 * @param options - The resolved parse options
 * @returns The resolved columns, the body records (header excluded), and any
 * header errors
 *
 * @example
 * ```ts
 * deriveHeader(readRecords('a,a\n1,2').records, resolveParseOptions())
 * // { columns: ['a', 'a_2'], body: [...], errors: [...] }
 * ```
 */
export function deriveHeader(
	records: readonly RawRecord[],
	options: Required<ParseOptions>,
): HeaderResult {
	if (!options.header) {
		const width = records.reduce((max, record) => Math.max(max, record.fields.length), 0)
		const columns = Array.from(
			{ length: width },
			(_, index) => `${POSITIONAL_COLUMN_PREFIX}${index + 1}`,
		)
		return { columns, body: records, errors: [] }
	}

	const first = records[0]
	if (first === undefined) return { columns: [], body: [], errors: [] }

	const rawNames = first.fields.map((field) => field.value)
	const columns = uniqueColumns(rawNames)
	const errors: CSVError[] = []
	const seen: string[] = []
	rawNames.forEach((name, index) => {
		if (name.trim() === '') {
			errors.push(new CSVError('EMPTY_HEADER', 'header name is empty', first.start, { index }))
		} else if (seen.includes(name)) {
			errors.push(
				new CSVError('DUPLICATE_HEADER', 'header name repeats an earlier one', first.start, {
					name,
					index,
				}),
			)
		}
		seen.push(name)
	})

	return { columns, body: records.slice(1), errors }
}

/**
 * Build one {@link RawRecord} into one null-prototype {@link Row}, padding or
 * truncating to `columns.length` per `options.ragged`.
 *
 * @remarks
 * `'pad'` pads/truncates silently (no error). `'collect'` pads/truncates AND
 * collects a `RAGGED_ROW` error (with `dropped` values in its context for an
 * over-wide record), positioned at `record.start`. `'error'` omits the row
 * entirely (only the error is returned).
 *
 * @param record - The raw record to build
 * @param columns - The resolved column order
 * @param options - The resolved parse options
 * @returns The built row and/or the ragged-row error
 *
 * @example
 * ```ts
 * buildRow(readRecords('1,2').records[0], ['a', 'b', 'c'], resolveParseOptions())
 * // { row: { a: '1', b: '2', c: undefined }, error: CSVError('RAGGED_ROW', ...) }
 * ```
 */
export function buildRow(
	record: RawRecord,
	columns: readonly string[],
	options: Required<ParseOptions>,
): RowResult {
	const width = columns.length
	const fields = record.fields
	const actual = fields.length
	const row: Row = Object.create(null)
	for (let position = 0; position < width; position += 1) {
		const columnName = columns[position]
		if (columnName === undefined) continue
		const field = fields[position]
		row[columnName] = field === undefined ? undefined : field.value
	}

	if (actual === width) return { row }

	if (actual < width) {
		if (options.ragged === 'pad') return { row }
		const error = new CSVError('RAGGED_ROW', 'record has fewer fields than columns', record.start, {
			expected: width,
			actual,
		})
		return options.ragged === 'error' ? { error } : { row, error }
	}

	if (options.ragged === 'pad') return { row }
	const dropped = fields.slice(width).map((field) => field.value)
	const error = new CSVError('RAGGED_ROW', 'record has more fields than columns', record.start, {
		expected: width,
		actual,
		dropped,
	})
	return options.ragged === 'error' ? { error } : { row, error }
}

/**
 * Coerce one string cell to `type`'s typed representation - the exhaustive
 * per-cell dispatch {@link inferRows} applies once a column's type is known.
 *
 * @param value - The raw cell text
 * @param type - The column's inferred {@link ColumnType} (never `'json'` /
 * `'blob'` - those are never inferred, and pass through unchanged like
 * `'text'`)
 * @returns The typed value, via {@link parseInteger} / {@link parseReal} /
 * {@link parseBoolean}; `value` unchanged for `'text'` (or the unreachable
 * `'json'` / `'blob'`)
 */
export function coerceInferred(value: string, type: ColumnType): unknown {
	switch (type) {
		case 'integer':
			return parseInteger(value)
		case 'real':
			return parseReal(value)
		case 'boolean':
			return parseBoolean(value)
		case 'text':
		case 'json':
		case 'blob':
			return value
	}
}

/**
 * Apply whole-column type inference to a built row set - per column, infers
 * its {@link ColumnType} from its string cells, then coerces every cell of
 * that type via {@link coerceInferred}.
 *
 * @remarks
 * An empty-string cell becomes `undefined` for any non-`'text'` column
 * (there is nothing to coerce). Copy-on-write - `rows` is never mutated;
 * a fresh row set is returned.
 *
 * @param rows - The built rows (from {@link buildRow})
 * @param columns - The resolved column order
 * @returns A new row set with every column's cells coerced to its inferred type
 *
 * @example
 * ```ts
 * inferRows([{ a: '1' }, { a: '2' }], ['a']) // [{ a: 1 }, { a: 2 }]
 * ```
 */
export function inferRows(rows: readonly Row[], columns: readonly string[]): readonly Row[] {
	const types = columns.map((column) => {
		const values: string[] = []
		for (const row of rows) {
			const value = row[column]
			if (typeof value === 'string') values.push(value)
		}
		return inferColumnType(values)
	})

	return rows.map((row) => {
		const next: Row = Object.create(null)
		for (const key of Object.keys(row)) next[key] = row[key]
		columns.forEach((column, position) => {
			const value = row[column]
			const type = types[position]
			if (typeof value !== 'string' || type === undefined) return
			next[column] = value === '' && type !== 'text' ? undefined : coerceInferred(value, type)
		})
		return next
	})
}

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
				{ line: result.error.line, column: result.error.column, offset: result.error.offset },
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
 * Coerce a raw cell string to a canonical integer - `undefined` for anything
 * else (leading zeros, decimals, out-of-safe-range magnitude, non-numeric text).
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
 * Coerce a raw cell string to a canonical decimal (or integer) - `undefined`
 * for anything else.
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
 * Coerce a raw cell string to a strict boolean - `undefined` for anything
 * other than the exact canonical forms.
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

/**
 * Coerce a raw cell string to a parsed JSON value - `undefined` on failure.
 *
 * @param value - The raw cell text
 * @returns The parsed value, or `undefined` when `value` is not valid JSON
 *
 * @example
 * ```ts
 * parseJSON('{"a":1}')  // { a: 1 }
 * parseJSON('not json') // undefined
 * ```
 */
export function parseJSON(value: string): unknown {
	try {
		return JSON.parse(value)
	} catch {
		return undefined
	}
}
