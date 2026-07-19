# Csv

> TODO: one-paragraph description of `Csv` — what it is, what problem it
> solves, and how it fits the `@orkestrel` line. Source: [`src/core`](../../src/core).
> Surfaced through the `@src/core` barrel.

## Surface

TODO: a short intro line, then a minimal usage example:

```ts
import { createCsv } from '@src/core'

const instance = createCsv({ id: 'example' })
```

### Factories

| API         | Kind     | Summary                                    |
| ----------- | -------- | ------------------------------------------ |
| `createCsv` | function | Create a `CsvInterface` from `CsvOptions`. |

### Entities

| API   | Kind  | Summary                            |
| ----- | ----- | ---------------------------------- |
| `Csv` | class | Implements `CsvInterface` exactly. |

### Types

| Type           | Kind      | Shape                                                          |
| -------------- | --------- | -------------------------------------------------------------- |
| `CsvOptions`   | interface | `{ id?: string }` — options for `createCsv` / the constructor. |
| `CsvInterface` | interface | `{ id: string }` — a working `Csv`, pure data.                 |

## Tests

- [`../../tests/src/core/CSV.test.ts`](../../tests/src/core/CSV.test.ts) —
  id assignment (explicit / generated) and independence across instances.
- [`tests/src/core/factories.test.ts`](../../tests/src/core/factories.test.ts) —
  `createCsv` returns a working `CsvInterface` backed by a real `Csv`.

## See also

- [`AGENTS.md`](../../AGENTS.md) — the rules.
- [`guide.md`](guide.md) — the mirrored guide for `@orkestrel/guide`, the
  devDependency powering this repo's guides-parity test suite.
- [`README.md`](../README.md) — the guides index.
