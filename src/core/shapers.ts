import type { ContractShape } from '@orkestrel/contract'
import type { Columns, ColumnType, CSVTable } from './types.js'
import {
	arrayShape,
	booleanShape,
	integerShape,
	jsonShape,
	numberShape,
	objectShape,
	recordShape,
	stringShape,
} from '@orkestrel/contract'
import { inferColumnType } from './inferers.js'

// Shapers are `ContractShape` VALUES (or functions producing them), not
// guards - the compilers (@orkestrel/contract's `createContract`) turn a
// shape into a guard / parser / schema / generator in lockstep.
// `csvTableShape` describes the JSON-serializable projection of a CSVTable
// (types.ts); `columnTypeShape` maps each portable ColumnType to the shape
// its values must satisfy; `deriveShapes` builds a whole `Columns` map from
// a table's own cell values.

/**
 * Returns the {@link ContractShape} a {@link ColumnType}'s values must
 * satisfy.
 *
 * @remarks
 * `'text'` and `'blob'` both shape as plain strings - a CSV field is always
 * text on the wire, so a blob column carries its base64/text encoding as a
 * string rather than a binary shape. `'integer'` uses an integer-constrained
 * number shape (rejects fractional values); `'real'` a plain number shape.
 * `'json'` accepts any JSON value via {@link jsonShape}.
 *
 * @param type - The column's declared {@link ColumnType}
 * @returns The value shape for that column type
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { columnTypeShape } from '@src/core'
 *
 * const integer = createContract(columnTypeShape('integer'))
 * integer.is(5)   // true
 * integer.is(5.5) // false
 * ```
 */
export function columnTypeShape(type: ColumnType): ContractShape {
	switch (type) {
		case 'text':
			return stringShape()
		case 'integer':
			return integerShape()
		case 'real':
			return numberShape()
		case 'boolean':
			return booleanShape()
		case 'json':
			return jsonShape()
		case 'blob':
			return stringShape()
	}
}

/**
 * Represents the {@link ContractShape} of a {@link CSVTable}'s
 * JSON-serializable projection - an ordered `columns` list of strings plus
 * `rows`, each an open record of JSON values.
 *
 * @remarks
 * This shape is narrower than the declared {@link CSVTable} type, whose
 * {@link Row} values are `unknown` and so admit a function, a symbol, or
 * `undefined`. The shape rejects those, and it therefore disagrees with
 * {@link isCSVTable} on such a table. That divergence is deliberate: use
 * {@link isCSVTable} to check the declared type, and this shape to check that
 * a table survives JSON serialization.
 *
 * @example
 * ```ts
 * import { createContract } from '@orkestrel/contract'
 * import { csvTableShape } from '@src/core'
 *
 * const table = createContract(csvTableShape)
 * table.is({ columns: ['a'], rows: [{ a: 1 }] }) // true
 * table.is({ columns: 'a', rows: [] })            // false
 * ```
 */
export const csvTableShape = objectShape({
	columns: arrayShape(stringShape()),
	rows: arrayShape(recordShape(jsonShape())),
})

/**
 * Derives one {@link ContractShape} per table column from that column's cell
 * values across all rows (excluding `undefined`/empty-string cells) - the
 * schema-inference leaf behind {@link CSVInterface.export} when no explicit
 * {@link Columns} is given.
 *
 * @param table - The table to inspect
 * @returns A {@link Columns} map, one shape per column: `'text'` when a
 * column has no non-empty cells; the string-inferred type (via
 * {@link inferColumnType}) when every cell is a string; `'integer'` /
 * `'real'` when every cell is a number (by `Number.isSafeInteger`);
 * `'boolean'` when every cell is a boolean; `'json'` otherwise
 *
 * @example
 * ```ts
 * deriveShapes({ columns: ['a'], rows: [{ a: 1 }, { a: 2 }] })
 * // { a: columnTypeShape('integer') }
 * ```
 */
export function deriveShapes(table: CSVTable): Columns {
	const columns: Record<string, ReturnType<typeof columnTypeShape>> = {}
	for (const column of table.columns) {
		const values = table.rows
			.map((row) => row[column])
			.filter((value) => value !== undefined && value !== '')
		if (values.length === 0) {
			columns[column] = columnTypeShape('text')
		} else if (values.every((value): value is string => typeof value === 'string')) {
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
