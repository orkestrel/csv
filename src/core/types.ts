import type { ContractShape, JSONSchema } from '@orkestrel/contract'
import type { CSVError } from './errors.js'

// The cross-environment CSV surface - a parser + renderer over a plain typed
// `CSVTable`. Structurally interoperable with `@orkestrel/database` (a table's
// `Columns` map, its `TableExport` shape) without ever importing that package;
// this file re-derives the equivalent shapes locally so both packages stay
// independent and portable. Types are the source of truth (AGENTS §2).

/** A CSV row - a plain record of column values keyed by column name. */
export type Row = Record<string, unknown>

/**
 * A parsed CSV table - the typed rows plus the column order they were parsed
 * (or declared) in.
 */
export interface CSVTable {
	/** The column names, in order. */
	readonly columns: readonly string[]
	/** The parsed rows, in source order. */
	readonly rows: readonly Row[]
}

/**
 * One raw parsed field - the value exactly as it appeared in a record, before
 * type inference or column mapping, plus whether it was quoted in the source.
 *
 * @remarks
 * `quoted` distinguishes a field that was empty because it was written `""`
 * from one that was empty because nothing was written at all - a distinction
 * type inference and the `'nonnumeric'` quote policy both depend on.
 */
export interface RawField {
	/** The field's decoded text (quotes removed, escapes resolved). */
	readonly value: string
	/** `true` when the field was wrapped in quotes in the source. */
	readonly quoted: boolean
}

/**
 * A cursor position in a parsed source text - relative to the input after
 * byte-order-mark removal.
 *
 * @remarks
 * `offset` is a 0-based UTF-16 code-unit index; `line` is 1-based; `column`
 * is 1-based in UTF-16 code units.
 */
export interface Position {
	/** The 0-based UTF-16 code-unit offset. */
	readonly offset: number
	/** The 1-based line. */
	readonly line: number
	/** The 1-based column, in UTF-16 code units. */
	readonly column: number
}

/**
 * One raw parsed record - its ordered {@link RawField}s plus where the record
 * begins in the source, before header mapping.
 *
 * @remarks
 * `start` lets table-building errors (ragged rows, header faults) point back
 * at the exact record that produced them.
 */
export interface RawRecord {
	/** The record's fields, in source order. */
	readonly fields: readonly RawField[]
	/** The position the record starts at. */
	readonly start: Position
}

/**
 * One scanned field - a single {@link RawField} the tokenizer produced, the
 * {@link Position} immediately after it, and any malformations found while
 * scanning it.
 */
export interface FieldScan {
	/** The scanned field. */
	readonly field: RawField
	/** The position immediately after the field. */
	readonly next: Position
	/** Malformations found while scanning this field. */
	readonly errors: readonly CSVError[]
}

/**
 * One scanned record - a single {@link RawRecord} the tokenizer produced, the
 * {@link Position} immediately after it, and any malformations found while
 * scanning it.
 */
export interface RecordScan {
	/** The scanned record. */
	readonly record: RawRecord
	/** The position immediately after the record. */
	readonly next: Position
	/** Malformations found while scanning this record. */
	readonly errors: readonly CSVError[]
}

/**
 * The result of resolving a header record - the disambiguated column names,
 * the remaining body records, and any header-related errors.
 */
export interface HeaderResult {
	/** The disambiguated column names, in order. */
	readonly columns: readonly string[]
	/** The records that make up the table body (the header record excluded). */
	readonly body: readonly RawRecord[]
	/** Errors collected while resolving the header (`EMPTY_HEADER` / `DUPLICATE_HEADER`). */
	readonly errors: readonly CSVError[]
}

/**
 * The result of building one {@link RawRecord} into a typed {@link Row} -
 * either the row, or the error that excluded it (see `ParseOptions.ragged`).
 */
export interface RowResult {
	/** The built row, when the record was kept. */
	readonly row?: Row
	/** The error collected, when the record was ragged. */
	readonly error?: CSVError
}

/**
 * The result of the record-splitting phase - every {@link RawRecord} the
 * tokenizer produced plus any {@link CSVError}s collected along the way.
 */
export interface RecordsResult {
	/** The raw records, in source order. */
	readonly records: readonly RawRecord[]
	/** Errors collected while splitting (capped at {@link MAX_ERRORS}). */
	readonly errors: readonly CSVError[]
}

/**
 * The result of a full parse - the assembled {@link CSVTable} plus any
 * {@link CSVError}s collected along the way.
 */
export interface CSVParseResult {
	/** The parsed table. */
	readonly table: CSVTable
	/** Errors collected while parsing (capped at {@link MAX_ERRORS}). */
	readonly errors: readonly CSVError[]
}

/** How an embedded quote character is escaped inside a quoted field. */
export type EscapeStyle = 'double' | 'backslash'

/** The renderer's quoting policy - which fields get wrapped in quotes. */
export type QuoteStyle = 'minimal' | 'always' | 'nonnumeric'

/** How the parser treats a blank line - kept as an empty row, or skipped entirely. */
export type BlankPolicy = 'keep' | 'skip'

/** How the parser treats a record whose field count does not match the header. */
export type RaggedPolicy = 'collect' | 'pad' | 'error'

/**
 * A portable storage type for a column - mirrors `@orkestrel/database`'s
 * `ColumnType` structurally (never imported) so a CSV column map and a
 * database table schema stay drop-in interchangeable.
 */
export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'blob'

/**
 * A CSV's declared columns - a map of column name to its value
 * {@link ContractShape}.
 *
 * @remarks
 * Structurally identical to `@orkestrel/database`'s `Columns` (never
 * imported) - the same shape map can describe a CSV's columns and a
 * database table's, so an {@link export} round-trips through `import`
 * on either package.
 */
export type Columns = Readonly<Record<string, ContractShape>>

/**
 * Options for parsing CSV text into a {@link CSVTable}.
 *
 * @remarks
 * `delimiter` is the field separator (`,`); `quote` the quote character
 * (`"`); `escape` how an embedded quote is written inside a quoted field -
 * `'double'` doubles it (`""`), `'backslash'` prefixes it (`\"`); `header`
 * whether the first record names the columns (`true`) or is itself data
 * (`false`, columns become `column1..columnN`); `comment` a leading-character
 * marking a line as a comment to skip (`false` disables comment handling);
 * `blanks` whether a blank line becomes an empty row (`'keep'`) or is dropped
 * (`'skip'`) - a line of only whitespace is never blank, so `trim` does not
 * change what `blanks` skips; `trim` whether leading/trailing whitespace is stripped from
 * every unquoted field (`false`); `ragged` how a record whose field count
 * differs from the header is handled - padded/truncated to fit with the
 * error collected (`'collect'`), silently padded/truncated (`'pad'`), or
 * dropped with the error collected (`'error'`); `infer` whether field values
 * are coerced to their inferred type - integer, real, boolean - instead of
 * staying strings (`false`); `limit` a cap on the number of data records
 * parsed, `0` meaning unbounded; `strict` whether a `CSVError` that would
 * otherwise be collected is thrown instead (`false`).
 */
export interface ParseOptions {
	readonly delimiter?: string
	readonly quote?: string
	readonly escape?: EscapeStyle
	readonly header?: boolean
	readonly comment?: string | false
	readonly blanks?: BlankPolicy
	readonly trim?: boolean
	readonly ragged?: RaggedPolicy
	readonly infer?: boolean
	readonly limit?: number
	readonly strict?: boolean
}

/**
 * Options for rendering a {@link CSVTable} (or row list) back to CSV text.
 *
 * @remarks
 * `delimiter` is the field separator (`,`); `quote` the quote character
 * (`"`); `escape` how an embedded quote is written (`'double'` doubles it,
 * `'backslash'` prefixes it); `newline` the record separator (`\r\n`);
 * `header` whether a header record is emitted (`true`); `columns` the
 * explicit column order to render, defaulting to the first-seen union of
 * keys across all rows; `quotes` the quoting policy - `'minimal'` quotes
 * only fields that need it (containing the delimiter, quote, or a newline),
 * `'always'` quotes every field, `'nonnumeric'` quotes every field whose
 * value is not a plain number; `blank` the text a `null` / `undefined` value
 * serializes to (`''`); `sanitize` whether a field beginning with a
 * formula-injection character (`=`, `+`, `-`, `@`, tab, CR, LF) is prefixed
 * with a protective `'` per the OWASP CSV-injection guidance (`true`); `bom`
 * whether a UTF-8 byte-order-mark is prepended to the output (`false`).
 */
export interface RenderOptions {
	readonly delimiter?: string
	readonly quote?: string
	readonly escape?: EscapeStyle
	readonly newline?: string
	readonly header?: boolean
	readonly columns?: readonly string[]
	readonly quotes?: QuoteStyle
	readonly blank?: string
	readonly sanitize?: boolean
	readonly bom?: boolean
}

/**
 * The fully-resolved render configuration every quoting and rendering helper
 * takes - {@link RenderOptions} with every member defaulted except `columns`,
 * which has no default and stays optional.
 */
export type ResolvedRenderOptions = Required<Omit<RenderOptions, 'columns'>> &
	Pick<RenderOptions, 'columns'>

/**
 * Options for {@link CSVInterface.export}.
 *
 * @remarks
 * `key` names the export (mirrors `@orkestrel/database`'s `TableExport` unit
 * of exchange); `columns` overrides the exported column shapes, defaulting
 * to the columns the table was parsed/declared with.
 */
export interface ExportOptions {
	readonly key?: string
	readonly columns?: Columns
}

/**
 * A CSV's portable definition, produced by {@link CSVInterface.export} - the
 * unit of schema exchange across environments.
 *
 * @remarks
 * Structurally mirrors `@orkestrel/database`'s `TableExport` (never
 * imported) member-for-member - `key` a name, `columns` the source column
 * map, `schema` the equivalent JSON Schema - so a CSV export re-imports
 * losslessly as a database table (and vice versa).
 */
export interface TableExport {
	readonly key: string
	readonly columns: Columns
	readonly schema: JSONSchema
}

/** A machine-readable {@link CSVError} code. */
export type CSVErrorCode =
	| 'UNTERMINATED_QUOTE'
	| 'BAD_QUOTE'
	| 'RAGGED_ROW'
	| 'DUPLICATE_HEADER'
	| 'EMPTY_HEADER'
	| 'LIMIT_EXCEEDED'
	| 'INVALID_OPTION'

/**
 * A parsed, queryable CSV document - the typed {@link CSVTable} plus the
 * query, rewrite, and export operations over it.
 *
 * @remarks
 * **Immutable.** {@link CSVInterface.map} never mutates the stored table - it
 * returns a NEW {@link CSVInterface} instance. **Traversal order.** `find` /
 * `filter` / `reduce` iterate `rows` in table order. **`stream`.** Returns a
 * web-standard `ReadableStream` over the rows - a fresh, pull-based source
 * per call.
 */
export interface CSVInterface {
	/** The parsed table (columns + rows). */
	readonly table: CSVTable
	/** The parsed rows, in table order (same as `table.rows`). */
	readonly rows: readonly Row[]
	/** Errors collected while parsing (capped at {@link MAX_ERRORS}). */
	readonly errors: readonly CSVError[]
	/** Finds the first row matching `predicate`. */
	find(predicate: (row: Row, index: number) => boolean): Row | undefined
	/** Collects every row matching `predicate`. */
	filter(predicate: (row: Row, index: number) => boolean): readonly Row[]
	/** Rewrites every row (copy-on-write) and returns a new {@link CSVInterface}. */
	map(rewrite: (row: Row, index: number) => Row): CSVInterface
	/** Folds the rows, in table order, into an accumulator. */
	reduce<T>(callback: (accumulator: T, row: Row, index: number) => T, initial: T): T
	/**
	 * A web-standard `ReadableStream` over the table's rows (source order) -
	 * a lazy, pull-based, backpressure-respecting source. A fresh,
	 * independently-replayable stream every call; never mutates the table.
	 */
	stream(): ReadableStream<Row>
	/** Returns the stored {@link CSVTable} - the JSON-serializable projection. */
	toJSON(): CSVTable
	/** Produces a portable {@link TableExport} for moving this CSV's schema elsewhere. */
	export(options?: ExportOptions): TableExport
}
