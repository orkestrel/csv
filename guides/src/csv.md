# CSV

> A zero-dependency, types-first RFC 4180 CSV parser and renderer — a
> hand-written, single-pass tokenizer that turns CSV text into a typed
> `CSVTable`, and a stateful `CSV` workspace that wraps that table with
> query, rewrite, streaming, and export operations. Source:
> [`src/core`](../../src/core). Surfaced through the `@src/core` barrel.

CSV here is: parse once into a typed `CSVTable` (columns + rows), then treat
every read as a projection of it. `parseCSV` runs a tokenizer phase
(`readRecords`, a hand-written character scanner honoring quoting, escaping,
and both CRLF/LF/CR line endings) then a table-building phase — header
mapping, ragged-row handling, and optional whole-column type inference — and
returns a `CSVParseResult` pairing the table with any `CSVError`s collected
along the way. A `CSV` instance wraps that result with query (`find` /
`filter` / `reduce`), rewrite (`map`), streaming, and export operations. The
renderer — `renderCSV` (and its TSV sibling `renderTSV`) — is a separate,
standalone, downstream projection from a table (or plain row list) back to
text; it never assumes its input came from `parseCSV`. Every row is built
with a null prototype, so a hostile header name (`__proto__`) can never reach
`Object.prototype`; `renderCSV` sanitizes every field against CSV formula
injection by default. Parsing never throws on malformed data — a
`CSVError` (a machine-readable `code` plus `line` / `column` / `offset`) is
collected into the result's `errors` instead, unless `strict` is set, in
which case the first collected error throws immediately. An invalid option
(`INVALID_OPTION`) always throws — that is a programmer error, not a parse
malformation.

## Surface

A short intro, then a minimal usage example:

```ts
import { createCSV } from '@src/core'

const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })
csv.rows // [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }]
```

### Types

The full parse/render/export shape, from [`types.ts`](../../src/core/types.ts).

| Type                    | Kind      | Shape                                                                                                                                                                                              |
| ----------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Row`                   | type      | `Record<string, unknown>` — a CSV row, a plain record of column values keyed by column name.                                                                                                       |
| `CSVTable`              | interface | `{ columns: readonly string[], rows: readonly Row[] }` — a parsed table, the column order plus the parsed rows.                                                                                    |
| `RawField`              | interface | `{ value: string, quoted: boolean }` — one raw parsed field before type inference or column mapping; `quoted` distinguishes an empty-because-`""` field from an empty-because-nothing-written one. |
| `Position`              | interface | `{ offset: number, line: number, column: number }` — a cursor position in a parsed source, relative to the input after BOM removal; 0-based `offset`, 1-based `line`/`column`.                     |
| `RawRecord`             | interface | `{ fields: readonly RawField[], start: Position }` — one raw parsed record plus the `Position` it begins at, before header mapping.                                                                |
| `FieldScan`             | interface | `{ field: RawField, next: Position, errors: readonly CSVError[] }` — one scanned field plus the position immediately after it and any malformations found scanning it.                             |
| `RecordScan`            | interface | `{ record: RawRecord, next: Position, errors: readonly CSVError[] }` — one scanned record plus the position immediately after it and any malformations found scanning it.                          |
| `HeaderResult`          | interface | `{ columns: readonly string[], body: readonly RawRecord[], errors: readonly CSVError[] }` — a resolved header's disambiguated columns, the remaining body records, and header-related errors.      |
| `RowResult`             | interface | `{ row?: Row, error?: CSVError }` — one built row, or the error that excluded it (see `ParseOptions.ragged`).                                                                                      |
| `RecordsResult`         | interface | `{ records: readonly RawRecord[], errors: readonly CSVError[] }` — the tokenizer phase's result.                                                                                                   |
| `CSVParseResult`        | interface | `{ table: CSVTable, errors: readonly CSVError[] }` — a full parse's result.                                                                                                                        |
| `EscapeStyle`           | type      | `'double' \| 'backslash'` — how an embedded quote is escaped inside a quoted field.                                                                                                                |
| `QuoteStyle`            | type      | `'minimal' \| 'always' \| 'nonnumeric'` — the renderer's quoting policy.                                                                                                                           |
| `BlankPolicy`           | type      | `'keep' \| 'skip'` — how the parser treats a blank line.                                                                                                                                           |
| `RaggedPolicy`          | type      | `'collect' \| 'pad' \| 'error'` — how the parser treats a record whose field count does not match the header.                                                                                      |
| `ColumnType`            | type      | `'text' \| 'integer' \| 'real' \| 'boolean' \| 'json' \| 'blob'` — a portable column storage type, mirroring `@orkestrel/database`'s `ColumnType` structurally.                                    |
| `Columns`               | type      | `Readonly<Record<string, ContractShape>>` — a table's declared columns, mirroring `@orkestrel/database`'s `Columns` structurally.                                                                  |
| `ParseOptions`          | interface | `{ delimiter?, quote?, escape?, header?, comment?, blanks?, trim?, ragged?, infer?, limit?, strict? }` — options for parsing CSV text.                                                             |
| `RenderOptions`         | interface | `{ delimiter?, quote?, escape?, newline?, header?, columns?, quotes?, blank?, sanitize?, bom? }` — options for rendering a table back to text.                                                     |
| `ResolvedRenderOptions` | type      | `Required<Omit<RenderOptions, 'columns'>> & Pick<RenderOptions, 'columns'>` — the fully-resolved render configuration every quoting/rendering helper takes as its `options` parameter.             |
| `ExportOptions`         | interface | `{ key?: string, columns?: Columns }` — options for `CSVInterface.export`.                                                                                                                         |
| `TableExport`           | interface | `{ key: string, columns: Columns, schema: JSONSchema }` — a portable schema export, mirroring `@orkestrel/database`'s `TableExport` member-for-member.                                             |
| `CSVErrorCode`          | type      | `'UNTERMINATED_QUOTE' \| 'BAD_QUOTE' \| 'RAGGED_ROW' \| 'DUPLICATE_HEADER' \| 'EMPTY_HEADER' \| 'LIMIT_EXCEEDED' \| 'INVALID_OPTION'` — a machine-readable `CSVError` code.                        |
| `CSVInterface`          | interface | `{ table, rows, errors, find, filter, map, reduce, stream, toJSON, export }` — see [`## Methods`](#methods) below.                                                                                 |

### Errors

From [`errors.ts`](../../src/core/errors.ts). AGENTS §12: an invalid option or
programmer error always throws a `CSVError`; a parse-time malformation is
collected into a result's `errors` unless `strict` is set.

| Error        | Kind     | Signature                               | Behavior                                                                                                                                       |
| ------------ | -------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSVError`   | class    | `extends Error`                         | Carries a `CSVErrorCode` plus, for a parse-time malformation, the 1-based `line`/`column` and 0-based `offset`, and an optional `context` bag. |
| `isCSVError` | function | `(value: unknown) => value is CSVError` | Narrows an unknown caught value (typically a `catch` binding) to a `CSVError`.                                                                 |

### Constants

Centralized, frozen data the parser/renderer draw their defaults and
canonical patterns from, from [`constants.ts`](../../src/core/constants.ts).

| Constant                   | Kind  | Behavior                                                                                                              |
| -------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------- |
| `BOM`                      | const | The UTF-8 byte-order-mark character, prepended when `RenderOptions.bom` is `true`.                                    |
| `DEFAULT_PARSE_OPTIONS`    | const | The resolved default `ParseOptions` — what `parseCSV` uses for any option left unspecified.                           |
| `DEFAULT_RENDER_OPTIONS`   | const | The resolved default `RenderOptions` (everything but `columns`) — what `renderCSV` uses for any unspecified option.   |
| `SANITIZE_PREFIXES`        | const | The leading characters the OWASP CSV-injection guard treats as formula-triggering (`=`, `+`, `-`, `@`, tab, CR, LF).  |
| `POSITIONAL_COLUMN_PREFIX` | const | `'column'` — the prefix used to name positional columns (`column1`, `column2`, …).                                    |
| `SANITIZE_ESCAPE`          | const | `"'"` — the protective prefix `sanitizeField` prepends to a field starting with a formula-triggering character.       |
| `SUFFIX_SEPARATOR`         | const | `'_'` — the separator between a disambiguated column name and its collision counter (`name` → `name_2`, `name_3`, …). |
| `INTEGER_PATTERN`          | const | Matches a canonical integer only — no leading zeros, no `+` sign, no scientific notation.                             |
| `REAL_PATTERN`             | const | Matches a canonical decimal only — like `INTEGER_PATTERN` plus an optional `.` fractional part.                       |
| `NUMERIC_PATTERN`          | const | Like `REAL_PATTERN` but also allowing a leading `+` — what the renderer treats as a plain number.                     |
| `BOOLEAN_TRUE`             | const | `'true'` — the canonical serialized form of the boolean `true`.                                                       |
| `BOOLEAN_FALSE`            | const | `'false'` — the canonical serialized form of the boolean `false`.                                                     |
| `MAX_ERRORS`               | const | `100` — the maximum number of `CSVError`s collected into a parse result.                                              |

### Helpers

Pure, total, zero-dependency parsing + rendering leaves from
[`helpers.ts`](../../src/core/helpers.ts) — the functional core `parsers.ts`
composes and the projections callers reach for directly (AGENTS §5). Every
function is unit-testable in isolation.

| Helper                  | Kind     | Signature                                                                                                                                            | Behavior                                                                                                                                                     |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stripBom`              | function | `(input: string) => string`                                                                                                                          | Strips a single leading UTF-8 byte-order-mark, if present.                                                                                                   |
| `assertValidSeparators` | function | `(delimiter: string, quote: string) => void`                                                                                                         | Validates a delimiter/quote pair — each one character, distinct, and never CR/LF/BOM. Throws `INVALID_OPTION` otherwise.                                     |
| `resolveParseOptions`   | function | `(options?: ParseOptions) => Required<ParseOptions>`                                                                                                 | Merges `options` over `DEFAULT_PARSE_OPTIONS`; throws `INVALID_OPTION` for a bad separator pair, an empty `comment`, or a negative/non-integer `limit`.      |
| `resolveRenderOptions`  | function | `(options?: RenderOptions) => ResolvedRenderOptions`                                                                                                 | Merges `options` over `DEFAULT_RENDER_OPTIONS`; throws `INVALID_OPTION` for a bad separator pair or an invalid `newline`.                                    |
| `positionalColumns`     | function | `(width: number) => readonly string[]`                                                                                                               | Generates `column1..columnN` for a header-less table.                                                                                                        |
| `inferColumnType`       | function | `(values: readonly string[]) => ColumnType`                                                                                                          | Conservatively infers a whole column's type — never `'json'`/`'blob'`; empty cells are ignored; a leading-zero or unsafe-magnitude number stays `'text'`.    |
| `uniqueName`            | function | `(name: string, taken: ReadonlySet<string>) => string`                                                                                               | Disambiguates one candidate name against the names already taken — unchanged if free, else suffixed `_2`, `_3`, … until unique.                              |
| `uniqueColumns`         | function | `(names: readonly string[]) => readonly string[]`                                                                                                    | Deterministically disambiguates header names — blank becomes positional, a repeat is suffixed `_2`, `_3`, …, via `uniqueName`.                               |
| `sanitizeField`         | function | `(field: string) => string`                                                                                                                          | Guards a field against CSV formula injection — prefixes a protective `'` unless the field is a plain signed number.                                          |
| `serializeCell`         | function | `(value: unknown, blank: string) => string`                                                                                                          | Stringifies one cell value — `blank` for `null`/`undefined`, `String(value)` for a number/boolean/bigint, `JSON.stringify` (degrading to `blank`) otherwise. |
| `deriveColumns`         | function | `(rows: readonly Row[]) => readonly string[]`                                                                                                        | Derives a column order from a plain row list — the first-seen union of every row's keys.                                                                     |
| `needsQuote`            | function | `(field: string, options: ResolvedRenderOptions) => boolean`                                                                                         | The correctness floor every quoting policy respects — `true` when `field` contains the delimiter, quote, CR, or LF.                                          |
| `escapeQuotes`          | function | `(field: string, quote: string) => string`                                                                                                           | The `'double'` `EscapeStyle` — doubles every `quote` occurrence in `field`.                                                                                  |
| `escapeBackslashes`     | function | `(field: string, quote: string) => string`                                                                                                           | The `'backslash'` `EscapeStyle` — doubles every backslash and prefixes every `quote` occurrence with `\`.                                                    |
| `wrapQuoted`            | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | Wraps `field` (already known to need quoting) in `options.quote`, escaped per `options.escape`.                                                              |
| `quoteMinimal`          | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | The `'minimal'` `QuoteStyle` — quotes `field` only when `needsQuote` requires it.                                                                            |
| `quoteAlways`           | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | The `'always'` `QuoteStyle` — quotes `field` unconditionally.                                                                                                |
| `quoteNonnumeric`       | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | The `'nonnumeric'` `QuoteStyle` — quotes `field` unless it is a plain number (or `needsQuote` requires it regardless).                                       |
| `quoteStyleToPolicy`    | function | `(quotes: ResolvedRenderOptions['quotes']) => (field: string, options: ResolvedRenderOptions) => string`                                             | Selects `quoteMinimal` / `quoteAlways` / `quoteNonnumeric` for a resolved `options.quotes`.                                                                  |
| `renderRecord`          | function | `(row: Row, columns: readonly string[], options: ResolvedRenderOptions, quote: (field: string, options: ResolvedRenderOptions) => string) => string` | Renders one row to one delimited line — serialize, optionally sanitize, then quote each column's cell.                                                       |
| `renderCSV`             | function | `(input: CSVTable \| readonly Row[], options?: RenderOptions) => string`                                                                             | Renders a table (or plain row list) to CSV text. Total — a circular value degrades to `options.blank` instead of throwing.                                   |
| `renderTSV`             | function | `(input: CSVTable \| readonly Row[], options?: RenderOptions) => string`                                                                             | A thin `renderCSV` delegate forcing `delimiter: '\t'` — overrides any `options.delimiter`.                                                                   |
| `deriveShapes`          | function | `(table: CSVTable) => Columns`                                                                                                                       | Derives one `ContractShape` per column from its cell values — the schema-inference leaf behind `CSVInterface.export` when no explicit `Columns` is given.    |

### Parsers

The tokenizer + table-building spine, from
[`parsers.ts`](../../src/core/parsers.ts) — a hand-written, linear-time
character scanner, no regex, no backtracking.

| Parser            | Kind     | Signature                                                                                        | Behavior                                                                                                                                                                |
| ----------------- | -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advancePosition` | function | `(position: Position, count?: number) => Position`                                               | Advances a `Position` by `count` (default `1`) non-line-break characters — `line` unchanged, `column`/`offset` shifted.                                                 |
| `isBreakChar`     | function | `(char: string) => boolean`                                                                      | Whether `char` starts a record separator (CR or LF).                                                                                                                    |
| `scanBreak`       | function | `(source: string, position: Position) => Position \| undefined`                                  | Consumes exactly one line break (CRLF, bare LF, or bare CR) at `position` — a CRLF pair counts as one break; `undefined` when not at a break.                           |
| `scanComment`     | function | `(source: string, position: Position, options: Required<ParseOptions>) => Position \| undefined` | Consumes a comment line at `position` (through its break or end-of-input); `undefined` when `options.comment` is `false` or no match.                                   |
| `scanUnquoted`    | function | `(source: string, position: Position, options: Required<ParseOptions>) => FieldScan`             | Scans one unquoted field — runs until the delimiter, a break, or end-of-input; a mid-field quote is a `BAD_QUOTE` kept literal; `options.trim` strips space/tab edges.  |
| `scanQuoted`      | function | `(source: string, position: Position, options: Required<ParseOptions>) => FieldScan`             | Scans one quoted field (`position` at the opening quote) — honors `options.escape`; unterminated yields `UNTERMINATED_QUOTE`, trailing garbage yields `BAD_QUOTE`.      |
| `scanField`       | function | `(source: string, position: Position, options: Required<ParseOptions>) => FieldScan`             | Scans one field at `position` — dispatches to `scanQuoted` when at `options.quote`, else `scanUnquoted`.                                                                |
| `scanRecord`      | function | `(source: string, position: Position, options: Required<ParseOptions>) => RecordScan`            | Scans one full record — fields separated by `options.delimiter`, ending at a break (consumed) or end-of-input.                                                          |
| `readRecords`     | function | `(input: string, options?: ParseOptions) => RecordsResult`                                       | Splits `input` into raw, un-mapped `RawRecord`s — the tokenizer phase beneath `parseCSV`; a single leading BOM is stripped first.                                       |
| `deriveHeader`    | function | `(records: readonly RawRecord[], options: Required<ParseOptions>) => HeaderResult`               | Resolves a table's header — disambiguates the first record (`header: true`, via `uniqueColumns`) or generates positional names sized to the widest record (`false`).    |
| `buildRow`        | function | `(record: RawRecord, columns: readonly string[], options: Required<ParseOptions>) => RowResult`  | Builds one `RawRecord` into a null-prototype `Row`, padding/truncating to `columns.length` per `options.ragged`.                                                        |
| `coerceInferred`  | function | `(value: string, type: ColumnType) => unknown`                                                   | Coerces one string cell to `type`'s typed representation, via `parseInteger` / `parseReal` / `parseBoolean`; unchanged for `'text'` (or unreachable `'json'`/`'blob'`). |
| `inferRows`       | function | `(rows: readonly Row[], columns: readonly string[]) => readonly Row[]`                           | Applies whole-column type inference to a built row set — copy-on-write, never mutates `rows`.                                                                           |
| `parseCSV`        | function | `(input: string, options?: ParseOptions) => CSVParseResult`                                      | Parses `input` into a typed `CSVParseResult` — header mapping, ragged-row handling, and optional type inference. Never throws on malformed data unless `strict` is set. |
| `parseInteger`    | function | `(value: string) => number \| undefined`                                                         | Coerces a raw cell string to a canonical integer — `undefined` for leading zeros, decimals, unsafe magnitude, or non-numeric text.                                      |
| `parseReal`       | function | `(value: string) => number \| undefined`                                                         | Coerces a raw cell string to a canonical decimal (or integer) — `undefined` otherwise.                                                                                  |
| `parseBoolean`    | function | `(value: string) => boolean \| undefined`                                                        | Coerces a raw cell string to a strict boolean — `true`/`false` only for the exact canonical forms, `undefined` otherwise.                                               |
| `parseJSON`       | function | `(value: string) => unknown`                                                                     | Coerces a raw cell string to a parsed JSON value — `undefined` on failure.                                                                                              |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`), from
[`shapers.ts`](../../src/core/shapers.ts) — one shape compiles into a guard,
coercing parser, JSON Schema, and seeded generator.

| Shaper            | Kind     | Signature                             | Behavior                                                                                                                 |
| ----------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `columnTypeShape` | function | `(type: ColumnType) => ContractShape` | The `ContractShape` a `ColumnType`'s values must satisfy — `text`/`blob` shape as strings, `json` as any JSON value.     |
| `csvTableShape`   | const    | `ContractShape`                       | The shape of a `CSVTable` — an ordered `columns` list of strings plus `rows`, each an open record of JSON-shaped values. |

### Validators

Guards from [`validators.ts`](../../src/core/validators.ts) — total, never
throw, return `false` for any off-shape input (AGENTS §14).

| Guard          | Kind     | Narrows to / Tests                   | Behavior                                                                                                                          |
| -------------- | -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `isRow`        | function | `value: unknown`                     | Determines whether `value` is a valid `Row` — accepts both an object literal and a null-prototype object.                         |
| `isCSVTable`   | const    | `Guard<CSVTable>`                    | Determines whether `value` is a valid `CSVTable` — an array of column names plus an array of `Row`s.                              |
| `isRowList`    | function | `source: CSVTable \| readonly Row[]` | Narrows a `CSVTable \| readonly Row[]` union to its row-list member — `true` when `source` is a plain row list (`Array.isArray`). |
| `isColumnType` | const    | `Guard<ColumnType>`                  | Determines whether `value` is one of the six `ColumnType` literals.                                                               |

### `CSV`

The implementing class of `CSVInterface`, from [`CSV.ts`](../../src/core/CSV.ts).
A parsed, queryable CSV document: constructed from a CSV `string` (runs
`parseCSV`) or an already-parsed `CSVTable` (adopted AS-IS, not re-validated —
`errors` is empty in that case). Exposes its parsed state through the
`readonly table`, `readonly rows`, and `readonly errors` members (documented
here in Surface prose alongside the class, per the markdown sibling's
precedent — these carry no row in the [`## Methods`](#methods) table below,
which lists only call-signature members). Immutable — `map` never mutates the
stored table, it returns a new `CSV`. See [`## Methods`](#methods) for its
public call-signature surface.

### Factories

From [`factories.ts`](../../src/core/factories.ts).

| Factory               | Kind     | Signature                                                             | Behavior                                                                                                        |
| --------------------- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `createCSV`           | function | `(input: string \| CSVTable, options?: ParseOptions) => CSVInterface` | Creates a working `CSVInterface` from a CSV string (parses it) or an already-parsed `CSVTable` (adopted as-is). |
| `createTableContract` | function | `(columns: Columns) => ContractInterface<Row>`                        | Compiles a `Columns` map into a `Row` contract — a guard, coercing parser, JSON Schema, and seeded generator.   |

## Methods

The public methods of `CSVInterface`, keyed by its backticked name (AGENTS
§22). The `readonly table` / `rows` / `errors` members are Surface-documented
above, not listed here — this table lists exactly `CSVInterface`'s
call-signature members.

#### `CSVInterface`

| Method   | Returns               | Behavior                                                                                                        |
| -------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `find`   | `Row \| undefined`    | Finds the first row matching a predicate, tested against each row (and its index) in table order.               |
| `filter` | `readonly Row[]`      | Collects every row matching a predicate, in table order.                                                        |
| `map`    | `CSVInterface`        | Rewrites every row (copy-on-write) via a callback and returns a NEW `CSVInterface`; never mutates the original. |
| `reduce` | `T`                   | Folds the rows, in table order, into an accumulator via a plain reducer callback.                               |
| `stream` | `ReadableStream<Row>` | A fresh, web-standard, pull-based stream over the table's rows (source order); one row enqueued per `pull`.     |
| `toJSON` | `CSVTable`            | Returns the stored `CSVTable` — the JSON-serializable projection.                                               |
| `export` | `TableExport`         | Produces a portable `{ key, columns, schema }` export for moving this CSV's schema elsewhere.                   |

## RFC 4180 and dialects

`parseCSV` / `readRecords` honor the RFC 4180 grammar — quoted fields, an
embedded delimiter/quote/newline inside a quoted field, and doubled quotes as
the escape convention — while accepting the common real-world dialect
variants: `\r\n`, bare `\n`, and bare `\r` line endings are all recognized (a
CRLF pair counts as one line break), and a mix of them within the same
document is handled record-by-record. A single leading UTF-8 byte-order-mark
is always stripped before scanning, regardless of `options`. `delimiter`,
`quote`, and `escape` (`'double'` doubles an embedded quote, `'backslash'`
prefixes it) are all caller-configurable knobs, validated by
`assertValidSeparators` (each exactly one character, distinct from each
other, and never CR/LF/BOM). Tab-separated output is a `renderCSV` dialect,
not a separate parser: call `renderTSV`, or `renderCSV` with
`delimiter: '\t'`.

## Total parsing and the error model

`parseCSV` never throws on malformed DATA — every malformation (an
unterminated quote, a bad quote placement, a ragged row, a duplicate or
empty header, the record limit) is collected as a `CSVError` into the
result's `errors` list, capped at `MAX_ERRORS` (further malformations past
the cap are silently no longer recorded; scanning still continues). Each
`CSVError` carries a machine-readable `code` (a `CSVErrorCode`) plus, for a
parse-time malformation, the 1-based `line`/`column` and 0-based `offset`
into the (post-BOM) source, with `column` and `offset` measured in UTF-16
code units. Setting `strict: true` flips this to throw-on-
first-error: the first collected error throws immediately instead of being
returned. An invalid OPTION (`INVALID_OPTION` — a malformed delimiter/quote
pair, an empty `comment`, a negative `limit`, a bad `newline`) is always a
thrown programmer error, never collected, regardless of `strict` (AGENTS
§12). A ragged row — a record whose field count does not match the header —
is handled per `RaggedPolicy`: `'collect'` pads/truncates the row AND records
`RAGGED_ROW`; `'pad'` does the same silently (no error recorded); `'error'`
excludes the row entirely (still recording `RAGGED_ROW`). A duplicate or
empty header name is deterministically renamed via `uniqueColumns` (a repeat
gets a `_2`, `_3`, … suffix; a blank name becomes positional) so the table
always has a full, unique column list even when the header itself was
malformed.

## Security

Every parsed row is built with `Object.create(null)` — a null-prototype
object — so a hostile header name (`__proto__`, `constructor`, `prototype`)
becomes a plain OWN property on the row that can never reach
`Object.prototype`; there is no prototype-pollution path through a CSV
header, however adversarial. On the render side, `renderCSV` guards against
CSV/spreadsheet formula injection (the OWASP CSV-injection guidance): a field
whose first character is one of `SANITIZE_PREFIXES` (`=`, `+`, `-`, `@`, tab,
CR, LF) is prefixed with a protective `'` when `RenderOptions.sanitize` is
`true` (the default) — EXCEPT a `+`/`-`-led field that is a plain signed
number (`NUMERIC_PATTERN`), which is left untouched so legitimate numeric
data round-trips unmodified. This is a known, intentionally-scoped mitigation
— it defends against the ASCII formula-trigger characters the OWASP guidance
names, not against homoglyph or zero-width-character bypasses (a
lookalike `＝` or a zero-width-joined `=` would not match
`SANITIZE_PREFIXES`); that class of evasion is out of scope for this layer.

## Conservative inference

Type inference (`ParseOptions.infer`) is OFF by default — every field parses
as a `string` unless a caller opts in. When enabled, `inferColumnType`
decides a type for a WHOLE column at once (never per-cell), so a column with
even one non-conforming value stays `'text'` entirely. Several common traps
stay text deliberately: a leading-zero numeral (`'007'`) fails
`INTEGER_PATTERN` (which permits no leading zeros beyond a bare `0`) and so
never infers as a number — a phone number or zip code is preserved verbatim;
scientific notation (`'1e5'`) and `NaN`/`Infinity` are not matched by either
numeric pattern and stay text; a value outside `Number.isSafeInteger` range
stays text even though its digits match `INTEGER_PATTERN`; a date string and
a decimal-comma number (`'3,14'`) both fail both numeric patterns and stay
text. The two numeric outcomes split on whether any cell carries a fractional
part: all-integer cells infer `'integer'`, any decimal cell present promotes
the WHOLE column to `'real'`. `inferColumnType` never infers `'json'` or
`'blob'` — those require an explicit `Columns` declaration naming the shape.

## Database interop without dependency

A `Row` is `Record<string, unknown>` — a plain record any database `Table`'s
`set`/`add` primitives can accept directly, with no adapter layer and no
runtime dependency on `@orkestrel/database` (this package never imports it).
`CSVInterface.toJSON` returns the stored `CSVTable` — the JSON-serializable
seam a CSV round-trips through when crossing a process boundary or a
`JSON.stringify` call. `CSVInterface.export` (and the standalone
`createTableContract` factory) produce a `TableExport` — `{ key, columns,
schema }` — that mirrors `@orkestrel/database`'s `TableExport` shape
member-for-member: `columns` is the same `Columns` map (a column name keyed
to a `ContractShape`) either package can declare, and `schema` is the JSON
Schema `@orkestrel/contract` compiles from it. The interop is purely
structural — no import crosses the package boundary in either direction — so
a CSV export re-imports losslessly as a database table definition, and vice
versa.

## Streaming boundary

`CSVInterface.stream` returns a web-standard `ReadableStream<Row>` — a fresh,
pull-based stream every call, enqueuing one already-parsed row per `pull` so
a slow consumer's backpressure is respected. This is a POST-PARSE row
stream, not chunked ingestion: the entire CSV text is parsed up front (by
`parseCSV`, synchronously, into a complete `CSVTable`) before `stream()` ever
enqueues a row. Whole-string parsing is this package's v1 boundary — there is
no incremental/chunked parser that consumes a text stream and emits rows as
they arrive; a caller with a very large file reads it fully into memory
first.

## Patterns

Every feature below has a compact, runnable example.

### Parse and query

```ts
import { createCSV } from '@src/core'

const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })
csv.table // { columns: ['name', 'age'], rows: [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }] }

const ada = csv.find((row) => row.name === 'Ada') // Row | undefined
const adults = csv.filter((row) => Number(row.age) >= 40) // readonly Row[]
```

### Rewrite with `map`, then render back

```ts
import { createCSV } from '@src/core'
import { renderCSV } from '@src/core'

const csv = createCSV('name,age\nAda,36', { infer: true })
const older = csv.map((row) => ({ ...row, age: Number(row.age) + 1 }))

renderCSV(older.toJSON()) // 'name,age\r\nAda,37'
```

Each `map` call returns a NEW `CSVInterface` — the original `csv` is never
mutated.

### Reduce into an accumulator

```ts
import { createCSV } from '@src/core'

const csv = createCSV('amount\n10\n20\n30', { infer: true })

const total = csv.reduce<number>((sum, row) => sum + Number(row.amount), 0) // 60
```

### Streaming rows

```ts
import { createCSV } from '@src/core'

const csv = createCSV('a\n1\n2\n3')

const reader = csv.stream().getReader()
const values: string[] = []
for (let result = await reader.read(); !result.done; result = await reader.read()) {
	values.push(String(result.value.a))
}
// values: ['1', '2', '3']
```

### Handling errors without `strict`

```ts
import { createCSV, isCSVError } from '@src/core'

const csv = createCSV('a,b\n1,2,3') // ragged row — collected, not thrown
csv.errors.length > 0 // true
for (const error of csv.errors) {
	if (isCSVError(error)) console.warn(error.code, error.line)
}
```

### `strict` mode throws the first error

```ts
import { createCSV, isCSVError } from '@src/core'

try {
	createCSV('a,b\n1,2,3', { strict: true })
} catch (error) {
	if (isCSVError(error)) error.code // 'RAGGED_ROW'
}
```

### Exporting a portable schema

```ts
import { createCSV } from '@src/core'

const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })
const table = csv.export() // { key: 'id', columns: {...}, schema: {...} }
table.schema // a JSON Schema describing every column
```

### Contract-backed row validation

```ts
import { createTableContract, columnTypeShape } from '@src/core'

const contract = createTableContract({
	id: columnTypeShape('integer'),
	name: columnTypeShape('text'),
})
contract.is({ id: 1, name: 'Ada' }) // true
contract.is({ id: 'x', name: 'Ada' }) // false
```

### Guarding an adopted table

```ts
import { createCSV, isCSVTable } from '@src/core'
import type { CSVTable } from '@src/core'

function adopt(candidate: unknown) {
	if (!isCSVTable(candidate)) return undefined // total guard - never throws
	return createCSV(candidate as CSVTable) // adopted AS-IS, not re-parsed
}
```

### Rendering to TSV

```ts
import { renderTSV } from '@src/core'

renderTSV({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }] }) // 'a\tb\r\n1\t2'
```

### Tokenizer leaves directly

```ts
import { coerceInferred, isBreakChar, isRowList, resolveParseOptions, scanField } from '@src/core'

isBreakChar('\n') // true
isBreakChar('a') // false

const scan = scanField('ab,c', { offset: 0, line: 1, column: 1 }, resolveParseOptions())
scan.field // { value: 'ab', quoted: false }

coerceInferred('42', 'integer') // 42

isRowList([{ a: 1 }]) // true
isRowList({ columns: ['a'], rows: [{ a: 1 }] }) // false
```

## Tests

- [`../../tests/src/core/CSV.test.ts`](../../tests/src/core/CSV.test.ts) —
  construction from a string vs. an adopted table, `find`/`filter`/`reduce`,
  and `map` copy-on-write behavior.
- [`../../tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) —
  `createCSV` and `createTableContract` return working, correctly-typed
  results.
- [`../../tests/src/core/helpers.test.ts`](../../tests/src/core/helpers.test.ts) —
  `stripBom`, option resolution (incl. `INVALID_OPTION` throws), type
  inference traps, cell coercion, column disambiguation, sanitization, and
  `renderCSV`/`renderTSV`.
- [`../../tests/src/core/parsers.test.ts`](../../tests/src/core/parsers.test.ts) —
  `readRecords` and `parseCSV`, incl. ragged-row policies, header handling,
  and `strict`-mode throwing.
- [`../../tests/src/core/shapers.test.ts`](../../tests/src/core/shapers.test.ts) —
  `columnTypeShape` per `ColumnType`, and `csvTableShape` structural
  validation.
- [`../../tests/src/core/validators.test.ts`](../../tests/src/core/validators.test.ts) —
  `isRow`, `isCSVTable`, and `isColumnType` soundness on well-formed and
  off-shape input.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules; §5 centralized-file pattern,
  §12 error handling, §14 guard totality, §22 documentation-as-contracts.
- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the
  devDependency powering this repo's guides-parity test suite.
- [`contract.md`](contract.md) — the mirrored guide for `@orkestrel/contract`,
  this package's runtime dependency for shapes, guards, and compiled
  contracts.
- [`README.md`](../README.md) — the guides index.
