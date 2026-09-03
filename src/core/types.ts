import type { ContractShape, JSONSchema } from '@orkestrel/contract'
import type { CSVError } from './errors.js'

// The cross-environment CSV surface - a parser + renderer over a plain typed
// `CSVTable`. Structurally interoperable with `@orkestrel/database` (a table's
// `Columns` map, its `TableDefinition` shape) without ever importing that
// package; this file re-derives the equivalent shapes locally so both packages
// stay independent and portable. Types are the source of truth.

/** Represents a CSV row - a plain record of column values keyed by column name. */
export type Row = Record<string, unknown>

/**
 * Represents a parsed CSV table - the typed rows plus the column order they
 * were parsed (or declared) in.
 */
export interface CSVTable {
	/** Holds the column names, in order. */
	readonly columns: readonly string[]
	/** Holds the parsed rows, in source order. */
	readonly rows: readonly Row[]
}

/**
 * Represents one raw parsed field - the value exactly as it appeared in a
 * record, before type inference or column mapping, plus whether it was quoted
 * in the source.
 *
 * @remarks
 * `quoted` distinguishes a field that was empty because it was written `""`
 * from one that was empty because nothing was written at all - a distinction
 * type inference and the `'nonnumeric'` quote policy both depend on.
 */
export interface RawField {
	/** Holds the field's decoded text (quotes removed, escapes resolved). */
	readonly value: string
	/** Reports whether the field was wrapped in quotes in the source. */
	readonly quoted: boolean
}

/**
 * Represents a cursor position in a parsed source text - relative to the
 * input after byte-order-mark removal.
 *
 * @remarks
 * `offset` is a 0-based UTF-16 code-unit index; `line` is 1-based; `column`
 * is 1-based in UTF-16 code units.
 */
export interface Position {
	/** Holds the 0-based UTF-16 code-unit offset. */
	readonly offset: number
	/** Holds the 1-based line. */
	readonly line: number
	/** Holds the 1-based column, in UTF-16 code units. */
	readonly column: number
}

/**
 * Represents one raw parsed record - its ordered {@link RawField}s plus where
 * the record begins in the source, before header mapping.
 *
 * @remarks
 * `start` lets table-building errors (ragged rows, header faults) point back
 * at the exact record that produced them.
 */
export interface RawRecord {
	/** Holds the record's fields, in source order. */
	readonly fields: readonly RawField[]
	/** Holds the position the record starts at. */
	readonly start: Position
}

/**
 * Represents one scanned field - a single {@link RawField} the tokenizer
 * produced, the {@link Position} immediately after it, and any malformations
 * found while scanning it.
 */
export interface FieldScan {
	/** Holds the scanned field. */
	readonly field: RawField
	/** Holds the position immediately after the field. */
	readonly next: Position
	/** Lists the malformations found while scanning this field. */
	readonly errors: readonly CSVError[]
}

/**
 * Represents one scanned record - a single {@link RawRecord} the tokenizer
 * produced, the {@link Position} immediately after it, and any malformations
 * found while scanning it.
 */
export interface RecordScan {
	/** Holds the scanned record. */
	readonly record: RawRecord
	/** Holds the position immediately after the record. */
	readonly next: Position
	/** Lists the malformations found while scanning this record. */
	readonly errors: readonly CSVError[]
}

/**
 * Represents the result of resolving a header record - the disambiguated
 * column names, the remaining body records, and any header-related errors.
 */
export interface HeaderResult {
	/** Holds the disambiguated column names, in order. */
	readonly columns: readonly string[]
	/** Holds the records that make up the table body (the header record excluded). */
	readonly body: readonly RawRecord[]
	/**
	 * Lists the errors collected while resolving the header (`EMPTY_HEADER` /
	 * `DUPLICATE_HEADER`).
	 */
	readonly errors: readonly CSVError[]
}

/**
 * Represents the result of building one {@link RawRecord} into a typed
 * {@link Row} - either the row, or the error that excluded it (see
 * `ParseOptions.ragged`).
 */
export interface RowResult {
	/** Holds the built row, when the record was kept. */
	readonly row?: Row
	/** Holds the error collected, when the record was ragged. */
	readonly error?: CSVError
}

/**
 * Represents the result of the record-splitting phase - every
 * {@link RawRecord} the tokenizer produced plus any {@link CSVError}s
 * collected along the way.
 */
export interface RecordsResult {
	/** Holds the raw records, in source order. */
	readonly records: readonly RawRecord[]
	/** Lists the errors collected while splitting (capped at {@link MAX_ERRORS}). */
	readonly errors: readonly CSVError[]
}

/**
 * Represents the result of a full parse - the assembled {@link CSVTable} plus
 * any {@link CSVError}s collected along the way.
 */
export interface CSVParseResult {
	/** Holds the parsed table. */
	readonly table: CSVTable
	/** Lists the errors collected while parsing (capped at {@link MAX_ERRORS}). */
	readonly errors: readonly CSVError[]
}

/** Names how an embedded quote character is escaped inside a quoted field. */
export type EscapeStyle = 'double' | 'backslash'

/** Names the renderer's quoting policy - which fields get wrapped in quotes. */
export type QuoteStyle = 'minimal' | 'always' | 'nonnumeric'

/** Names how the parser treats a record whose field count does not match the header. */
export type RaggedPolicy = 'collect' | 'pad' | 'error'

/**
 * Names a portable storage type for a column - the same literal set
 * `@orkestrel/database` declares as `ColumnStorage` (never imported), so a CSV
 * column map and a database table schema stay drop-in interchangeable.
 */
export type ColumnType = 'text' | 'integer' | 'real' | 'boolean' | 'json' | 'blob'

/**
 * Represents a CSV's declared columns - a map of column name to its value
 * {@link ContractShape}.
 *
 * @remarks
 * Structurally identical to `@orkestrel/database`'s `ColumnMap` (never
 * imported) - the same shape map can describe a CSV's columns and a
 * database table's.
 */
export type Columns = Readonly<Record<string, ContractShape>>

/**
 * Represents the options for parsing CSV text into a {@link CSVTable}.
 *
 * @remarks
 * `delimiter` is the field separator (`,`); `quote` the quote character
 * (`"`); `escape` how an embedded quote is written inside a quoted field -
 * `'double'` doubles it (`""`), `'backslash'` prefixes it (`\"`); `header`
 * whether the first record names the columns (`true`) or is itself data
 * (`false`, columns become `column1..columnN`); `comment` a leading-character
 * marking a line as a comment to skip (absent, no line is a comment);
 * `blanks` whether a blank line becomes an empty row (`true`) - a line of
 * only whitespace is never blank, so `trim` does not change what `blanks`
 * drops; `trim` whether leading/trailing whitespace is stripped from
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
	readonly comment?: string
	readonly blanks?: boolean
	readonly trim?: boolean
	readonly ragged?: RaggedPolicy
	readonly infer?: boolean
	readonly limit?: number
	readonly strict?: boolean
}

/**
 * Represents the fully-resolved parse configuration every tokenizer and
 * table-building helper takes - {@link ParseOptions} with every member
 * defaulted except `comment`, which has no default and stays optional.
 *
 * @remarks
 * An absent `comment` is what turns comment handling off, so
 * {@link DEFAULT_PARSE_OPTIONS} declares no `comment` member at all.
 */
export type ResolvedParseOptions = Required<Omit<ParseOptions, 'comment'>> &
	Pick<ParseOptions, 'comment'>

/**
 * Represents the options for rendering a {@link CSVTable} (or row list) back
 * to CSV text.
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
 * Represents the fully-resolved render configuration every quoting and
 * rendering helper takes - {@link RenderOptions} with every member defaulted
 * except `columns`, which has no default and stays optional.
 */
export type ResolvedRenderOptions = Required<Omit<RenderOptions, 'columns'>> &
	Pick<RenderOptions, 'columns'>

/**
 * Represents the options for {@link CSVInterface.export}.
 *
 * @remarks
 * `key` names the primary-key column the export is keyed by - one of the
 * table's own columns, defaulting to the first; `columns` overrides the
 * exported column shapes, defaulting to the columns the table was parsed or
 * declared with.
 */
export interface ExportOptions {
	readonly key?: string
	readonly columns?: Columns
}

/**
 * Represents a CSV's portable definition, produced by
 * {@link CSVInterface.export} - the unit of schema exchange across
 * environments.
 *
 * @remarks
 * `@orkestrel/database` declares `TableDefinition { primary, columns,
 * schema }`. This package's {@link Columns} map is structurally identical to
 * that package's `ColumnMap`, and `schema` is the same JSON Schema. This
 * package names the key column `key` where that package names it `primary`.
 * Neither package imports the other.
 */
export interface TableExport {
	readonly key: string
	readonly columns: Columns
	readonly schema: JSONSchema
}

/** Names a machine-readable {@link CSVError} code. */
export type CSVErrorCode =
	| 'UNTERMINATED_QUOTE'
	| 'BAD_QUOTE'
	| 'RAGGED_ROW'
	| 'DUPLICATE_HEADER'
	| 'EMPTY_HEADER'
	| 'LIMIT_EXCEEDED'
	| 'INVALID_OPTION'

/**
 * Represents a parsed, queryable CSV document - the typed {@link CSVTable}
 * plus the query, rewrite, and export operations over it.
 *
 * @remarks
 * **Immutable.** {@link CSVInterface.map} never mutates the stored table - it
 * returns a NEW {@link CSVInterface} instance. **Traversal order.** `find` /
 * `filter` / `reduce` iterate `rows` in table order. **`stream`.** Returns a
 * web-standard `ReadableStream` over the rows - a fresh, pull-based source
 * per call.
 */
export interface CSVInterface {
	/** Holds the parsed table (columns + rows). */
	readonly table: CSVTable
	/** Holds the parsed rows, in table order (same as `table.rows`). */
	readonly rows: readonly Row[]
	/** Lists the errors collected while parsing (capped at {@link MAX_ERRORS}). */
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
	 * Returns a web-standard `ReadableStream` over the table's rows (source
	 * order) - a lazy, pull-based, backpressure-respecting source. A fresh,
	 * independently-replayable stream every call; never mutates the table.
	 */
	stream(): ReadableStream<Row>
	/** Returns the stored {@link CSVTable} - the JSON-serializable projection. */
	toJSON(): CSVTable
	/** Produces a portable {@link TableExport} for moving this CSV's schema elsewhere. */
	export(options?: ExportOptions): TableExport
}
