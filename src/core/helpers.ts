import type {
	Columns,
	CSVTable,
	ColumnType,
	ParseOptions,
	RenderOptions,
	ResolvedRenderOptions,
	Row,
} from './types.js'
import {
	BOM,
	BOOLEAN_FALSE,
	BOOLEAN_TRUE,
	DEFAULT_PARSE_OPTIONS,
	DEFAULT_RENDER_OPTIONS,
	INTEGER_PATTERN,
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
// Dependency direction: `parsers.ts` imports the option resolvers and
// `inferColumnType` from this file, so this file must NEVER import back from
// `parsers.ts` (that would be a cycle). `inferColumnType`'s integer/real
// tests therefore work directly off the shared pattern constants
// (`INTEGER_PATTERN` / `REAL_PATTERN` from `constants.ts`, the same
// constants `parsers.ts`'s `coerceInteger` / `coerceReal` test against) and
// `Number.isSafeInteger` - never calling the `parsers.ts` coercers.

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
