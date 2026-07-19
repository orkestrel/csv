import type { CSVTable, ColumnType, ParseOptions, RenderOptions, Row } from './types.js'
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
	SANITIZE_PREFIXES,
} from './constants.js'
import { CSVError } from './errors.js'

// Pure, total helper leaves the parser / renderer compose (AGENTS §5 / §14).
// Every function here is a functional-core leaf: referentially transparent,
// touching no external state, and (aside from the two option resolvers, which
// throw on a programmer error per AGENTS §12) never throwing. `renderCSV` is
// the one exception to "flat leaf" shape — it is the exported orchestration
// entry point whose sub-steps are nested inner functions, mirroring the
// markdown package's `renderHTML` / `renderMarkdown` pattern, so the only
// exported surface for that engine is `renderCSV` itself.

/**
 * Strip a single leading UTF-8 byte-order-mark (U+FEFF) from `input`, if
 * present — the BOM some tools prepend to CSV files.
 *
 * @param input - The raw text, possibly BOM-prefixed
 * @returns `input` with exactly one leading BOM removed; unchanged otherwise
 *
 * @example
 * ```ts
 * stripBom('﻿a,b') // 'a,b'
 * ```
 */
export function stripBom(input: string): string {
	return input.startsWith(BOM) ? input.slice(BOM.length) : input
}

/**
 * Validate a delimiter / quote pair shared by both {@link resolveParseOptions}
 * and {@link resolveRenderOptions} — each must be exactly one character, they
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
	if (quote.length !== 1) throw new CSVError('INVALID_OPTION', 'quote must be exactly one character')
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
 * @returns The resolved options (`columns` stays optional — it has no default)
 * @throws {CSVError} `INVALID_OPTION` when `delimiter` / `quote` are invalid
 * (see {@link assertValidSeparators}), or `newline` is anything other than
 * `'\n'` or `'\r\n'`
 *
 * @example
 * ```ts
 * resolveRenderOptions({ newline: '\n' }).newline // '\n'
 * ```
 */
export function resolveRenderOptions(
	options?: RenderOptions,
): Required<Omit<RenderOptions, 'columns'>> & Pick<RenderOptions, 'columns'> {
	const resolved = { ...DEFAULT_RENDER_OPTIONS, ...options }
	assertValidSeparators(resolved.delimiter, resolved.quote)
	if (resolved.newline !== '\n' && resolved.newline !== '\r\n')
		throw new CSVError('INVALID_OPTION', "newline must be '\\n' or '\\r\\n'")
	return resolved
}

/**
 * Conservatively infer a whole column's {@link ColumnType} from its raw
 * string values — never `'json'` or `'blob'` (those require an explicit
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
 * Coerce one raw cell value to its typed representation for `type` — the
 * inverse of stringifying a value for render.
 *
 * @param value - The raw cell text
 * @param type - The column's {@link ColumnType}
 * @returns `value` unchanged for `'text'` / `'blob'`; `undefined` for an
 * empty string with any other type; `Number(value)` for `'integer'` /
 * `'real'`; a strict boolean for `'boolean'`; the parsed value (or the raw
 * string on failure) for `'json'`
 *
 * @example
 * ```ts
 * coerceCell('42', 'integer')      // 42
 * coerceCell('true', 'boolean')    // true
 * coerceCell('{"a":1}', 'json')    // { a: 1 }
 * coerceCell('not json', 'json')   // 'not json'
 * ```
 */
export function coerceCell(value: string, type: ColumnType): unknown {
	if (type === 'text' || type === 'blob') return value
	if (value === '') return undefined
	switch (type) {
		case 'integer':
		case 'real':
			return Number(value)
		case 'boolean':
			return value === BOOLEAN_TRUE
		case 'json':
			try {
				return JSON.parse(value)
			} catch {
				return value
			}
	}
}

/**
 * Generate positional column names (`column1`, `column2`, …) for a header-less
 * table of the given field width.
 *
 * @param width - The number of columns
 * @returns `width` positional names, 1-based
 *
 * @example
 * ```ts
 * positionalColumns(3) // ['column1', 'column2', 'column3']
 * ```
 */
export function positionalColumns(width: number): readonly string[] {
	return Array.from({ length: width }, (_, index) => `${POSITIONAL_COLUMN_PREFIX}${index + 1}`)
}

/**
 * Deterministically disambiguate a header's column names — an empty (or
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

	// Shared collision resolver — both a literal name and a generated
	// positional name (from an empty/whitespace source name) run through this
	// same suffix loop, so neither can collide with an already-kept name.
	function resolveUnique(base: string): string {
		if (!seen.has(base)) return base
		let suffix = 2
		let candidate = `${base}_${suffix}`
		while (seen.has(candidate)) {
			suffix += 1
			candidate = `${base}_${suffix}`
		}
		return candidate
	}

	for (const [index, name] of names.entries()) {
		const base = name.trim() === '' ? `${POSITIONAL_COLUMN_PREFIX}${index + 1}` : name
		const unique = resolveUnique(base)
		kept.push(unique)
		seen.add(unique)
	}
	return kept
}

/**
 * Guard a field against CSV/spreadsheet formula injection (the OWASP
 * CSV-injection guidance) — a field starting with a formula-triggering
 * character is prefixed with a protective `'`.
 *
 * @param field - The raw field text (already stringified, not yet quoted)
 * @returns `field` prefixed with `'` when it starts with `=`, `@`, tab, CR, or
 * LF, or with `+` / `-` UNLESS the whole field is a plain signed number;
 * unchanged otherwise
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
	return `'${field}`
}

/**
 * Decide whether `field` needs quoting under `options.quotes` and, if so,
 * wrap and escape it — the renderer's one quoting/escaping leaf.
 *
 * @param field - The already-sanitized field text
 * @param options - The resolved render options (see {@link resolveRenderOptions})
 * @returns `field`, quoted and escaped per `options`, or unchanged when no
 * quoting is required
 * @remarks A field containing the delimiter, the quote character, CR, or LF
 * is ALWAYS quoted regardless of `options.quotes` (the correctness floor).
 *
 * @example
 * ```ts
 * quoteField('a,b', resolveRenderOptions())  // '"a,b"'
 * quoteField('plain', resolveRenderOptions()) // 'plain'
 * ```
 */
export function quoteField(field: string, options: ReturnType<typeof resolveRenderOptions>): string {
	const needsQuote =
		field.includes(options.delimiter) ||
		field.includes(options.quote) ||
		field.includes('\r') ||
		field.includes('\n')
	const shouldQuote =
		options.quotes === 'always'
			? true
			: options.quotes === 'nonnumeric'
				? needsQuote || !NUMERIC_PATTERN.test(field)
				: needsQuote
	if (!shouldQuote) return field
	const escaped =
		options.escape === 'double'
			? field.split(options.quote).join(options.quote + options.quote)
			: field.split('\\').join('\\\\').split(options.quote).join(`\\${options.quote}`)
	return `${options.quote}${escaped}${options.quote}`
}

/**
 * Render a {@link CSVTable} (or a plain row list) to CSV text.
 *
 * @remarks
 * Total: a `JSON.stringify` failure (a circular value) degrades to
 * `options.blank` instead of throwing. Columns default to `options.columns`,
 * or the source table's own `columns`, or — for a plain row list — the
 * first-seen union of every row's keys. No trailing newline follows the last
 * record. The engine's sub-steps (column resolution, cell serialization,
 * sanitize + quote, row assembly) are nested inner functions — `renderCSV`
 * itself is the only exported surface.
 *
 * @param input - A {@link CSVTable}, or a plain readonly row list
 * @param options - Render options (see {@link resolveRenderOptions})
 * @returns The rendered CSV text
 * @throws {CSVError} `INVALID_OPTION` — see {@link resolveRenderOptions}
 *
 * @example
 * ```ts
 * renderCSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] })
 * // 'a,b\r\n1,2'
 * ```
 */
export function renderCSV(input: CSVTable | readonly Row[], options?: RenderOptions): string {
	const resolved = resolveRenderOptions(options)

	// `Array.isArray` alone does not narrow a `readonly Row[]` union member
	// (a TypeScript limitation with readonly arrays) — an explicit type
	// predicate narrows reliably in both branches.
	function isRowList(source: CSVTable | readonly Row[]): source is readonly Row[] {
		return Array.isArray(source)
	}

	function resolveColumns(source: CSVTable | readonly Row[]): readonly string[] {
		if (resolved.columns) return resolved.columns
		if (!isRowList(source)) return source.columns
		const seen = new Set<string>()
		for (const row of source) {
			for (const key of Object.keys(row)) seen.add(key)
		}
		return [...seen]
	}

	function serialize(value: unknown): string {
		if (value === null || value === undefined) return resolved.blank
		if (typeof value === 'string') return value
		if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
			return String(value)
		try {
			return JSON.stringify(value) ?? resolved.blank
		} catch {
			return resolved.blank
		}
	}

	function formatField(raw: string): string {
		const sanitized = resolved.sanitize ? sanitizeField(raw) : raw
		return quoteField(sanitized, resolved)
	}

	function rowLine(row: Row, columns: readonly string[]): string {
		return columns.map((column) => formatField(serialize(row[column]))).join(resolved.delimiter)
	}

	function resolveRows(source: CSVTable | readonly Row[]): readonly Row[] {
		return isRowList(source) ? source : source.rows
	}

	const columns = resolveColumns(input)
	const rows = resolveRows(input)
	const lines: string[] = []
	if (resolved.header) lines.push(columns.map((column) => formatField(column)).join(resolved.delimiter))
	for (const row of rows) lines.push(rowLine(row, columns))
	const body = lines.join(resolved.newline)
	return resolved.bom ? `${BOM}${body}` : body
}

/**
 * Render a {@link CSVTable} (or a plain row list) to tab-separated text — a
 * thin `renderCSV` delegate forcing `delimiter: '\t'`.
 *
 * @remarks
 * An explicit `options.delimiter` passed by the caller is OVERRIDDEN — TSV
 * always uses tabs.
 *
 * @param input - A {@link CSVTable}, or a plain readonly row list
 * @param options - Render options (see {@link resolveRenderOptions}); `delimiter` is ignored
 * @returns The rendered TSV text
 * @throws {CSVError} `INVALID_OPTION` — see {@link resolveRenderOptions}
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
