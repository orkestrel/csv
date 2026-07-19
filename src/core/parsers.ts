import type {
	CSVParseResult,
	ParseOptions,
	RawField,
	RawRecord,
	RecordsResult,
	Row,
} from './types.js'
import { MAX_ERRORS } from './constants.js'
import { CSVError } from './errors.js'
import {
	coerceCell,
	inferColumnType,
	positionalColumns,
	resolveParseOptions,
	stripBom,
	uniqueColumns,
} from './helpers.js'

// The CSV tokenizer + table-builder spine (AGENTS §5 / §14). `readRecords` is
// a hand-written, single-pass character scanner - no regex, linear time.
// `parseCSV` builds on it to assemble the typed `CSVTable`. Every internal
// step is a nested inner function (the markdown `renderCSV`-style pattern) so
// the only exported surface for this engine is the two functions themselves.

/**
 * Splits `input` into raw, un-mapped {@link RawRecord}s - the tokenizer phase
 * beneath {@link parseCSV}. A hand-written, linear-time character scanner: no
 * regex, one pass over the text.
 *
 * @remarks
 * A single leading UTF-8 byte-order-mark is stripped before scanning; every
 * reported `line` (1-based), `column` (1-based, in UTF-16 code units), and
 * `offset` (0-based, a UTF-16 code-unit index) is relative to the text AFTER
 * that removal. A CRLF pair counts as
 * ONE line break; a bare LF or bare CR each count as one. A record separator
 * at end-of-input does not produce a trailing empty record, so a
 * trailing-newline input and a no-trailing-newline input yield identical
 * records. Once {@link MAX_ERRORS} errors have been collected, further
 * malformations are silently no longer recorded (scanning still continues).
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
	const text = stripBom(input)
	const length = text.length
	const errors: CSVError[] = []
	const records: RawRecord[] = []

	// Lazy-build the error: `build` is invoked only when under `MAX_ERRORS`, so
	// a discarded-past-cap error never allocates its `CSVError` (or any data it
	// closes over, e.g. a `dropped` field list).
	function pushError(build: () => CSVError): void {
		if (errors.length < MAX_ERRORS) errors.push(build())
	}

	let index = 0
	let line = 1
	let column = 1

	// Advances the cursor over `count` NON-line-break characters.
	function advance(count = 1): void {
		index += count
		column += count
	}

	// Returns whether `char` starts a record separator (CR or LF).
	function isBreakChar(char: string): boolean {
		return char === '\r' || char === '\n'
	}

	// Consumes ONE record separator at the cursor (CRLF as a pair, else a
	// single CR or LF) and advances `line`/`column`. Returns `false` (and
	// consumes nothing) when the cursor is not at a separator.
	function consumeBreak(): boolean {
		if (index >= length) return false
		const char = text.charAt(index)
		if (char === '\r') {
			index += text.charAt(index + 1) === '\n' ? 2 : 1
			line += 1
			column = 1
			return true
		}
		if (char === '\n') {
			index += 1
			line += 1
			column = 1
			return true
		}
		return false
	}

	// Strips leading/trailing spaces and tabs (never full-whitespace) - the
	// `trim` option applies to unquoted values only.
	function trimSpacesTabs(value: string): string {
		let start = 0
		let end = value.length
		while (start < end && (value.charAt(start) === ' ' || value.charAt(start) === '\t')) start += 1
		while (end > start && (value.charAt(end - 1) === ' ' || value.charAt(end - 1) === '\t'))
			end -= 1
		return value.slice(start, end)
	}

	// Scans one unquoted field - content runs until the delimiter, a record
	// separator, or end-of-input. A quote char appearing mid-field (never at
	// the start, which routes to `parseQuotedField` instead) is BAD_QUOTE'd
	// and kept as a literal character.
	function parseUnquotedField(): RawField {
		let value = ''
		while (index < length) {
			const char = text.charAt(index)
			if (char === resolved.delimiter || isBreakChar(char)) break
			if (char === resolved.quote) {
				pushError(
					() =>
						new CSVError('BAD_QUOTE', 'quote character inside an unquoted field', {
							line,
							column,
							offset: index,
						}),
				)
			}
			value += char
			advance()
		}
		return { value, quoted: false }
	}

	// Scans one quoted field, opened because the quote char was the first
	// character of the field. Embedded record separators are content,
	// preserved verbatim. Handles both escape styles, an illegal char after
	// the closing quote (BAD_QUOTE, degrade-to-EOF-of-field), and an
	// end-of-input before the closing quote (UNTERMINATED_QUOTE).
	function parseQuotedField(): RawField {
		const openLine = line
		const openColumn = column
		const openOffset = index
		advance() // consume the opening quote
		let value = ''
		while (true) {
			if (index >= length) {
				pushError(
					() =>
						new CSVError('UNTERMINATED_QUOTE', 'quoted field never closed', {
							line: openLine,
							column: openColumn,
							offset: openOffset,
						}),
				)
				return { value, quoted: true }
			}
			const char = text.charAt(index)
			if (resolved.escape === 'backslash' && char === '\\') {
				const next = text.charAt(index + 1)
				if (next === resolved.quote || next === '\\') {
					value += next
					advance(2)
					continue
				}
				value += char
				advance()
				continue
			}
			if (char === resolved.quote) {
				if (resolved.escape === 'double' && text.charAt(index + 1) === resolved.quote) {
					value += resolved.quote
					advance(2)
					continue
				}
				advance() // consume the closing quote
				if (index >= length) return { value, quoted: true }
				const after = text.charAt(index)
				if (after === resolved.delimiter || isBreakChar(after)) return { value, quoted: true }
				pushError(
					() =>
						new CSVError('BAD_QUOTE', 'unexpected character after a closing quote', {
							line,
							column,
							offset: index,
						}),
				)
				while (
					index < length &&
					text.charAt(index) !== resolved.delimiter &&
					!isBreakChar(text.charAt(index))
				) {
					value += text.charAt(index)
					advance()
				}
				return { value, quoted: true }
			}
			if (isBreakChar(char)) {
				if (char === '\r' && text.charAt(index + 1) === '\n') {
					value += '\r\n'
					index += 2
				} else {
					value += char
					index += 1
				}
				line += 1
				column = 1
				continue
			}
			value += char
			advance()
		}
	}

	function parseField(): RawField {
		return text.charAt(index) === resolved.quote ? parseQuotedField() : parseUnquotedField()
	}

	let emitted = 0
	let stopped = false
	while (index < length && !stopped) {
		const recordLine = line
		const recordColumn = column
		const recordOffset = index

		if (resolved.comment !== false && text.startsWith(resolved.comment, index)) {
			while (index < length && !consumeBreak()) advance()
			continue
		}

		const rawFields: RawField[] = []
		while (true) {
			rawFields.push(parseField())
			if (index >= length) break
			if (text.charAt(index) === resolved.delimiter) {
				advance()
				continue
			}
			if (consumeBreak()) break
			break
		}

		const first = rawFields[0]
		const isBlank =
			rawFields.length === 1 && first !== undefined && !first.quoted && first.value === ''
		if (isBlank && resolved.blanks === 'skip') continue

		if (resolved.limit > 0 && emitted >= resolved.limit) {
			pushError(
				() =>
					new CSVError('LIMIT_EXCEEDED', 'record limit exceeded', {
						line: recordLine,
						column: recordColumn,
						offset: recordOffset,
					}),
			)
			stopped = true
			break
		}

		records.push({
			fields: rawFields.map((field) => ({
				value: resolved.trim && !field.quoted ? trimSpacesTabs(field.value) : field.value,
				quoted: field.quoted,
			})),
			line: recordLine,
			column: recordColumn,
			offset: recordOffset,
		})
		emitted += 1
	}

	return { records, errors }
}

/**
 * Parses `input` into a typed {@link CSVParseResult} - header mapping,
 * ragged-row handling, and optional type inference on top of
 * {@link readRecords}.
 *
 * @remarks
 * Every row is built with a null prototype (`Object.create(null)`), so a
 * hostile header name (`__proto__`, `constructor`, `prototype`) becomes a
 * plain own property that can never reach `Object.prototype`. `header: true`
 * disambiguates the first record's names via {@link uniqueColumns}, collecting
 * `EMPTY_HEADER` for a blank name and `DUPLICATE_HEADER` for a repeat of an
 * earlier raw name. `header: false` uses {@link positionalColumns} sized to
 * the widest record. A ragged data record is handled per `options.ragged`
 * (`'collect'` pads/drops and records `RAGGED_ROW`; `'pad'` does the same
 * silently; `'error'` excludes the row and records `RAGGED_ROW`). When
 * `infer` is `true`, every column is re-typed (via {@link inferColumnType} /
 * {@link coerceCell}) after all rows are built. `strict: true` throws at the
 * point the FIRST error is discovered - a tokenizer error immediately after
 * {@link readRecords} returns (before any header/row-building/inference
 * work), or a header/row-building error the instant it would otherwise be
 * collected - instead of scanning to completion and throwing `errors[0]`;
 * the thrown error is identical to the `errors[0]` a non-strict call would
 * collect for the same input. Otherwise `parseCSV` never throws on malformed
 * data, and errors are returned in discovery order - never sorted.
 * `options.limit` caps the number of DATA records - the header record (when
 * `header: true`) is exempt from the cap.
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

	// Fail fast: under `strict`, throw the very first error in discovery
	// order - a tokenizer error always precedes any table-building error - the
	// instant it is known, before any header/row-building/inference work runs.
	if (resolved.strict) {
		const firstTokenError = tokenErrors[0]
		if (firstTokenError !== undefined) throw firstTokenError
	}

	const errors: CSVError[] = [...tokenErrors]

	// Lazy-build the error: under `strict` this throws `build()` the instant
	// it is called (so the FIRST table-building error thrown is identical to
	// today's collected `errors[0]`); otherwise `build` runs only when under
	// `MAX_ERRORS`, so a discarded-past-cap error (and any data it closes
	// over, e.g. a `dropped` field list) never allocates.
	function pushError(build: () => CSVError): void {
		if (resolved.strict) throw build()
		if (errors.length < MAX_ERRORS) errors.push(build())
	}

	function resolveHeader(source: readonly RawRecord[]): {
		readonly columns: readonly string[]
		readonly dataRecords: readonly RawRecord[]
	} {
		if (!resolved.header) {
			const width = source.reduce((max, record) => Math.max(max, record.fields.length), 0)
			return { columns: positionalColumns(width), dataRecords: source }
		}
		const first = source[0]
		if (first === undefined) return { columns: [], dataRecords: [] }
		const location = { line: first.line, column: first.column, offset: first.offset }
		const rawNames = first.fields.map((field) => field.value)
		const columns = uniqueColumns(rawNames)
		const seen: string[] = []
		rawNames.forEach((name, position) => {
			if (name.trim() === '') {
				pushError(
					() => new CSVError('EMPTY_HEADER', 'header name is empty', location, { index: position }),
				)
			} else if (seen.includes(name)) {
				pushError(
					() =>
						new CSVError('DUPLICATE_HEADER', 'header name repeats an earlier one', location, {
							name,
							index: position,
						}),
				)
			}
			seen.push(name)
		})
		return { columns, dataRecords: source.slice(1) }
	}

	// Builds one data record into a null-prototype `Row`, padding/dropping to
	// match the column count `columns.length` per `options.ragged`.
	function buildRow(
		record: RawRecord,
		columns: readonly string[],
		position: number,
	): Row | undefined {
		const width = columns.length
		const fields = record.fields
		const actual = fields.length
		const row: Row = Object.create(null)
		const location = { line: record.line, column: record.column, offset: record.offset }

		if (actual < width) {
			if (resolved.ragged !== 'pad') {
				pushError(
					() =>
						new CSVError('RAGGED_ROW', 'record has fewer fields than columns', location, {
							expected: width,
							actual,
							index: position,
						}),
				)
			}
			if (resolved.ragged === 'error') return undefined
			for (let column = 0; column < width; column += 1) {
				const columnName = columns[column]
				if (columnName === undefined) continue
				const field = fields[column]
				row[columnName] = field === undefined ? undefined : field.value
			}
			return row
		}

		if (actual > width) {
			if (resolved.ragged !== 'pad') {
				pushError(
					() =>
						new CSVError('RAGGED_ROW', 'record has more fields than columns', location, {
							expected: width,
							actual,
							dropped: fields.slice(width).map((field) => field.value),
							index: position,
						}),
				)
			}
			if (resolved.ragged === 'error') return undefined
			for (let column = 0; column < width; column += 1) {
				const columnName = columns[column]
				if (columnName === undefined) continue
				const field = fields[column]
				row[columnName] = field === undefined ? undefined : field.value
			}
			return row
		}

		for (let column = 0; column < width; column += 1) {
			const columnName = columns[column]
			if (columnName === undefined) continue
			const field = fields[column]
			row[columnName] = field === undefined ? undefined : field.value
		}
		return row
	}

	// Re-types every cell (via `inferColumnType` / `coerceCell`) once all rows
	// are built - mutates `rows` in place, a construction-time step on our own
	// output, not on an input parameter.
	function applyInference(columns: readonly string[], rows: readonly Row[]): void {
		const types = columns.map((column) => {
			const values: string[] = []
			for (const row of rows) {
				const value = row[column]
				if (typeof value === 'string') values.push(value)
			}
			return inferColumnType(values)
		})
		rows.forEach((row) => {
			columns.forEach((column, position) => {
				const value = row[column]
				const type = types[position]
				if (typeof value === 'string' && type !== undefined) row[column] = coerceCell(value, type)
			})
		})
	}

	const { columns, dataRecords } = resolveHeader(records)
	const rows: Row[] = []
	dataRecords.forEach((record, position) => {
		const row = buildRow(record, columns, position)
		if (row !== undefined) rows.push(row)
	})

	if (resolved.infer) applyInference(columns, rows)

	return { table: { columns, rows }, errors }
}
