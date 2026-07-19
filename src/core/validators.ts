import type { Guard } from '@orkestrel/contract'
import type { ColumnType, CSVTable, Row } from './types.js'
import { arrayOf, isRecord, isString, literalOf, recordOf } from '@orkestrel/contract'

// AGENTS section 14: guards are total - never throw, return `false` for any
// off-shape input. `isRow` and `isCSVTable` validate arbitrary `unknown` input
// (a deserialized table, a value crossing a process boundary) against the
// CSVTable structure (types.ts); `isColumnType` narrows a portable ColumnType
// literal.

/**
 * Determine whether an arbitrary value is a valid {@link Row} - a plain
 * record of column values keyed by column name.
 *
 * @remarks
 * Delegates to `@orkestrel/contract`'s `isRecord`, which accepts BOTH an
 * object literal and a null-prototype object (`Object.create(null)`) - the
 * shape the CSV parser deliberately produces for parsed rows - while
 * rejecting arrays, functions, and non-object values. Total: never throws,
 * even against a hostile `getPrototypeOf` trap (contained inside
 * `@orkestrel/contract`'s own `attempt` wrapper).
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link Row}
 *
 * @example
 * ```ts
 * import { isRow } from '@orkestrel/csv'
 *
 * isRow({ name: 'Ada' })          // true
 * isRow(Object.create(null))      // true
 * isRow(null)                     // false
 * isRow([])                       // false
 * ```
 */
export function isRow(value: unknown): value is Row {
	return isRecord(value)
}

/**
 * Determine whether an arbitrary value is a valid {@link CSVTable} - an
 * array of column names plus an array of {@link Row}s.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`recordOf`, `arrayOf`) is throw-contained per the
 * `@orkestrel/contract` guard contract (AGENTS section 14). A row that is a
 * null-prototype object (via {@link isRow}) still passes.
 *
 * @param value - The value to test
 * @returns `true` when `value` is a well-formed {@link CSVTable}
 *
 * @example
 * ```ts
 * import { isCSVTable } from '@orkestrel/csv'
 *
 * isCSVTable({ columns: ['a'], rows: [{ a: 1 }] }) // true
 * isCSVTable({ columns: 'a', rows: [] })            // false
 * ```
 */
export const isCSVTable: Guard<CSVTable> = recordOf({
	columns: arrayOf(isString),
	rows: arrayOf(isRow),
})

/**
 * Determine whether a value is a valid {@link ColumnType} literal.
 *
 * @param value - The value to test
 * @returns `true` when `value` is one of the six {@link ColumnType} literals
 *
 * @example
 * ```ts
 * import { isColumnType } from '@orkestrel/csv'
 *
 * isColumnType('integer') // true
 * isColumnType('float')   // false
 * ```
 */
export const isColumnType: Guard<ColumnType> = literalOf(
	'text',
	'integer',
	'real',
	'boolean',
	'json',
	'blob',
)
