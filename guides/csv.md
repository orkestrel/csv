# CSV

> A types-first RFC 4180 CSV parser and renderer — a hand-written,
> single-pass tokenizer that turns CSV text into a typed `CSVTable`, and a
> stateful `CSV` workspace that wraps that table with query, rewrite,
> streaming, and export operations.

Parse once, then treat every read as a projection of the parsed table.
`parseCSV` runs a tokenizer phase — `readRecords`, a character scanner
honoring quoting, escaping, and CRLF, LF, and CR line endings — then a
table-building phase of header mapping, ragged-row handling, and optional
whole-column type inference, and returns a `CSVParseResult` pairing the table
with any `CSVError`s collected along the way. The renderer, `renderCSV`, is a
separate downstream projection from a table (or plain row list) back to text;
it never assumes its input came from `parseCSV`. Every row is built with a
null prototype, so a hostile header name (`__proto__`) can never reach
`Object.prototype`, and `renderCSV` sanitizes every field against CSV formula
injection by default. Parsing never throws on malformed data — a `CSVError`
(a machine-readable `code` plus `line` / `column` / `offset`) is collected
into the result's `errors` instead, unless `strict` is set, in which case the
first collected error throws immediately. An invalid option
(`INVALID_OPTION`) always throws — that is a programmer error, not a parse
malformation. Source: [`src/core`](../src/core). Surfaced through the
`@src/core` barrel.

## Surface

Parse a document with `createCSV`, infer its column types, and read the rows
as typed records:

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })
csv.rows // [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }]
```

### Types

The full parse/render/export shape, from [`types.ts`](../src/core/types.ts). An
interface's call-signature members are documented under
[`## Methods`](#methods).

A `Shape` cell holds an interface's data members as bare names in braces, `?`
marking an optional member and `plus` introducing its call-signature members,
and a type alias's own type literal with a union's arms escaped as `\|`.

| Type                    | Kind      | Shape                                                                                                                                 | Summary                                                                                                                                                                                                             |
| ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Row`                   | type      | `Record<string, unknown>`                                                                                                             | Represents a CSV row — a plain record of column values keyed by column name.                                                                                                                                        |
| `CSVTable`              | interface | `{ columns, rows }`                                                                                                                   | Represents a parsed CSV table — the typed rows plus the column order they were parsed (or declared) in.                                                                                                             |
| `RawField`              | interface | `{ value, quoted }`                                                                                                                   | Represents one raw parsed field — the value exactly as it appeared in a record, before type inference or column mapping, plus whether it was quoted in the source.                                                  |
| `Position`              | interface | `{ offset, line, column }`                                                                                                            | Represents a cursor position in a parsed source text — relative to the input after byte-order-mark removal.                                                                                                         |
| `RawRecord`             | interface | `{ fields, start }`                                                                                                                   | Represents one raw parsed record — its ordered `RawField`s plus where the record begins in the source, before header mapping.                                                                                       |
| `FieldScan`             | interface | `{ field, next, errors }`                                                                                                             | Represents one scanned field — a single `RawField` the tokenizer produced, the `Position` immediately after it, and any malformations found while scanning it.                                                      |
| `RecordScan`            | interface | `{ record, next, errors }`                                                                                                            | Represents one scanned record — a single `RawRecord` the tokenizer produced, the `Position` immediately after it, and any malformations found while scanning it.                                                    |
| `HeaderResult`          | interface | `{ columns, body, errors }`                                                                                                           | Represents the result of resolving a header record — the disambiguated column names, the remaining body records, and any header-related errors.                                                                     |
| `RowResult`             | interface | `{ row?, error? }`                                                                                                                    | Represents the result of building one `RawRecord` into a typed `Row` — the row, the error that excluded it, or both when `ParseOptions.ragged` is `'collect'`.                                                      |
| `RecordsResult`         | interface | `{ records, errors }`                                                                                                                 | Represents the result of the record-splitting phase — every `RawRecord` the tokenizer produced plus any `CSVError`s collected along the way.                                                                        |
| `CSVParseResult`        | interface | `{ table, errors }`                                                                                                                   | Represents the result of a full parse — the assembled `CSVTable` plus any `CSVError`s collected along the way.                                                                                                      |
| `EscapeStyle`           | type      | `'double' \| 'backslash'`                                                                                                             | Names how an embedded quote character is escaped inside a quoted field.                                                                                                                                             |
| `QuoteStyle`            | type      | `'minimal' \| 'always' \| 'nonnumeric'`                                                                                               | Names the renderer's quoting policy — which fields get wrapped in quotes.                                                                                                                                           |
| `RaggedPolicy`          | type      | `'collect' \| 'pad' \| 'error'`                                                                                                       | Names how the parser treats a record whose field count does not match the header.                                                                                                                                   |
| `ColumnType`            | type      | `'text' \| 'integer' \| 'real' \| 'boolean' \| 'json' \| 'blob'`                                                                      | Names a portable storage type for a column — the same literal set `@orkestrel/database` declares as `ColumnStorage` (never imported), so a CSV column map and a database table schema stay drop-in interchangeable. |
| `Columns`               | type      | `Readonly<Record<string, ContractShape>>`                                                                                             | Represents a CSV's declared columns — a map of column name to its value `ContractShape`.                                                                                                                            |
| `ParseOptions`          | interface | `{ delimiter?, quote?, escape?, header?, comment?, blanks?, trim?, ragged?, infer?, limit?, strict? }`                                | Represents the options for parsing CSV text into a `CSVTable`.                                                                                                                                                      |
| `ResolvedParseOptions`  | type      | `Required<Omit<ParseOptions, 'comment'>> & Pick<ParseOptions, 'comment'>`                                                             | Represents the fully-resolved parse configuration every tokenizer and table-building helper takes — `ParseOptions` with every member defaulted except `comment`, which has no default and stays optional.           |
| `RenderOptions`         | interface | `{ delimiter?, quote?, escape?, newline?, header?, columns?, quotes?, blank?, sanitize?, bom? }`                                      | Represents the options for rendering a `CSVTable` (or row list) back to CSV text.                                                                                                                                   |
| `ResolvedRenderOptions` | type      | `Required<Omit<RenderOptions, 'columns'>> & Pick<RenderOptions, 'columns'>`                                                           | Represents the fully-resolved render configuration every quoting and rendering helper takes — `RenderOptions` with every member defaulted except `columns`, which has no default and stays optional.                |
| `ExportOptions`         | interface | `{ key?, columns? }`                                                                                                                  | Represents the options for `CSVInterface.export`.                                                                                                                                                                   |
| `TableExport`           | interface | `{ key, columns, schema }`                                                                                                            | Represents a CSV's portable definition, produced by `CSVInterface.export` — the unit of schema exchange across environments.                                                                                        |
| `CSVErrorCode`          | type      | `'UNTERMINATED_QUOTE' \| 'BAD_QUOTE' \| 'RAGGED_ROW' \| 'DUPLICATE_HEADER' \| 'EMPTY_HEADER' \| 'LIMIT_EXCEEDED' \| 'INVALID_OPTION'` | Names a machine-readable `CSVError` code.                                                                                                                                                                           |
| `CSVInterface`          | interface | `{ table, rows, errors } plus find, filter, map, reduce, stream, toJSON, export`                                                      | Represents a parsed, queryable CSV document — the typed `CSVTable` plus the query, rewrite, and export operations over it.                                                                                          |

### Errors

From [`errors.ts`](../src/core/errors.ts). An invalid option or programmer
error always throws a `CSVError`; a parse-time malformation is collected
into a result's `errors` unless `strict` is set.

| Error        | Kind     | Signature                               | Summary                                                                                                                                                         |
| ------------ | -------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSVError`   | class    | `extends Error`                         | Represents an error surfaced by the CSV layer — either thrown for a programmer error / `strict`-mode parse failure, or collected into a result's `errors` list. |
| `isCSVError` | function | `(value: unknown) => value is CSVError` | Narrows an unknown caught value to a `CSVError`.                                                                                                                |

### Constants

Centralized, frozen data the parser/renderer draw their defaults and
canonical patterns from, from [`constants.ts`](../src/core/constants.ts).

A `Shape` cell holds the constant's declared type.

| Constant                   | Kind  | Shape                                      | Summary                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ----- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BOM`                      | const | `string`                                   | Names the UTF-8 byte-order-mark character, `'\uFEFF'`, prepended when `RenderOptions.bom` is `true`.                                                                                                                                                                                                      |
| `DEFAULT_PARSE_OPTIONS`    | const | `Required<Omit<ParseOptions, 'comment'>>`  | Holds the resolved default `ParseOptions` (everything but `comment`, which has no default) — what `parseCSV` uses for any option left unspecified: `{ delimiter: ',', quote: '"', escape: 'double', header: true, blanks: true, trim: false, ragged: 'collect', infer: false, limit: 0, strict: false }`. |
| `DEFAULT_RENDER_OPTIONS`   | const | `Required<Omit<RenderOptions, 'columns'>>` | Holds the resolved default `RenderOptions` (everything but `columns`, which has no default) — what `renderCSV` uses for any option left unspecified: `{ delimiter: ',', quote: '"', escape: 'double', newline: '\r\n', header: true, quotes: 'minimal', blank: '', sanitize: true, bom: false }`.         |
| `SANITIZE_PREFIXES`        | const | `ReadonlySet<string>`                      | Lists the leading characters the OWASP CSV-injection guard treats as formula-triggering — a field starting with any of these is prefixed with a protective `'` when `RenderOptions.sanitize` is `true`.                                                                                                   |
| `POSITIONAL_COLUMN_PREFIX` | const | `string`                                   | Names the prefix used for positional columns (`column1`, `column2`, …) when `ParseOptions.header` is `false`, or a header field is empty — 1-based, `'column'`.                                                                                                                                           |
| `SANITIZE_ESCAPE`          | const | `string`                                   | Names the protective prefix `sanitizeField` prepends to a field starting with a formula-triggering character (the OWASP CSV-injection guidance), `"'"`.                                                                                                                                                   |
| `SUFFIX_SEPARATOR`         | const | `string`                                   | Names the separator between a disambiguated column name and its collision counter (`name` → `name_2`, `name_3`, …) — see `uniqueName`, `'_'`.                                                                                                                                                             |
| `INTEGER_PATTERN`          | const | `RegExp`                                   | Matches a canonical integer only — an optional leading `-`, no leading zeros (except the bare digit `0`), digits only. No `+` sign, no whitespace.                                                                                                                                                        |
| `REAL_PATTERN`             | const | `RegExp`                                   | Matches a canonical decimal only — an optional leading `-`, an integer part with no leading zeros (except the bare digit `0`), an optional `.` followed by at least one digit. No scientific notation, no `NaN` / `Infinity`, no decimal comma, no trailing dot.                                          |
| `NUMERIC_PATTERN`          | const | `RegExp`                                   | Matches what the renderer treats as a plain number for the `'nonnumeric'` `QuoteStyle` and the sanitize `+` / `-` exemption — like `REAL_PATTERN` but also allowing a leading `+`.                                                                                                                        |
| `BOOLEAN_TRUE`             | const | `string`                                   | Names the canonical serialized form of the boolean `true` — the string `'true'`.                                                                                                                                                                                                                          |
| `BOOLEAN_FALSE`            | const | `string`                                   | Names the canonical serialized form of the boolean `false` — the string `'false'`.                                                                                                                                                                                                                        |
| `MAX_ERRORS`               | const | `number`                                   | Sets the maximum number of `CSVError`s collected into a parse result, `100` — once reached, error collection stops (earlier records already parsed are kept, later malformations are silently no longer recorded).                                                                                        |

### Helpers

Pure, total, zero-dependency leaves from
[`helpers.ts`](../src/core/helpers.ts) — the option resolvers, the
hand-written tokenizer and table builders `parsers.ts` composes, and the
rendering projections callers reach for directly. Every function is
unit-testable in isolation.

| Helper                  | Kind     | Signature                                                                                                                                            | Summary                                                                                                                                                                                                                                       |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assertValidSeparators` | function | `(delimiter: string, quote: string) => void`                                                                                                         | Validates a delimiter / quote pair shared by both `resolveParseOptions` and `resolveRenderOptions` — each must be exactly one character, they must differ, and neither may be CR, LF, or the BOM character.                                   |
| `resolveParseOptions`   | function | `(options?: ParseOptions) => ResolvedParseOptions`                                                                                                   | Merges `options` over `DEFAULT_PARSE_OPTIONS` into a fully-resolved parse configuration.                                                                                                                                                      |
| `resolveRenderOptions`  | function | `(options?: RenderOptions) => ResolvedRenderOptions`                                                                                                 | Merges `options` over `DEFAULT_RENDER_OPTIONS` into a fully-resolved render configuration.                                                                                                                                                    |
| `uniqueName`            | function | `(name: string, taken: ReadonlySet<string>) => string`                                                                                               | Disambiguates a single column name against the names already taken — the collision leaf `uniqueColumns` composes over an entire header.                                                                                                       |
| `uniqueColumns`         | function | `(names: readonly string[]) => readonly string[]`                                                                                                    | Disambiguates a header's column names deterministically — an empty (or whitespace-only) name becomes positional, and a name that repeats an earlier kept name is suffixed `_2`, `_3`, … until unique.                                         |
| `sanitizeField`         | function | `(field: string) => string`                                                                                                                          | Guards a field against CSV/spreadsheet formula injection (the OWASP CSV-injection guidance) — a field starting with a formula-triggering character is prefixed with a protective `SANITIZE_ESCAPE`.                                           |
| `serializeCell`         | function | `(value: unknown, blank: string) => string`                                                                                                          | Serializes one cell value to its rendered text — the renderer's stringify leaf, applied before sanitize/quote.                                                                                                                                |
| `deriveColumns`         | function | `(rows: readonly Row[]) => readonly string[]`                                                                                                        | Derives a column order from a plain row list — the first-seen union of every row's keys, in encounter order.                                                                                                                                  |
| `needsQuote`            | function | `(field: string, options: ResolvedRenderOptions) => boolean`                                                                                         | Checks `field` against the correctness floor every `QuoteStyle` policy respects — a field containing the delimiter, the quote character, CR, or LF must ALWAYS be quoted regardless of policy.                                                |
| `wrapQuoted`            | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | Wraps `field` in quotes, escaping per `options.escape` — the shared quote-and-escape step every quoting policy applies once it decides `field` needs quoting; it IS the `'always'` `QuoteStyle` as well (every field quoted unconditionally). |
| `quoteMinimal`          | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | Implements the `'minimal'` `QuoteStyle` — quotes a field only when `needsQuote` requires it.                                                                                                                                                  |
| `quoteNonnumeric`       | function | `(field: string, options: ResolvedRenderOptions) => string`                                                                                          | Implements the `'nonnumeric'` `QuoteStyle` — quotes every field whose value is not a plain number (or that `needsQuote` requires regardless).                                                                                                 |
| `renderRecord`          | function | `(row: Row, columns: readonly string[], options: ResolvedRenderOptions, quote: (field: string, options: ResolvedRenderOptions) => string) => string` | Renders one row to one delimited line — serializes every column's cell, optionally sanitizes it, then applies the given quoting policy.                                                                                                       |
| `quoteStyleToPolicy`    | function | `(quotes: ResolvedRenderOptions['quotes']) => (field: string, options: ResolvedRenderOptions) => string`                                             | Selects the quoting-policy function for a resolved `options.quotes`.                                                                                                                                                                          |
| `isRowList`             | function | `(source: CSVTable \| readonly Row[]) => source is readonly Row[]`                                                                                   | Narrows a `CSVTable \| readonly Row[]` union to its row-list member.                                                                                                                                                                          |
| `renderCSV`             | function | `(input: CSVTable \| readonly Row[], options?: RenderOptions) => string`                                                                             | Renders a `CSVTable` (or a plain row list) to CSV text.                                                                                                                                                                                       |
| `advancePosition`       | function | `(position: Position, count?: number) => Position`                                                                                                   | Advances a `Position` by `count` NON-line-break characters.                                                                                                                                                                                   |
| `isBreakChar`           | function | `(char: string) => boolean`                                                                                                                          | Checks whether `char` starts a record separator (CR or LF).                                                                                                                                                                                   |
| `scanBreak`             | function | `(source: string, position: Position) => Position \| undefined`                                                                                      | Consumes exactly one line break (CRLF, bare LF, or bare CR) at `position` — a CRLF pair counts as ONE break.                                                                                                                                  |
| `scanComment`           | function | `(source: string, position: Position, options: ResolvedParseOptions) => Position \| undefined`                                                       | Consumes a comment line at `position`, when `options.comment` names one starting there — through the end of that line INCLUDING its break (or end-of-input).                                                                                  |
| `scanUnquoted`          | function | `(source: string, position: Position, options: ResolvedParseOptions) => FieldScan`                                                                   | Scans one unquoted field starting at `position` — content runs until the delimiter, a line break, or end-of-input.                                                                                                                            |
| `scanQuoted`            | function | `(source: string, position: Position, options: ResolvedParseOptions) => FieldScan`                                                                   | Scans one quoted field starting at `position` — `position` must be AT the opening quote character.                                                                                                                                            |
| `scanField`             | function | `(source: string, position: Position, options: ResolvedParseOptions) => FieldScan`                                                                   | Scans one field at `position` — dispatches to `scanQuoted` when the character there is `options.quote`, else `scanUnquoted`.                                                                                                                  |
| `scanRecord`            | function | `(source: string, position: Position, options: ResolvedParseOptions) => RecordScan`                                                                  | Scans one full record at `position` — fields separated by `options.delimiter`, ending at a break (consumed through `scanBreak`) or end-of-input.                                                                                              |
| `readRecords`           | function | `(input: string, options?: ParseOptions) => RecordsResult`                                                                                           | Splits `input` into raw, un-mapped `RawRecord`s — the tokenizer phase beneath `parseCSV`.                                                                                                                                                     |
| `deriveHeader`          | function | `(records: readonly RawRecord[], options: ResolvedParseOptions) => HeaderResult`                                                                     | Resolves a table's header from its raw records — disambiguates the first record's names when `options.header` is `true`, or generates positional names sized to the widest record otherwise.                                                  |
| `buildRow`              | function | `(record: RawRecord, columns: readonly string[], options: ResolvedParseOptions) => RowResult`                                                        | Builds one `RawRecord` into one null-prototype `Row`, padding or truncating to `columns.length` per `options.ragged`.                                                                                                                         |

### Inferers

Whole-column type inference from
[`inferers.ts`](../src/core/inferers.ts) — reads the raw cell text a column
holds, rules which `ColumnType` it carries, and applies that ruling cell by
cell.

| Inferer           | Kind     | Signature                                                              | Summary                                                                                                                                                                                                                                                                                        |
| ----------------- | -------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inferColumnType` | function | `(values: readonly string[]) => ColumnType`                            | Infers a whole column's `ColumnType` conservatively from its raw string values — never `'json'` or `'blob'` (those require an explicit `Columns` declaration). Empty-string cells are ignored entirely (they neither confirm nor demote a type); a column with no non-empty cells is `'text'`. |
| `coerceInferred`  | function | `(value: string, type: ColumnType) => unknown`                         | Coerces one string cell to `type`'s typed representation — the exhaustive per-cell dispatch `inferRows` applies once a column's type is known.                                                                                                                                                 |
| `inferRows`       | function | `(rows: readonly Row[], columns: readonly string[]) => readonly Row[]` | Applies whole-column type inference to a built row set — per column, infers its `ColumnType` from its string cells, then coerces every cell of that type through `coerceInferred`.                                                                                                             |

### Parsers

The coercers, from [`parsers.ts`](../src/core/parsers.ts) — the `parseCSV`
entry point, which composes the `helpers.ts` tokenizer, the `helpers.ts` table
builders, and the `inferers.ts` column inference into a `CSVParseResult`, plus
the flat cell coercers that inference dispatches to.

| Parser         | Kind     | Signature                                                   | Summary                                                                                                                                                                               |
| -------------- | -------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseCSV`     | function | `(input: string, options?: ParseOptions) => CSVParseResult` | Parses `input` into a typed `CSVParseResult` — header mapping, ragged-row handling, and optional type inference on top of `readRecords`, `deriveHeader`, `buildRow`, and `inferRows`. |
| `parseInteger` | function | `(value: string) => number \| undefined`                    | Parses a raw cell string into a canonical integer — `undefined` for anything else (leading zeros, decimals, out-of-safe-range magnitude, non-numeric text).                           |
| `parseReal`    | function | `(value: string) => number \| undefined`                    | Parses a raw cell string into a canonical decimal (or integer) — `undefined` for anything else.                                                                                       |
| `parseBoolean` | function | `(value: string) => boolean \| undefined`                   | Parses a raw cell string into a strict boolean — `undefined` for anything other than the exact canonical forms.                                                                       |

### Shapers

Declarative `ContractShape` values (from `@orkestrel/contract`), from
[`shapers.ts`](../src/core/shapers.ts) — one shape compiles into a guard,
coercing parser, JSON Schema, and seeded generator. `deriveShapes` builds a
whole `Columns` map of them from a table's own cell values.

| Shaper            | Kind     | Signature                             | Summary                                                                                                                                                                                                                              |
| ----------------- | -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `columnTypeShape` | function | `(type: ColumnType) => ContractShape` | Returns the `ContractShape` a `ColumnType`'s values must satisfy.                                                                                                                                                                    |
| `csvTableShape`   | const    | `ContractShape`                       | Represents the `ContractShape` of a `CSVTable`'s JSON-serializable projection — an ordered `columns` list of strings plus `rows`, each an open record of JSON values.                                                                |
| `deriveShapes`    | function | `(table: CSVTable) => Columns`        | Derives one `ContractShape` per table column from that column's cell values across all rows (excluding `undefined`/empty-string cells) — the schema-inference leaf behind `CSVInterface.export` when no explicit `Columns` is given. |

### Validators

Guards from [`validators.ts`](../src/core/validators.ts) — total, never
throw, return `false` for any off-shape input.

In a guard table a `Shape` cell holds the type the guard narrows to.

| Guard          | Kind  | Shape        | Summary                                                                                                         |
| -------------- | ----- | ------------ | --------------------------------------------------------------------------------------------------------------- |
| `isCSVTable`   | const | `CSVTable`   | Determines whether an arbitrary value is a valid `CSVTable` — an array of column names plus an array of `Row`s. |
| `isColumnType` | const | `ColumnType` | Determines whether a value is a valid `ColumnType` literal.                                                     |

### Classes

The implementing class of `CSVInterface`, from [`CSV.ts`](../src/core/CSV.ts) —
documented in full under its own heading following this table.

| Name  | Kind  | Summary                                                                                                                                            |
| ----- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSV` | class | Wraps a typed `CSVTable` with the query (`find` / `filter` / `reduce`), rewrite (`map`), streaming, and export operations `CSVInterface` declares. |

### `CSV`

A `CSV` is constructed from a CSV `string` (which runs `parseCSV`) or from an
already-parsed `CSVTable` (adopted AS-IS, not re-validated — `errors` is empty
in that case). It exposes its parsed state through the `readonly table`,
`readonly rows`, and `readonly errors` members, and it is immutable: `map`
never mutates the stored table, it returns a new `CSV`. See
[`## Methods`](#methods) for its public call-signature surface.

### Factories

From [`factories.ts`](../src/core/factories.ts).

| Factory               | Kind     | Signature                                                             | Summary                                                                                                                                                   |
| --------------------- | -------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createCSV`           | function | `(input: string \| CSVTable, options?: ParseOptions) => CSVInterface` | Creates a working `CSVInterface` from a CSV string or an already-parsed `CSVTable`.                                                                       |
| `createTableContract` | function | `(columns: Columns) => ContractInterface<Row>`                        | Compiles a `Columns` map into a `ContractInterface` for a `Row` — a guard, coercing parser, JSON Schema, and seeded generator from one shape declaration. |

## Methods

The public methods of `CSVInterface`, keyed by its backticked name.

#### `CSVInterface`

| Method   | Returns               | Summary                                                                                                                                                                                                                                           |
| -------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `find`   | `Row \| undefined`    | Finds the first row matching `predicate`, called with each row and its index in table order.                                                                                                                                                      |
| `filter` | `readonly Row[]`      | Collects every row matching `predicate`, called with each row and its index in table order.                                                                                                                                                       |
| `map`    | `CSVInterface`        | Rewrites every row (copy-on-write) and returns a new `CSVInterface`, never mutating this one.                                                                                                                                                     |
| `reduce` | `T`                   | Folds the rows, in table order, into an accumulator through `callback`.                                                                                                                                                                           |
| `stream` | `ReadableStream<Row>` | Returns a web-standard `ReadableStream` over the table's rows (source order) — a lazy, pull-based, backpressure-respecting source that enqueues one row per `pull`. A fresh, independently-replayable stream every call; never mutates the table. |
| `toJSON` | `CSVTable`            | Returns the stored `CSVTable` — the JSON-serializable projection.                                                                                                                                                                                 |
| `export` | `TableExport`         | Produces a portable `TableExport` for moving this CSV's schema elsewhere.                                                                                                                                                                         |

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
not a separate parser: call `renderCSV` with `delimiter: '\t'`.

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
thrown programmer error, never collected, regardless of `strict`. A ragged
row — a record whose field count does not match the header — is handled per
`RaggedPolicy`: `'collect'` pads/truncates the row AND records
`RAGGED_ROW`; `'pad'` does the same silently (no error recorded); `'error'`
excludes the row entirely (still recording `RAGGED_ROW`). A duplicate or
empty header name is deterministically renamed through `uniqueColumns` (a repeat
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
`JSON.stringify` call. `CSVInterface.export` produces a `TableExport` —
`{ key, columns, schema }`. `@orkestrel/database` declares
`TableDefinition { primary, columns, schema }`: this package's `Columns` map
is structurally identical to that package's `ColumnMap`, and `schema` is the
same JSON Schema `@orkestrel/contract` compiles from it. The two name the key
column differently — `key` here, `primary` there. The interop is structural:
no import crosses the package boundary in either direction.

## Streaming boundary

`CSVInterface.stream` returns a web-standard `ReadableStream<Row>` — a fresh,
pull-based stream every call, enqueuing one already-parsed row per `pull` so
a slow consumer's backpressure is respected. This is a POST-PARSE row
stream, not chunked ingestion: the entire CSV text is parsed up front (by
`parseCSV`, synchronously, into a complete `CSVTable`) before `stream()` ever
enqueues a row. The package parses a whole string. It has no incremental
parser that consumes a text stream and emits rows as they arrive, so a
caller with a very large file reads it fully into memory first.

## Patterns

Every feature below has a compact, runnable example.

### Parse and query

Parses a small CSV string with inference, then reads and filters its rows:

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })
csv.table // { columns: ['name', 'age'], rows: [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }] }

const ada = csv.find((row) => row.name === 'Ada') // Row | undefined
const adults = csv.filter((row) => Number(row.age) >= 40) // readonly Row[]
```

### Rewrite with `map`, then render back

Rewrites every row through `map`, then renders the new table back to CSV text:

```ts
import { createCSV } from '@orkestrel/csv'
import { renderCSV } from '@orkestrel/csv'

const csv = createCSV('name,age\nAda,36', { infer: true })
const older = csv.map((row) => ({ ...row, age: Number(row.age) + 1 }))

renderCSV(older.toJSON()) // 'name,age\r\nAda,37'
```

Each `map` call returns a NEW `CSVInterface` — the original `csv` is never
mutated.

### Reduce into an accumulator

Folds every row into a running total through `reduce`:

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('amount\n10\n20\n30', { infer: true })

const total = csv.reduce<number>((sum, row) => sum + Number(row.amount), 0) // 60
```

### Streaming rows

Drains the table through `stream` as a web-standard `ReadableStream`:

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('a\n1\n2\n3')

const reader = csv.stream().getReader()
const values: string[] = []
for (let result = await reader.read(); !result.done; result = await reader.read()) {
	values.push(String(result.value.a))
}
// values: ['1', '2', '3']
```

### Handling errors without `strict`

Collects a ragged-row malformation into `errors` instead of throwing:

```ts
import { createCSV, isCSVError } from '@orkestrel/csv'

const csv = createCSV('a,b\n1,2,3') // ragged row — collected, not thrown
csv.errors.length > 0 // true
for (const error of csv.errors) {
	if (isCSVError(error)) console.warn(error.code, error.line)
}
```

### `strict` mode throws the first error

Throws the first collected error immediately when `strict` is set:

```ts
import { createCSV, isCSVError } from '@orkestrel/csv'

try {
	createCSV('a,b\n1,2,3', { strict: true })
} catch (error) {
	if (isCSVError(error)) error.code // 'RAGGED_ROW'
}
```

### Exporting a portable schema

Exports the parsed table's inferred schema as a portable `TableExport`:

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })
const table = csv.export() // { key: 'id', columns: {...}, schema: {...} }
table.schema // a JSON Schema describing every column
```

### Contract-backed row validation

Compiles a `Columns` map into a `ContractInterface` and validates a row against it:

```ts
import { createTableContract, columnTypeShape } from '@orkestrel/csv'

const contract = createTableContract({
	id: columnTypeShape('integer'),
	name: columnTypeShape('text'),
})
contract.is({ id: 1, name: 'Ada' }) // true
contract.is({ id: 'x', name: 'Ada' }) // false
```

### Guarding an adopted table

Guards an unknown value before adopting it as a `CSVTable`:

```ts
import { createCSV, isCSVTable } from '@orkestrel/csv'

function adopt(candidate: unknown) {
	if (!isCSVTable(candidate)) return undefined // total guard - never throws
	return createCSV(candidate) // adopted AS-IS, not re-parsed
}
```

### Tokenizer leaves directly

Calls the tokenizer and inference leaves directly, without going through `parseCSV`:

```ts
import {
	coerceInferred,
	isBreakChar,
	isRowList,
	resolveParseOptions,
	scanField,
} from '@orkestrel/csv'

isBreakChar('\n') // true
isBreakChar('a') // false

const scan = scanField('ab,c', { offset: 0, line: 1, column: 1 }, resolveParseOptions())
scan.field // { value: 'ab', quoted: false }

coerceInferred('42', 'integer') // 42

isRowList([{ a: 1 }]) // true
isRowList({ columns: ['a'], rows: [{ a: 1 }] }) // false
```

## Tests

- [`tests/guides.test.ts`](../tests/guides.test.ts) — the `## Surface` ↔
  `src/core` bijection (value and type exports), the `CSVInterface` ↔ `CSV`
  method bijection, and the equality gate: every `Summary` cell against its
  declaration's description paragraph, the titled `Parse and query` fence
  against the `@example` block of that title (pinned so the titled pair cannot
  be retired silently), and the README pitch against this guide's tagline. It
  also runs the flagship fences and asserts the values their comments claim.
- [`tests/src/core/CSV.test.ts`](../tests/src/core/CSV.test.ts) —
  construction from a string vs. an adopted table, `find`/`filter`/`reduce`,
  and `map` copy-on-write behavior.
- [`tests/src/core/factories.test.ts`](../tests/src/core/factories.test.ts) —
  `createCSV` and `createTableContract` return working, correctly-typed
  results.
- [`tests/src/core/helpers.test.ts`](../tests/src/core/helpers.test.ts) —
  separator validation and option resolution (incl. `INVALID_OPTION`
  throws), column disambiguation, sanitization, cell serialization, the
  quoting policies, `isRowList` narrowing, `renderCSV` including its
  tab-delimiter dialect, and the tokenizer and table-builder leaves
  (`advancePosition` through `buildRow`).
- [`tests/src/core/inferers.test.ts`](../tests/src/core/inferers.test.ts) —
  `inferColumnType` against the classic inference traps, `coerceInferred`
  dispatch per `ColumnType`, and `inferRows` copy-on-write.
- [`tests/src/core/parsers.test.ts`](../tests/src/core/parsers.test.ts) —
  the flat cell coercers and `parseCSV`, incl. ragged-row policies, header
  handling, and `strict`-mode throwing.
- [`tests/src/core/shapers.test.ts`](../tests/src/core/shapers.test.ts) —
  `columnTypeShape` per `ColumnType`, `csvTableShape` structural validation,
  and `deriveShapes` column derivation.
- [`tests/src/core/validators.test.ts`](../tests/src/core/validators.test.ts) —
  `isCSVTable` and `isColumnType` soundness on well-formed and off-shape
  input, incl. its leniency-lock cases against `csvTableShape`.

## See also

- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the
  devDependency powering this repo's guides-parity test suite.
- [`contract.md`](contract.md) — the mirrored guide for `@orkestrel/contract`,
  this package's runtime dependency for shapes, guards, and compiled
  contracts.
- [`README.md`](README.md) — the guides index.
