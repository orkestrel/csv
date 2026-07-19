import type { ContractInterface } from '@orkestrel/contract'
import type { Columns, CSVInterface, CSVTable, ParseOptions, Row } from './types.js'
import { createContract, objectShape } from '@orkestrel/contract'
import { CSV } from './CSV.js'

/**
 * Create a working {@link CSVInterface} from a CSV string or an already-parsed
 * {@link CSVTable}.
 *
 * @remarks
 * Given a `string`, runs the parser to build the {@link CSVTable} - a
 * malformed record is collected into `errors` unless `options.strict` is set,
 * in which case a {@link CSVError} is thrown immediately; an invalid
 * `options` value throws a {@link CSVError} with code `INVALID_OPTION`. Given
 * a {@link CSVTable}, the table is adopted AS-IS and is NOT re-validated -
 * `errors` is empty in that case.
 *
 * @param input - A CSV string to parse, or an already-parsed {@link CSVTable}
 * @param options - See {@link ParseOptions}
 * @returns A working {@link CSVInterface}
 *
 * @example
 * ```ts
 * import { createCSV } from '@src/core'
 *
 * const csv = createCSV('a,b\n1,2', { infer: true })
 * csv.rows // [{ a: 1, b: 2 }]
 * ```
 */
export function createCSV(input: string | CSVTable, options?: ParseOptions): CSVInterface {
	return new CSV(input, options)
}

/**
 * Compile a {@link Columns} map into a {@link ContractInterface} for a
 * {@link Row} - a guard, coercing parser, JSON Schema, and seeded generator
 * from one shape declaration (AGENTS §14).
 *
 * @remarks
 * The bridge for typed export/import interop with `@orkestrel/database`
 * (never imported here) - the returned contract's `schema` is structurally
 * identical to what {@link CSVInterface.export}'s `TableExport.schema`
 * produces for the same `columns`.
 *
 * @param columns - The column name → value-shape map to compile
 * @returns A `Row` contract bundling `schema` / `is` / `parse` / `explain` / `generate`
 *
 * @example
 * ```ts
 * import { createTableContract } from '@src/core'
 * import { columnTypeShape } from '@src/core'
 *
 * const contract = createTableContract({ id: columnTypeShape('integer') })
 * contract.is({ id: 1 }) // true
 * ```
 */
export function createTableContract(columns: Columns): ContractInterface<Row> {
	return createContract(objectShape(columns))
}
