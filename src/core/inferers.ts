import type { ColumnType, Row } from './types.js'
import { BOOLEAN_FALSE, BOOLEAN_TRUE, INTEGER_PATTERN, REAL_PATTERN } from './constants.js'
import { parseBoolean, parseInteger, parseReal } from './parsers.js'

// The value inferers: everything that reads raw cell text and decides what
// type it carries. `inferColumnType` rules one column, `coerceInferred`
// applies that ruling to one cell, and `inferRows` composes both over a whole
// built row set.
//
// Dependency direction: this file consumes the flat cell coercers
// `parsers.ts` owns, and `parseCSV` consumes `inferRows` from here, so the two
// files import each other. Both edges resolve at call time inside a function
// body, never at module initialization.

/**
 * Infers a whole column's {@link ColumnType} conservatively from its raw
 * string values - never `'json'` or `'blob'` (those require an explicit
 * {@link Columns} declaration). Empty-string cells are ignored entirely (they
 * neither confirm nor demote a type); a column with no non-empty cells is
 * `'text'`.
 *
 * @param values - The column's raw cell values, in row order
 * @returns `'boolean'` when every non-empty cell is exactly `'true'` /
 * `'false'`; `'integer'` when every non-empty cell is a canonical integer
 * within `Number.isSafeInteger` range; `'real'` when every non-empty cell is
 * a canonical integer or decimal (with the same safe-magnitude rule applied
 * to its integer-pattern cells); `'text'` otherwise
 *
 * @example
 * ```ts
 * inferColumnType(['1', '2', '3'])     // 'integer'
 * inferColumnType(['1', '2.5'])        // 'real'
 * inferColumnType(['true', 'false'])   // 'boolean'
 * inferColumnType(['007', '1'])        // 'text'
 * ```
 */
export function inferColumnType(values: readonly string[]): ColumnType {
	const cells = values.filter((value) => value !== '')
	if (cells.length === 0) return 'text'

	if (cells.every((value) => value === BOOLEAN_TRUE || value === BOOLEAN_FALSE)) return 'boolean'

	let hasDecimal = false
	for (const value of cells) {
		if (INTEGER_PATTERN.test(value)) {
			if (!Number.isSafeInteger(Number(value))) return 'text'
			continue
		}
		if (REAL_PATTERN.test(value)) {
			hasDecimal = true
			continue
		}
		return 'text'
	}
	return hasDecimal ? 'real' : 'integer'
}

/**
 * Coerces one string cell to `type`'s typed representation - the exhaustive
 * per-cell dispatch {@link inferRows} applies once a column's type is known.
 *
 * @param value - The raw cell text
 * @param type - The column's inferred {@link ColumnType} (never `'json'` /
 * `'blob'` - those are never inferred, and pass through unchanged like
 * `'text'`)
 * @returns The typed value, via {@link parseInteger} / {@link parseReal} /
 * {@link parseBoolean}; `value` unchanged for `'text'` (or the unreachable
 * `'json'` / `'blob'`)
 */
export function coerceInferred(value: string, type: ColumnType): unknown {
	switch (type) {
		case 'integer':
			return parseInteger(value)
		case 'real':
			return parseReal(value)
		case 'boolean':
			return parseBoolean(value)
		case 'text':
		case 'json':
		case 'blob':
			return value
	}
}

/**
 * Applies whole-column type inference to a built row set - per column, infers
 * its {@link ColumnType} from its string cells, then coerces every cell of
 * that type via {@link coerceInferred}.
 *
 * @remarks
 * An empty-string cell becomes `undefined` for any non-`'text'` column
 * (there is nothing to coerce). Copy-on-write - `rows` is never mutated;
 * a fresh row set is returned.
 *
 * @param rows - The built rows (from {@link buildRow})
 * @param columns - The resolved column order
 * @returns A new row set with every column's cells coerced to its inferred type
 *
 * @example
 * ```ts
 * inferRows([{ a: '1' }, { a: '2' }], ['a']) // [{ a: 1 }, { a: 2 }]
 * ```
 */
export function inferRows(rows: readonly Row[], columns: readonly string[]): readonly Row[] {
	const types = columns.map((column) => {
		const values: string[] = []
		for (const row of rows) {
			const value = row[column]
			if (typeof value === 'string') values.push(value)
		}
		return inferColumnType(values)
	})

	return rows.map((row) => {
		const next: Row = Object.create(null)
		for (const key of Object.keys(row)) next[key] = row[key]
		columns.forEach((column, position) => {
			const value = row[column]
			const type = types[position]
			if (typeof value !== 'string' || type === undefined) return
			next[column] = value === '' && type !== 'text' ? undefined : coerceInferred(value, type)
		})
		return next
	})
}
