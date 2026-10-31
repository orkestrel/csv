import type {
	CSVTable,
	FieldScan,
	HeaderResult,
	ParseOptions,
	Position,
	RawRecord,
	RecordScan,
	RecordsResult,
	RenderOptions,
	ResolvedParseOptions,
	ResolvedRenderOptions,
	CSVRow,
	RowResult,
} from './types.js'
import {
	BOM,
	DEFAULT_PARSE_OPTIONS,
	DEFAULT_RENDER_OPTIONS,
	MAX_ERRORS,
	NUMERIC_PATTERN,
	POSITIONAL_COLUMN_PREFIX,
	SANITIZE_ESCAPE,
	SANITIZE_PREFIXES,
	SUFFIX_SEPARATOR,
} from './constants.js'
import {
	attempt,
	isArray,
	isBigInt,
	isBoolean,
	isInteger,
	isNumber,
	isString,
} from '@orkestrel/contract'
import { CSVError } from './errors.js'

// Pure, total helper leaves the parser / renderer compose.
// Every function here is a functional-core leaf: referentially transparent,
// touching no external state, and (aside from resolveParseOptions and
// resolveRenderOptions, which throw on a programmer error) never throwing.
//
// Dependency direction: this file is the bottom of the module graph. It
// imports types, constants, and errors, and nothing else - `parsers.ts` is
// its only consumer, so an import back from there would be a cycle.

/**
 * Validates a delimiter / quote pair shared by both {@link resolveParseOptions}
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
 * Merges `options` over {@link DEFAULT_PARSE_OPTIONS} into a fully-resolved
 * parse configuration.
 *
 * @param options - The caller's partial {@link ParseOptions}
 * @returns The resolved options (`comment` stays optional — it has no default)
 * @throws {CSVError} `INVALID_OPTION` when `delimiter` / `quote` are invalid
 * (see {@link assertValidSeparators}), `comment` is an empty string, or
 * `limit` is negative or not a finite integer
 *
 * @example
 * ```ts
 * resolveParseOptions({ delimiter: ';' }).delimiter // ';'
 * ```
 */
export function resolveParseOptions(options?: ParseOptions): ResolvedParseOptions {
	const resolved = { ...DEFAULT_PARSE_OPTIONS, ...options }
	assertValidSeparators(resolved.delimiter, resolved.quote)
	if (resolved.comment === '')
		throw new CSVError('INVALID_OPTION', 'comment must not be an empty string')
	if (!isInteger(resolved.limit) || resolved.limit < 0)
		throw new CSVError('INVALID_OPTION', 'limit must be a non-negative integer')
	return resolved
}

/**
 * Merges `options` over {@link DEFAULT_RENDER_OPTIONS} into a fully-resolved
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
export function resolveRenderOptions(options?: RenderOptions): ResolvedRenderOptions {
	const resolved = { ...DEFAULT_RENDER_OPTIONS, ...options }
	assertValidSeparators(resolved.delimiter, resolved.quote)
	if (resolved.newline !== '\n' && resolved.newline !== '\r\n')
		throw new CSVError('INVALID_OPTION', "newline must be '\\n' or '\\r\\n'")
	return resolved
}

/**
 * Disambiguates a single column name against the names already taken — the
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
	const suffix = Array.from({ length: taken.size + 1 }, (_, index) => index + 2).find(
		(index) => !taken.has(`${name}${SUFFIX_SEPARATOR}${index}`),
	)
	return `${name}${SUFFIX_SEPARATOR}${suffix}`
}

/**
 * Disambiguates a header's column names deterministically — an empty (or
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
	return Iterator.from(names.entries()).reduce<readonly string[]>((kept, [index, name]) => {
		const base = name.trim() === '' ? `${POSITIONAL_COLUMN_PREFIX}${index + 1}` : name
		return [...kept, uniqueName(base, new Set(kept))]
	}, [])
}

/**
 * Guards a field against CSV/spreadsheet formula injection (the OWASP
 * CSV-injection guidance) — a field starting with a formula-triggering
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
 * Serializes one cell value to its rendered text — the renderer's stringify
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
	if (isString(value)) return value
	if (isNumber(value) || isBoolean(value) || isBigInt(value)) return String(value)
	const outcome = attempt(() => JSON.stringify(value))
	return outcome.success && isString(outcome.value) ? outcome.value : blank
}

/**
 * Derives a column order from a plain row list — the first-seen union of
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
export function deriveColumns(rows: readonly CSVRow[]): readonly string[] {
	const seen = new Set<string>()
	for (const row of rows) {
		for (const key of Object.keys(row)) seen.add(key)
	}
	return [...seen]
}

/**
 * Checks `field` against the correctness floor every {@link QuoteStyle}
 * policy respects — a field containing the delimiter, the quote character,
 * CR, or LF must ALWAYS be quoted regardless of policy.
 *
 * @param field - The already-sanitized field text
 * @param options - The resolved render options (see {@link resolveRenderOptions})
 * @returns True if `field` contains the delimiter, quote, CR, or LF; false otherwise
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
 * Wraps `field` in quotes, escaping per `options.escape` — the shared
 * quote-and-escape step every quoting policy applies once it decides `field`
 * needs quoting; it IS the `'always'` {@link QuoteStyle} as well (every field
 * quoted unconditionally).
 *
 * @param field - The field text, already known to need quoting
 * @param options - The resolved render options
 * @returns `field` wrapped in `options.quote`, escaped per `options.escape` —
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
 * Implements the `'minimal'` {@link QuoteStyle} — quotes a field only when
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
 * Implements the `'nonnumeric'` {@link QuoteStyle} — quotes every field whose
 * value is not a plain number (or that {@link needsQuote} requires
 * regardless).
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
 * Renders one row to one delimited line — serializes every column's cell,
 * optionally sanitizes it, then applies the given quoting policy.
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
	row: CSVRow,
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
 * Selects the quoting-policy function for a resolved `options.quotes`.
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
 * Narrows a `CSVTable | readonly CSVRow[]` union to its row-list member.
 *
 * @remarks
 * A native array test alone does not narrow a `readonly CSVRow[]` union member (a
 * TypeScript limitation with readonly arrays) — an explicit type predicate
 * narrows reliably in both branches.
 *
 * @param source - A {@link CSVTable}, or a plain readonly row list
 * @returns True if `source` is a plain row list; false otherwise
 */
export function isRowList(source: CSVTable | readonly CSVRow[]): source is readonly CSVRow[] {
	return isArray(source)
}

/**
 * Renders a {@link CSVTable} (or a plain row list) to CSV text.
 *
 * @remarks
 * Total: a `JSON.stringify` failure (a circular value) degrades to
 * `options.blank` instead of throwing (see {@link serializeCell}). Columns
 * default to `options.columns`, or the source table's own `columns`, or —
 * for a plain row list — {@link deriveColumns}'s first-seen key union. No
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
export function renderCSV(input: CSVTable | readonly CSVRow[], options?: RenderOptions): string {
	const resolved = resolveRenderOptions(options)
	const rows: readonly CSVRow[] = isRowList(input) ? input : input.rows
	const columns = resolved.columns ?? (isRowList(input) ? deriveColumns(input) : input.columns)
	const quote = quoteStyleToPolicy(resolved.quotes)

	const lines: string[] = []
	if (resolved.header) {
		const headerRow: CSVRow = Object.create(null)
		for (const column of columns) headerRow[column] = column
		lines.push(renderRecord(headerRow, columns, resolved, quote))
	}
	for (const row of rows) lines.push(renderRecord(row, columns, resolved, quote))
	const body = lines.join(resolved.newline)
	return resolved.bom ? `${BOM}${body}` : body
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
 * Advances a {@link Position} by `count` NON-line-break characters.
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
 * Checks whether `char` starts a record separator (CR or LF).
 *
 * @param char - A single character
 * @returns True if `char` is `'\r'` or `'\n'`; false otherwise
 */
export function isBreakChar(char: string): boolean {
	return char === '\r' || char === '\n'
}

/**
 * Consumes exactly one line break (CRLF, bare LF, or bare CR) at `position` —
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
 * Consumes a comment line at `position`, when `options.comment` names one
 * starting there — through the end of that line INCLUDING its break (or
 * end-of-input).
 *
 * @param source - The source text
 * @param position - The position to test
 * @param options - The resolved parse options
 * @returns The position after the whole comment line; `undefined` when
 * `options.comment` is absent or the text at `position` does not start with it
 *
 * @example
 * ```ts
 * scanCommentLine('#hi\na', { offset: 0, line: 1, column: 1 }, resolveParseOptions({ comment: '#' }))
 * // { offset: 4, line: 2, column: 1 }
 * ```
 */
export function scanCommentLine(
	source: string,
	position: Position,
	options: ResolvedParseOptions,
): Position | undefined {
	if (options.comment === undefined) return undefined
	if (!source.startsWith(options.comment, position.offset)) return undefined
	const distance = source.slice(position.offset).search(/[\r\n]/u)
	const cursor = advancePosition(
		position,
		distance < 0 ? source.length - position.offset : distance,
	)
	return scanBreak(source, cursor) ?? cursor
}

/**
 * Scans one unquoted field starting at `position` — content runs until the
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
	options: ResolvedParseOptions,
): FieldScan {
	const steps: FieldScan[] = []
	while (true) {
		const cursor = steps.at(-1)?.next ?? position
		if (!(cursor.offset < source.length)) break
		const char = source.charAt(cursor.offset)
		if (char === options.delimiter || isBreakChar(char)) break
		const errors =
			char === options.quote
				? [new CSVError('BAD_QUOTE', 'quote character inside an unquoted field', cursor)]
				: []
		steps.push({ field: { value: char, quoted: false }, next: advancePosition(cursor), errors })
	}
	const value = steps.map((step) => step.field.value).join('')
	const errors = steps.flatMap((step) => step.errors)
	const cursor = steps.at(-1)?.next ?? position
	const trimmed = options.trim ? value.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '') : value
	return { field: { value: trimmed, quoted: false }, next: cursor, errors }
}

/**
 * Scans one quoted field starting at `position` — `position` must be AT the
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
	options: ResolvedParseOptions,
): FieldScan {
	const open = position
	const steps: Array<{ readonly value: string; readonly next: Position }> = []
	while (true) {
		const cursor = steps.at(-1)?.next ?? advancePosition(position)
		if (cursor.offset >= source.length) {
			const error = new CSVError('UNTERMINATED_QUOTE', 'quoted field never closed', open)
			const value = steps.map((step) => step.value).join('')
			return { field: { value, quoted: true }, next: cursor, errors: [error] }
		}
		const char = source.charAt(cursor.offset)

		if (options.escape === 'backslash' && char === '\\') {
			const after = source.charAt(cursor.offset + 1)
			if (after === options.quote || after === '\\') {
				steps.push({ value: after, next: advancePosition(cursor, 2) })
				continue
			}
			steps.push({ value: char, next: advancePosition(cursor) })
			continue
		}

		if (char === options.quote) {
			if (options.escape === 'double' && source.charAt(cursor.offset + 1) === options.quote) {
				steps.push({ value: options.quote, next: advancePosition(cursor, 2) })
				continue
			}
			const next = advancePosition(cursor)
			const value = steps.map((step) => step.value).join('')
			if (next.offset >= source.length) return { field: { value, quoted: true }, next, errors: [] }
			const after = source.charAt(next.offset)
			if (after === options.delimiter || isBreakChar(after))
				return { field: { value, quoted: true }, next, errors: [] }
			const error = new CSVError('BAD_QUOTE', 'unexpected character after a closing quote', next)
			const remainder = source.slice(next.offset)
			const boundary = Iterator.from(remainder.matchAll(/[\s\S]/g)).find(
				(match) => match[0] === options.delimiter || isBreakChar(match[0]),
			)
			const tail = remainder.slice(0, boundary?.index)
			return {
				field: { value: value + tail, quoted: true },
				next: advancePosition(next, tail.length),
				errors: [error],
			}
		}

		if (isBreakChar(char)) {
			// Not scanBreak: a quoted field keeps the literal break characters in
			// its value, and scanBreak only advances the cursor without yielding them.
			if (char === '\r' && source.charAt(cursor.offset + 1) === '\n') {
				steps.push({
					value: '\r\n',
					next: { offset: cursor.offset + 2, line: cursor.line + 1, column: 1 },
				})
			} else {
				steps.push({
					value: char,
					next: { offset: cursor.offset + 1, line: cursor.line + 1, column: 1 },
				})
			}
			continue
		}

		steps.push({ value: char, next: advancePosition(cursor) })
	}
}

/**
 * Scans one field at `position` — dispatches to {@link scanQuoted} when the
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
	options: ResolvedParseOptions,
): FieldScan {
	return source.charAt(position.offset) === options.quote
		? scanQuoted(source, position, options)
		: scanUnquoted(source, position, options)
}

/**
 * Scans one full record at `position` — fields separated by
 * `options.delimiter`, ending at a break (consumed through {@link scanBreak}) or
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
	options: ResolvedParseOptions,
): RecordScan {
	const scans: FieldScan[] = []
	while (true) {
		const cursor = scans.length === 0 ? position : advancePosition(scans.at(-1)?.next ?? position)
		const scan = scanField(source, cursor, options)
		scans.push(scan)
		if (scan.next.offset < source.length && source.charAt(scan.next.offset) === options.delimiter)
			continue
		const next =
			scan.next.offset >= source.length ? scan.next : (scanBreak(source, scan.next) ?? scan.next)
		return {
			record: { fields: scans.map((field) => field.field), start: position },
			next,
			errors: scans.flatMap((field) => field.errors),
		}
	}
}

/**
 * Splits `input` into raw, un-mapped {@link RawRecord}s — the tokenizer phase
 * beneath {@link parseCSV}.
 *
 * @remarks
 * A single leading UTF-8 byte-order-mark is stripped before scanning; every
 * reported {@link Position} is relative to the text AFTER that removal. A
 * record separator at end-of-input does not produce a trailing empty
 * record, so a trailing-newline input and a no-trailing-newline input yield
 * identical records. Once {@link MAX_ERRORS} errors have been collected,
 * further malformations are silently no longer recorded — each leaf still
 * CONSTRUCTS its `CSVError` (the cap bounds the collected list, not leaf
 * allocation).
 *
 * @param input - The raw CSV text (BOM optional)
 * @param options - Parse options (see {@link resolveParseOptions}); `header`,
 * `ragged`, `infer`, and `strict` are ignored here — they apply only in
 * {@link parseCSV}
 * @returns The raw records plus any errors collected while splitting
 * @throws {CSVError} `INVALID_OPTION` - see {@link resolveParseOptions}
 *
 * @example
 * ```ts
 * scanRecords('a,b\n1,2').records[0].fields // [{value:'a',quoted:false},{value:'b',quoted:false}]
 * ```
 */
export function scanRecords(input: string, options?: ParseOptions): RecordsResult {
	const resolved = resolveParseOptions(options)
	const text = input.startsWith(BOM) ? input.slice(BOM.length) : input
	const steps: Array<
		RecordsResult & { readonly next: Position; readonly count: number; readonly faults: number }
	> = []
	while (true) {
		const previous = steps.at(-1)
		const position = previous?.next ?? { offset: 0, line: 1, column: 1 }
		if (position.offset >= text.length) break
		const recordStart = position

		const afterComment = scanCommentLine(text, position, resolved)
		if (afterComment !== undefined) {
			steps.push({
				next: afterComment,
				records: [],
				errors: [],
				count: previous?.count ?? 0,
				faults: previous?.faults ?? 0,
			})
			continue
		}

		const scan = scanRecord(text, position, resolved)
		const errors = scan.errors.slice(0, MAX_ERRORS - (previous?.faults ?? 0))

		const first = scan.record.fields[0]
		const isBlank =
			scan.record.fields.length === 1 && first !== undefined && !first.quoted && first.value === ''
		const omitted = isBlank && !resolved.blanks

		if (!omitted && resolved.limit > 0 && (previous?.count ?? 0) >= resolved.limit) {
			if ((previous?.faults ?? 0) + errors.length < MAX_ERRORS)
				errors.push(new CSVError('LIMIT_EXCEEDED', 'record limit exceeded', recordStart))
			steps.push({
				next: scan.next,
				records: [],
				errors,
				count: previous?.count ?? 0,
				faults: (previous?.faults ?? 0) + errors.length,
			})
			break
		}

		steps.push({
			next: scan.next,
			records: omitted ? [] : [scan.record],
			errors,
			count: (previous?.count ?? 0) + (omitted ? 0 : 1),
			faults: (previous?.faults ?? 0) + errors.length,
		})
	}

	return {
		records: steps.flatMap((step) => step.records),
		errors: steps.flatMap((step) => step.errors),
	}
}

/**
 * Resolves a table's header from its raw records — disambiguates the first
 * record's names when `options.header` is `true`, or generates positional
 * names sized to the widest record otherwise.
 *
 * @remarks
 * `header: true` disambiguates through {@link uniqueColumns}, collecting
 * `EMPTY_HEADER` for a blank raw name and `DUPLICATE_HEADER` for a repeat of
 * an earlier raw name, both positioned at the header record's
 * {@link Position}. `header: false` generates positional names sized to the
 * widest record, and every record is body.
 *
 * @param records - The raw records (from {@link scanRecords})
 * @param options - The resolved parse options
 * @returns The resolved columns, the body records (header excluded), and any
 * header errors
 *
 * @example
 * ```ts
 * deriveHeader(scanRecords('a,a\n1,2').records, resolveParseOptions())
 * // { columns: ['a', 'a_2'], body: [...], errors: [...] }
 * ```
 */
export function deriveHeader(
	records: readonly RawRecord[],
	options: ResolvedParseOptions,
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
 * Builds one {@link RawRecord} into one null-prototype {@link CSVRow}, padding
 * or truncating to `columns.length` per `options.ragged`.
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
 * @returns The built row, and the ragged-row error when one occurs
 *
 * @example
 * ```ts
 * buildRow(scanRecords('1,2').records[0], ['a', 'b', 'c'], resolveParseOptions())
 * // { row: { a: '1', b: '2', c: undefined }, error: CSVError('RAGGED_ROW', ...) }
 * ```
 */
export function buildRow(
	record: RawRecord,
	columns: readonly string[],
	options: ResolvedParseOptions,
): RowResult {
	const width = columns.length
	const fields = record.fields
	const actual = fields.length
	const row: CSVRow = Object.create(null)
	for (const position of Array.from({ length: width }).keys()) {
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
