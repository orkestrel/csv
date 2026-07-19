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
import type { ContractShape } from '@orkestrel/contract'
import type { ColumnType } from './types.js'

// AGENTS section 14 / 4.6.1: shapers are `ContractShape` VALUES (or functions
// producing them), not guards - the compilers (@orkestrel/contract's
// `createContract`) turn a shape into a guard / parser / schema / generator in
// lockstep. `csvTableShape` describes the structural CSVTable (types.ts);
// `columnTypeShape` maps each portable ColumnType to the shape its values must
// satisfy.

/**
 * The {@link ContractShape} a {@link ColumnType}'s values must satisfy.
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
 * The {@link ContractShape} of a {@link CSVTable} - an ordered `columns` list
 * of strings plus `rows`, each an open record of JSON-shaped values.
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
