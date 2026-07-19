# @orkestrel/csv

A typed CSV toolkit — RFC 4180 parsing and rendering with typed rows, dialect
control, and structural database interop. Part of the `@orkestrel` line.

## Install

```sh
npm install @orkestrel/csv
```

## Requirements

- Node.js >= 22
- ESM-only (no CommonJS build)

## Usage

```ts
import { createCSV } from '@orkestrel/csv'

const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })
csv.rows // [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }]
csv.errors // [] — no malformed records

const adults = csv.filter((row) => Number(row.id) > 1)
adults // [{ id: 2, name: 'Grace' }]
```

`createCSV(input, options)` (or `new CSV(input, options)`) parses a CSV string
into a typed `CSVTable` (`{ columns, rows }`) and stores it as a stateful
workspace — a `CSVInterface` exposing `rows`, `errors`, `find` / `filter` /
`map` / `reduce`, `stream()` (a `ReadableStream<Row>`), `toJSON()`, and
`export()`. Given an already-parsed `CSVTable` instead of a string, the table
is adopted as-is and `errors` is empty. Type inference (`options.infer`) is
conservative and opt-in — left off, every cell is a `string`. Every row is
built with a null prototype, so a hostile header name (`__proto__`,
`constructor`) can never reach `Object.prototype`.

```ts
import { renderCSV } from '@orkestrel/csv'

renderCSV(csv.table)
// 'id,name\r\n1,Ada\r\n2,Grace'
```

`renderCSV(tableOrRows, options)` writes a `CSVTable` (or a plain row list)
back to CSV text; `renderTSV(...)` is a thin delegate that forces
`delimiter: '\t'`. Dialect is controlled through options on both sides —
`delimiter` / `quote` / `escape` / `header` / `trim` / `ragged` / `infer` /
`limit` / `strict` on parse, `quotes` / `blank` / `sanitize` / `bom` /
`newline` / `columns` on render. Rendering sanitizes formula-injection
prefixes (`=`, `+`, `-`, `@`) by default (`options.sanitize`).

## Collecting parse errors with positions

A malformed record does not throw by default — it is collected into `errors`
with a machine-readable `code` and the exact `line` / `column` / `offset`
where it was found:

```ts
import { parseCSV } from '@orkestrel/csv'

const { table, errors } = parseCSV('a,b\n"unterminated,x')
errors[0]?.code // 'UNTERMINATED_QUOTE'
errors[0]?.line // 2

parseCSV('a,b\n"unterminated,x', { strict: true })
// throws the first collected CSVError instead of returning it
```

`CSVError` carries `code`, `line`, `column`, `offset`, and an optional
`context` bag naming the offending field or record. `isCSVError(value)` is a
total guard for narrowing a `catch` binding.

## Exporting a schema for database interop

`CSVInterface.export()` derives a portable `{ key, columns, schema }` from a
CSV's rows — no runtime dependency on `@orkestrel/database`, but structurally
consumable by it (rows are plain records; `export()`'s `schema` is
structurally identical to what `createTableContract` produces for the same
columns):

```ts
const table = csv.export()
table.key // 'id' — the first column, unless options.key overrides it
table.columns // one inferred ContractShape per column
table.schema // the compiled JSON Schema describing every column
```

## Guide

For the full surface — dialect options, ragged-row handling, inference rules,
and the export/import interop shape — see
[`guides/src/csv.md`](guides/src/csv.md).

## Package

Published as a single typed entry point per the `exports` field in
`package.json`.

## License

MIT © [Orkestrel](https://github.com/orkestrel) — see [LICENSE](./LICENSE).
