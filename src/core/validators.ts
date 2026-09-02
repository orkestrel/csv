import type { Guard } from '@orkestrel/contract'
import type { ColumnType, CSVTable } from './types.js'
import { arrayOf, isRecord, isString, literalOf, recordOf } from '@orkestrel/contract'

// AGENTS section 14: guards are total - never throw, return `false` for any
// off-shape input. `isCSVTable` validates arbitrary `unknown` input (a
// deserialized table, a value crossing a process boundary) against the
// CSVTable structure (types.ts), delegating its row check to
// `@orkestrel/contract`'s `isRecord` directly; `isColumnType` narrows a
// portable ColumnType literal.

/**
 * Determines whether an arbitrary value is a valid {@link CSVTable} - an
 * array of column names plus an array of {@link Row}s.
 *
 * @remarks
 * Total: never throws, even on cyclic or pathologically deep input - every
 * combinator involved (`recordOf`, `arrayOf`) is throw-contained per the
 * `@orkestrel/contract` guard contract (AGENTS section 14). Each row is
 * validated via `@orkestrel/contract`'s `isRecord`, which accepts BOTH an
 * object literal and a null-prototype object (`Object.create(null)`) - the
 * shape the CSV parser deliberately produces for parsed rows - while
 * rejecting arrays, functions, and non-object values.
 *
 * @param value - The value to test
 * @returns True if `value` is a well-formed {@link CSVTable}; false otherwise
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
	rows: arrayOf(isRecord),
})

/**
 * Determines whether a value is a valid {@link ColumnType} literal.
 *
 * @param value - The value to test
 * @returns True if `value` is one of the six {@link ColumnType} literals; false otherwise
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
