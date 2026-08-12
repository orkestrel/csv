import type {
	Columns,
	CSVTable,
	ColumnType,
	FieldScan,
	HeaderResult,
	ParseOptions,
	Position,
	RawField,
	RawRecord,
	RecordScan,
	RecordsResult,
	RenderOptions,
	ResolvedRenderOptions,
	Row,
	RowResult,
} from './types.js'
import {
	BOM,
	BOOLEAN_FALSE,
	BOOLEAN_TRUE,
	DEFAULT_PARSE_OPTIONS,
	DEFAULT_RENDER_OPTIONS,
	INTEGER_PATTERN,
	MAX_ERRORS,
	NUMERIC_PATTERN,
	POSITIONAL_COLUMN_PREFIX,
	REAL_PATTERN,
	SANITIZE_ESCAPE,
	SANITIZE_PREFIXES,
	SUFFIX_SEPARATOR,
} from './constants.js'
import { CSVError } from './errors.js'
import { columnTypeShape } from './shapers.js'
import { isRowList } from './validators.js'

// Pure, total helper leaves the parser / renderer compose (AGENTS §5 / §14).
// Every function here is a functional-core leaf: referentially transparent,
// touching no external state, and (aside from the two option resolvers,
// which throw on a programmer error per AGENTS §12) never throwing.
//
// Dependency direction: `parsers.ts` imports the option resolvers, the
// tokenizer and table-builder leaves, and the coercers from this file, so
// this file must NEVER import back from `parsers.ts` (that would be a cycle).

/**
 * Validate a delimiter / quote pair shared by both {@link resolveParseOptions}
 * and {@link resolveRenderOptions} - each must be exactly one character, they
 * must differ, and neither may be CR, LF, or the BOM character.
 *
 * @param delimiter - The candidate field delimiter
 * @param quote - The candidate quote character
 * @throws {CSVError} `INVALID_OPTION` when any rule above is violated
 *
 * @example
 * ```ts
 * assertValidSeparators(',', '"') // does not throw
 * ```
 */
export function assertValidSeparators(delimiter: string, quote: string): void {
	if (delimiter.length !== 1)
		throw new CSVError('INVALID_OPTION', 'delimiter must be exactly one character')
	if (quote.length !== 1)
		throw new CSVError('INVALID_OPTION', 'quote must be exactly one character')
	if (delimiter === quote)
		throw new CSVError('INVALID_OPTION', 'delimiter and quote must not be the same character')
	const forbidden: ReadonlySet<string> = new Set(['\r', '\n', BOM])
	if (forbidden.has(delimiter))
		throw new CSVError('INVALID_OPTION', 'delimiter must not be CR, LF, or a byte-order-mark')
	if (forbidden.has(quote))
		throw new CSVError('INVALID_OPTION', 'quote must not be CR, LF, or a byte-order-mark')
}

/**
 * Merge `options` over {@link DEFAULT_PARSE_OPTIONS} into a fully-resolved
 * parse configuration.
 *
 * @param options - The caller's partial {@link ParseOptions}
 * @returns The resolved options, every member defaulted
 * @throws {CSVError} `INVALID_OPTION` when `delimiter` / `quote` are invalid
 * (see {@link assertValidSeparators}), `comment` is an empty string, or
 * `limit` is negative or not a finite integer
 *
 * @example
 * ```ts
 * resolveParseOptions({ delimiter: ';' }).delimiter // ';'
 * ```
 */
export function resolveParseOptions(options?: ParseOptions): Required<ParseOptions> {
	const resolved = { ...DEFAULT_PARSE_OPTIONS, ...options }
	assertValidSeparators(resolved.delimiter, resolved.quote)
	if (resolved.comment === '')
		throw new CSVError('INVALID_OPTION', 'comment must not be an empty string')
	if (!Number.isInteger(resolved.limit) || resolved.limit < 0)
		throw new CSVError('INVALID_OPTION', 'limit must be a non-negative integer')
	return resolved
}

/**
 * Merge `options` over {@link DEFAULT_RENDER_OPTIONS} into a fully-resolved
 * render configuration.
 *
 * @param options - The caller's partial {@link RenderOptions}
 * @returns The resolved options (`columns` stays optional - it has no default)
 * @throws {CSVError} `INVALID_OPTION` when `delimiter` / `quote` are invalid
 * (see {@link assertValidSeparators}), or `newline` is anything other than
 * `'\n'` or `'\r\n'`
 *
 * @example
 * ```ts
 * resolveRenderOptions({ newline: '\n' }).newline // '\n'
 * ```
 */
export function resolveRenderOptions(options?: RenderOptions): ResolvedRenderOptions {
	const resolved = { ...DEFAULT_RENDER_OPTIONS, ...options }
	assertValidSeparators(resolved.delimiter, resolved.quote)
	if (resolved.newline !== '\n' && resolved.newline !== '\r\n')
		throw new CSVError('INVALID_OPTION', "newline must be '\\n' or '\\r\\n'")
	return resolved
}

/**
 * Conservatively infer a whole column's {@link ColumnType} from its raw
 * string values - never `'json'` or `'blob'` (those require an explicit
 * {@link Columns} declaration). Empty-string cells are ignored entirely (they
 * neither confirm nor demote a type); a column with no non-empty cells is
 * `'text'`.
 *
 * @param values - The column's raw cell values, in row order
 * @returns `'boolean'` when every non-empty cell is exactly `'true'` /
 * `'false'`; `'integer'` when every non-empty cell is a canonical integer
 * within `Number.isSafeInteger` range; `'real'` when every non-empty cell is
 * a canonical integer or decimal (with the same safe-magnitude rule applied
 * to its integer-pattern cells); `'text'` otherwise
 *
 * @example
 * ```ts
 * inferColumnType(['1', '2', '3'])     // 'integer'
 * inferColumnType(['1', '2.5'])        // 'real'
 * inferColumnType(['true', 'false'])   // 'boolean'
 * inferColumnType(['007', '1'])        // 'text'
 * ```
 */
export function inferColumnType(values: readonly string[]): ColumnType {
	const cells = values.filter((value) => value !== '')
	if (cells.length === 0) return 'text'

	if (cells.every((value) => value === BOOLEAN_TRUE || value === BOOLEAN_FALSE)) return 'boolean'

	let hasDecimal = false
	for (const value of cells) {
		if (INTEGER_PATTERN.test(value)) {
			if (!Number.isSafeInteger(Number(value))) return 'text'
			continue
		}
		if (REAL_PATTERN.test(value)) {
			hasDecimal = true
			continue
		}
		return 'text'
	}
	return hasDecimal ? 'real' : 'integer'
}

/**
 * Disambiguate a single column name against the names already taken - the
 * collision leaf {@link uniqueColumns} composes over an entire header.
 *
 * @param name - The candidate name
 * @param taken - The names already claimed
 * @returns `name` unchanged when not in `taken`; otherwise `name` suffixed
 * `_2`, `_3`, … (see {@link SUFFIX_SEPARATOR}) until a form not in `taken` is found
 *
 * @example
 * ```ts
 * uniqueName('a', new Set(['a']))         // 'a_2'
 * uniqueName('a', new Set(['a', 'a_2']))  // 'a_3'
 * ```
 */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
	if (!taken.has(name)) return name
	let suffix = 2
	let candidate = `${name}${SUFFIX_SEPARATOR}${suffix}`
	while (taken.has(candidate)) {
		suffix += 1
		candidate = `${name}${SUFFIX_SEPARATOR}${suffix}`
	}
	return candidate
}

/**
 * Deterministically disambiguate a header's column names - an empty (or
 * whitespace-only) name becomes positional, and a name that repeats an
 * earlier kept name is suffixed `_2`, `_3`, … until unique.
 *
 * @param names - The raw header names, in column order
 * @returns The disambiguated names, in the same order
 *
 * @example
 * ```ts
 * uniqueColumns(['a', 'a', ''])  // ['a', 'a_2', 'column3']
 * uniqueColumns(['a', 'a', 'a_2']) // ['a', 'a_2', 'a_2_2']
 * ```
 */
export function uniqueColumns(names: readonly string[]): readonly string[] {
	const kept: string[] = []
	const seen = new Set<string>()
	for (const [index, name] of names.entries()) {
		const base = name.trim() === '' ? `${POSITIONAL_COLUMN_PREFIX}${index + 1}` : name
		const unique = uniqueName(base, seen)
		kept.push(unique)
		seen.add(unique)
	}
	return kept
}

/**
 * Guard a field against CSV/spreadsheet formula injection (the OWASP
 * CSV-injection guidance) - a field starting with a formula-triggering
 * character is prefixed with a protective {@link SANITIZE_ESCAPE}.
 *
 * @param field - The raw field text (already stringified, not yet quoted)
 * @returns `field` prefixed with {@link SANITIZE_ESCAPE} when it starts with
 * `=`, `@`, tab, CR, or LF, or with `+` / `-` UNLESS the whole field is a
 * plain signed number; unchanged otherwise
 *
 * @example
 * ```ts
 * sanitizeField('=SUM(A1)')       // "'=SUM(A1)"
 * sanitizeField('+3.14')          // '+3.14' (a plain number, untouched)
 * sanitizeField('+1 (555) 0123')  // "'+1 (555) 0123"
 * ```
 */
export function sanitizeField(field: string): string {
	const first = field.charAt(0)
	if (first === '' || !SANITIZE_PREFIXES.has(first)) return field
	if ((first === '+' || first === '-') && NUMERIC_PATTERN.test(field)) return field
	return `${SANITIZE_ESCAPE}${field}`
}

/**
 * Serialize one cell value to its rendered text - the renderer's stringify
 * leaf, applied before sanitize/quote.
 *
 * @param value - The cell value
 * @param blank - The text a `null` / `undefined` value serializes to
 * @returns `blank` for `null` / `undefined`; the string unchanged for a
 * string; `String(value)` for a number/boolean/bigint; `JSON.stringify`'s
 * result for an object/array, degrading to `blank` on a circular value
 *
 * @example
 * ```ts
 * serializeCell(null, '')        // ''
 * serializeCell(42, '')          // '42'
 * serializeCell({ a: 1 }, '')    // '{"a":1}'
 * ```
 */
export function serializeCell(value: unknown, blank: string): string {
	if (value === null || value === undefined) return blank
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value)
	try {
		return JSON.stringify(value) ?? blank
	} catch {
		return blank
	}
}

/**
 * Derive a column order from a plain row list - the first-seen union of
 * every row's keys, in encounter order.
 *
 * @param rows - The rows to scan
 * @returns The union of keys across `rows`, first-seen order
 *
 * @example
 * ```ts
 * deriveColumns([{ a: 1, b: 2 }, { b: 3, c: 4 }]) // ['a', 'b', 'c']
 * ```
 */
export function deriveColumns(rows: readonly Row[]): readonly string[] {
	const seen = new Set<string>()
	for (const row of rows) {
		for (const key of Object.keys(row)) seen.add(key)
	}
	return [...seen]
}

/**
 * The correctness floor every {@link QuoteStyle} policy respects - a field
 * containing the delimiter, the quote character, CR, or LF must ALWAYS be
 * quoted regardless of policy.
 *
 * @param field - The already-sanitized field text
 * @param options - The resolved render options (see {@link resolveRenderOptions})
 * @returns `true` when `field` contains the delimiter, quote, CR, or LF
 *
 * @example
 * ```ts
 * needsQuote('a,b', resolveRenderOptions()) // true
 * needsQuote('plain', resolveRenderOptions()) // false
 * ```
 */
export function needsQuote(field: string, options: ResolvedRenderOptions): boolean {
	return (
		field.includes(options.delimiter) ||
		field.includes(options.quote) ||
		field.includes('\r') ||
		field.includes('\n')
	)
}

/**
 * Wrap `field` in quotes, escaping per `options.escape` - the shared
 * quote-and-escape step every quoting policy applies once it decides `field`
 * needs quoting; it IS the `'always'` {@link QuoteStyle} as well (every field
 * quoted unconditionally).
 *
 * @param field - The field text, already known to need quoting
 * @param options - The resolved render options
 * @returns `field` wrapped in `options.quote`, escaped per `options.escape` -
 * `'double'` doubles every `quote` occurrence; `'backslash'` doubles every
 * literal backslash and prefixes every `quote` with a backslash
 *
 * @example
 * ```ts
 * wrapQuoted('a"b', resolveRenderOptions()) // '"a""b"'
 * ```
 */
export function wrapQuoted(field: string, options: ResolvedRenderOptions): string {
	const escaped =
		options.escape === 'double'
			? field.split(options.quote).join(options.quote + options.quote)
			: field.split('\\').join('\\\\').split(options.quote).join(`\\${options.quote}`)
	return `${options.quote}${escaped}${options.quote}`
}

/**
 * The `'minimal'` {@link QuoteStyle} - quotes a field only when
 * {@link needsQuote} requires it.
 *
 * @param field - The already-sanitized field text
 * @param options - The resolved render options
 * @returns `field`, quoted and escaped when needed; unchanged otherwise
 *
 * @example
 * ```ts
 * quoteMinimal('a,b', resolveRenderOptions())  // '"a,b"'
 * quoteMinimal('plain', resolveRenderOptions()) // 'plain'
 * ```
 */
export function quoteMinimal(field: string, options: ResolvedRenderOptions): string {
	return needsQuote(field, options) ? wrapQuoted(field, options) : field
}

/**
 * The `'nonnumeric'` {@link QuoteStyle} - quotes every field whose value is
 * not a plain number (or that {@link needsQuote} requires regardless).
 *
 * @param field - The already-sanitized field text
 * @param options - The resolved render options
 * @returns `field`, quoted and escaped when needed; unchanged otherwise
 *
 * @example
 * ```ts
 * quoteNonnumeric('42', resolveRenderOptions())   // '42'
 * quoteNonnumeric('text', resolveRenderOptions()) // '"text"'
 * ```
 */
export function quoteNonnumeric(field: string, options: ResolvedRenderOptions): string {
	const shouldQuote = needsQuote(field, options) || !NUMERIC_PATTERN.test(field)
	return shouldQuote ? wrapQuoted(field, options) : field
}

/**
 * Render one row to one delimited line - serialize every column's cell,
 * optionally sanitize it, then apply the given quoting policy.
 *
 * @param row - The row to render
 * @param columns - The column order to render, in order
 * @param options - The resolved render options
 * @param quote - The quoting policy function to apply to each field (see
 * {@link quoteMinimal} / {@link wrapQuoted} / {@link quoteNonnumeric})
 * @returns The rendered line, columns joined by `options.delimiter`
 *
 * @example
 * ```ts
 * renderRecord({ a: 1, b: 2 }, ['a', 'b'], resolveRenderOptions(), quoteMinimal) // '1,2'
 * ```
 */
export function renderRecord(
	row: Row,
	columns: readonly string[],
	options: ResolvedRenderOptions,
	quote: (field: string, options: ResolvedRenderOptions) => string,
): string {
	return columns
		.map((column) => {
			const serialized = serializeCell(row[column], options.blank)
			const sanitized = options.sanitize ? sanitizeField(serialized) : serialized
			return quote(sanitized, options)
		})
		.join(options.delimiter)
}

/**
 * Select the quoting-policy function for a resolved `options.quotes`.
 *
 * @param quotes - The resolved {@link QuoteStyle}
 * @returns {@link quoteMinimal}, {@link wrapQuoted} (the `'always'` policy),
 * or {@link quoteNonnumeric}
 *
 * @example
 * ```ts
 * quoteStyleToPolicy('always') // wrapQuoted
 * ```
 */
export function quoteStyleToPolicy(
	quotes: ResolvedRenderOptions['quotes'],
): (field: string, options: ResolvedRenderOptions) => string {
	switch (quotes) {
		case 'always':
			return wrapQuoted
		case 'nonnumeric':
			return quoteNonnumeric
		case 'minimal':
			return quoteMinimal
	}
}

/**
 * Render a {@link CSVTable} (or a plain row list) to CSV text.
 *
 * @remarks
 * Total: a `JSON.stringify` failure (a circular value) degrades to
 * `options.blank` instead of throwing (see {@link serializeCell}). Columns
 * default to `options.columns`, or the source table's own `columns`, or -
 * for a plain row list - {@link deriveColumns}'s first-seen key union. No
 * trailing newline follows the last record.
 *
 * @param input - A {@link CSVTable}, or a plain readonly row list
 * @param options - Render options (see {@link resolveRenderOptions})
 * @returns The rendered CSV text
 * @throws {CSVError} `INVALID_OPTION` - see {@link resolveRenderOptions}
 *
 * @example
 * ```ts
 * renderCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] })
 * // 'a,b\r\n1,2'
 * ```
 */
export function renderCSV(input: CSVTable | readonly Row[], options?: RenderOptions): string {
	const resolved = resolveRenderOptions(options)
	const rows: readonly Row[] = isRowList(input) ? input : input.rows
	const columns = resolved.columns ?? (isRowList(input) ? deriveColumns(input) : input.columns)
	const quote = quoteStyleToPolicy(resolved.quotes)

	const lines: string[] = []
	if (resolved.header) {
		const headerRow: Row = Object.create(null)
		for (const column of columns) headerRow[column] = column
		lines.push(renderRecord(headerRow, columns, resolved, quote))
	}
	for (const row of rows) lines.push(renderRecord(row, columns, resolved, quote))
	const body = lines.join(resolved.newline)
	return resolved.bom ? `${BOM}${body}` : body
}

/**
 * Render a {@link CSVTable} (or a plain row list) to tab-separated text - a
 * thin `renderCSV` delegate forcing `delimiter: '\t'`.
 *
 * @remarks
 * An explicit `options.delimiter` passed by the caller is OVERRIDDEN - TSV
 * always uses tabs.
 *
 * @param input - A {@link CSVTable}, or a plain readonly row list
 * @param options - Render options (see {@link resolveRenderOptions}); `delimiter` is ignored
 * @returns The rendered TSV text
 * @throws {CSVError} `INVALID_OPTION` - see {@link resolveRenderOptions}
 *
 * @example
 * ```ts
 * renderTSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] })
 * // 'a\tb\r\n1\t2'
 * ```
 */
export function renderTSV(input: CSVTable | readonly Row[], options?: RenderOptions): string {
	return renderCSV(input, { ...options, delimiter: '\t' })
}

/**
 * Derive one {@link ContractShape} per table column from that column's cell
 * values across all rows (excluding `undefined`/empty-string cells) - the
 * schema-inference leaf behind {@link CSVInterface.export} when no explicit
 * {@link Columns} is given.
 *
 * @param table - The table to inspect
 * @returns A {@link Columns} map, one shape per column: `'text'` when a
 * column has no non-empty cells; the string-inferred type (via
 * {@link inferColumnType}) when every cell is a string; `'integer'` /
 * `'real'` when every cell is a number (by `Number.isSafeInteger`);
 * `'boolean'` when every cell is a boolean; `'json'` otherwise
 *
 * @example
 * ```ts
 * deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 2 }] })
 * // { a: columnTypeShape('integer') }
 * ```
 */
export function deriveShapes(table: CSVTable): Columns {
	const columns: Record<string, ReturnType<typeof columnTypeShape>> = {}
	for (const column of table.columns) {
		const values = table.rows
			.map((row) => row[column])
			.filter((value) => value !== undefined && value !== '')
		if (values.length === 0) {
			columns[column] = columnTypeShape('text')
		} else if (values.every((value): value is string => typeof value === 'string')) {
			columns[column] = columnTypeShape(inferColumnType(values))
		} else if (values.every((value) => typeof value === 'number')) {
			columns[column] = columnTypeShape(
				values.every((value) => Number.isSafeInteger(value)) ? 'integer' : 'real',
			)
		} else if (values.every((value) => typeof value === 'boolean')) {
			columns[column] = columnTypeShape('boolean')
		} else {
			columns[column] = columnTypeShape('json')
		}
	}
	return columns
}

// ---------------------------------------------------------------------------
// Tokenizer and table-builder leaves.
//
// Every scanner below threads a `Position` through the source text; every
// builder below turns scanned records into columns and rows. They are pure
// leaves of the parse spine rather than coercers, so they live here rather
// than in `parsers.ts`, whose exported functions all carry the `parse`
// prefix. `parsers.ts` imports them; this file never imports back.
// ---------------------------------------------------------------------------

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
 * @returns The typed value, via {@link coerceInteger} / {@link coerceReal} /
 * {@link coerceBoolean}; `value` unchanged for `'text'` (or the unreachable
 * `'json'` / `'blob'`)
 */
export function coerceInferred(value: string, type: ColumnType): unknown {
	switch (type) {
		case 'integer':
			return coerceInteger(value)
		case 'real':
			return coerceReal(value)
		case 'boolean':
			return coerceBoolean(value)
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
 * Coerce a raw cell string to a canonical integer - `undefined` for anything
 * else (leading zeros, decimals, out-of-safe-range magnitude, non-numeric text).
 *
 * @remarks
 * Named `coerce*` (not `parse*`) because this is a canonical-form CSV cell
 * coercer whose semantics deliberately differ from `@orkestrel/contract`'s
 * same-named `parseInteger` (leading-zero and unsafe-magnitude rejection) -
 * the rename keeps the two packages' surfaces from being confused.
 *
 * @param value - The raw cell text
 * @returns The integer, or `undefined` when `value` is not a canonical
 * integer within `Number.isSafeInteger` range
 *
 * @example
 * ```ts
 * coerceInteger('42')  // 42
 * coerceInteger('007') // undefined
 * ```
 */
export function coerceInteger(value: string): number | undefined {
	if (!INTEGER_PATTERN.test(value)) return undefined
	const number = Number(value)
	return Number.isSafeInteger(number) ? number : undefined
}

/**
 * Coerce a raw cell string to a canonical decimal (or integer) - `undefined`
 * for anything else.
 *
 * @remarks
 * Named `coerce*` (not `parse*`) because this is a canonical-form CSV cell
 * coercer whose semantics deliberately differ from `@orkestrel/contract`'s
 * same-named `parseReal`-adjacent coercers (leading-zero and unsafe-magnitude
 * rejection) - the rename keeps the two packages' surfaces from being
 * confused.
 *
 * @param value - The raw cell text
 * @returns The number, or `undefined` when `value` is not a canonical
 * integer/decimal, or its integer part is out of `Number.isSafeInteger` range
 *
 * @example
 * ```ts
 * coerceReal('3.14') // 3.14
 * coerceReal('42')   // 42
 * ```
 */
export function coerceReal(value: string): number | undefined {
	if (INTEGER_PATTERN.test(value)) return coerceInteger(value)
	return REAL_PATTERN.test(value) ? Number(value) : undefined
}

/**
 * Coerce a raw cell string to a strict boolean - `undefined` for anything
 * other than the exact canonical forms.
 *
 * @remarks
 * Named `coerce*` (not `parse*`) because this is a canonical-form CSV cell
 * coercer whose semantics deliberately differ from `@orkestrel/contract`'s
 * same-named `parseBoolean` (strict `'true'`/`'false'` only, no `'1'`/`'0'`
 * coercion) - the rename keeps the two packages' surfaces from being confused.
 *
 * @param value - The raw cell text
 * @returns `true` for {@link BOOLEAN_TRUE}, `false` for {@link BOOLEAN_FALSE},
 * `undefined` otherwise
 *
 * @example
 * ```ts
 * coerceBoolean('true')  // true
 * coerceBoolean('True')  // undefined
 * ```
 */
export function coerceBoolean(value: string): boolean | undefined {
	if (value === BOOLEAN_TRUE) return true
	if (value === BOOLEAN_FALSE) return false
	return undefined
}
