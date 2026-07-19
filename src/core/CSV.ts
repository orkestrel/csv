import { createContract, objectShape } from '@orkestrel/contract'
import type {
	Columns,
	CSVInterface,
	CSVParseResult,
	CSVTable,
	ExportOptions,
	ParseOptions,
	Row,
	TableExport,
} from './types.js'
import { CSVError } from './errors.js'
import { inferColumnType } from './helpers.js'
import { parseCSV } from './parsers.js'
import { columnTypeShape } from './shapers.js'

/**
 * A parsed, queryable CSV document - wraps a typed {@link CSVTable} with the
 * query (`find` / `filter` / `reduce`), rewrite (`map`), streaming, and
 * export operations {@link CSVInterface} declares.
 *
 * @remarks
 * - **Construction.** Given a `string`, the constructor runs {@link parseCSV}
 *   to build the {@link CSVTable}. Given a {@link CSVTable}, the table is
 *   adopted AS-IS and is NOT re-validated - a caller adopting an untrusted
 *   value should gate it with a guard first; `errors` is empty in that case.
 * - **Immutable.** {@link map} never mutates the stored table - it returns a
 *   NEW {@link CSV} instance. **Traversal order.** `find` / `filter` /
 *   `reduce` iterate `rows` in table order.
 *
 * @example
 * ```ts
 * import { CSV } from '@src/core'
 *
 * const csv = new CSV('a,b\n1,2\n3,4', { infer: true })
 * const doubled = csv.map((row) => ({ ...row, a: Number(row.a) * 2 }))
 * doubled.rows // [{ a: 2, b: '2' }, { a: 6, b: '4' }]
 * ```
 */
export class CSV implements CSVInterface {
	#result: CSVParseResult

	constructor(input: string | CSVTable, options?: ParseOptions) {
		this.#result =
			typeof input === 'string' ? parseCSV(input, options) : { table: input, errors: [] }
	}

	/** The stored {@link CSVTable} (columns + rows). */
	get table(): CSVTable {
		return this.#result.table
	}

	/** The parsed rows, in table order (same as `table.rows`). */
	get rows(): readonly Row[] {
		return this.#result.table.rows
	}

	/** Errors collected while parsing (capped at `MAX_ERRORS`). */
	get errors(): readonly CSVError[] {
		return this.#result.errors
	}

	/**
	 * Finds the first row matching `predicate`.
	 *
	 * @param predicate - Tested against each row (and its index), in table order
	 * @returns The first matching row, or `undefined`
	 *
	 * @example
	 * ```ts
	 * csv.find((row) => row.id === '1')
	 * ```
	 */
	find(predicate: (row: Row, index: number) => boolean): Row | undefined {
		return this.#result.table.rows.find(predicate)
	}

	/**
	 * Collects every row matching `predicate`.
	 *
	 * @param predicate - Tested against each row (and its index), in table order
	 * @returns A new array of every matching row
	 *
	 * @example
	 * ```ts
	 * csv.filter((row) => Number(row.age) >= 18)
	 * ```
	 */
	filter(predicate: (row: Row, index: number) => boolean): readonly Row[] {
		return this.#result.table.rows.filter(predicate)
	}

	/**
	 * Rewrites every row (copy-on-write) and returns a new {@link CSVInterface}.
	 *
	 * @param rewrite - Produces the replacement row for each row (and its index)
	 * @returns A new {@link CSV} wrapping the same columns and the rewritten
	 * rows; the original instance is never mutated
	 * @remarks The returned instance carries the SAME `errors` as this
	 * instance - they describe the source parse, which `map` does not repeat
	 *
	 * @example
	 * ```ts
	 * const upper = csv.map((row) => ({ ...row, name: String(row.name).toUpperCase() }))
	 * ```
	 */
	map(rewrite: (row: Row, index: number) => Row): CSVInterface {
		const table: CSVTable = {
			columns: this.#result.table.columns,
			rows: this.#result.table.rows.map(rewrite),
		}
		const csv = new CSV(table)
		csv.#carry(this.#result.errors)
		return csv
	}

	// Carries the source parse's errors onto a copy-on-write map() result -
	// a fresh CSV built from a plain CSVTable otherwise adopts an empty
	// errors list, since the source parse is not repeated.
	#carry(errors: readonly CSVError[]): void {
		this.#result = { table: this.#result.table, errors }
	}

	/**
	 * Folds the rows, in table order, into an accumulator.
	 *
	 * @param callback - Combines the accumulator with each row (and its index)
	 * @param initial - The starting accumulator value
	 * @returns The final accumulator
	 *
	 * @example
	 * ```ts
	 * const total = csv.reduce((sum, row) => sum + Number(row.amount), 0)
	 * ```
	 */
	reduce<T>(callback: (accumulator: T, row: Row, index: number) => T, initial: T): T {
		return this.#result.table.rows.reduce(callback, initial)
	}

	/**
	 * A web-standard {@link ReadableStream} over the table's rows (source
	 * order) - a fresh, pull-based source per call.
	 *
	 * @returns A `ReadableStream<Row>` that enqueues one row per `pull`
	 *
	 * @example
	 * ```ts
	 * const reader = csv.stream().getReader()
	 * for (let result = await reader.read(); !result.done; result = await reader.read()) {
	 * 	console.log(result.value) // one Row
	 * }
	 * ```
	 */
	stream(): ReadableStream<Row> {
		const rows = this.#result.table.rows
		let index = 0
		return new ReadableStream<Row>({
			pull(controller) {
				if (index < rows.length) {
					controller.enqueue(rows[index])
					index += 1
				} else {
					controller.close()
				}
			},
		})
	}

	/**
	 * Returns the stored {@link CSVTable} - the JSON-serializable projection.
	 *
	 * @returns The `{ columns, rows }` table
	 * @remarks `JSON.stringify(csv)` therefore emits `{ columns, rows }` - the
	 * interop seam shared structurally with `@orkestrel/database`
	 *
	 * @example
	 * ```ts
	 * JSON.stringify(csv) // '{"columns":["a"],"rows":[{"a":"1"}]}'
	 * ```
	 */
	toJSON(): CSVTable {
		return this.#result.table
	}

	/**
	 * Produces a portable {@link TableExport} for moving this CSV's schema
	 * elsewhere.
	 *
	 * @param options - See {@link ExportOptions}
	 * @returns The `{ key, columns, schema }` export
	 * @throws {CSVError} `INVALID_OPTION` when the resolved key is not one of
	 * `table.columns` (including the empty-table case)
	 *
	 * @example
	 * ```ts
	 * csv.export().schema // a JSON Schema describing every column
	 * ```
	 */
	export(options?: ExportOptions): TableExport {
		const key = options?.key ?? this.#result.table.columns[0]
		if (key === undefined || !this.#result.table.columns.includes(key))
			throw new CSVError(
				'INVALID_OPTION',
				`export key '${String(key)}' is not one of the table's columns`,
			)
		const columns = options?.columns ?? this.#deriveColumns()
		const schema = createContract(objectShape(columns)).schema
		return { key, columns, schema }
	}

	// Derives one ContractShape per table column from that column's cell
	// values across all rows (excluding undefined/empty-string cells).
	#deriveColumns(): Columns {
		const columns: Record<string, ReturnType<typeof columnTypeShape>> = {}
		for (const column of this.#result.table.columns) {
			const values = this.#result.table.rows
				.map((row) => row[column])
				.filter((value) => value !== undefined && value !== '')
			if (values.length === 0) {
				columns[column] = columnTypeShape('text')
			} else if (this.#isStringColumn(values)) {
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

	// A type-guard leaf narrowing a mixed cell-value array to an all-string
	// column, so inferColumnType (which takes readonly string[]) is called
	// without a cast.
	#isStringColumn(values: readonly unknown[]): values is readonly string[] {
		return values.every((value) => typeof value === 'string')
	}
}
