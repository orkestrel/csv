import type { ParseOptions, RenderOptions } from './types.js'

// Centralized, frozen data the parser / renderer draw their defaults and
// canonical-format patterns from (AGENTS §5) - no behavior lives here.

/** The UTF-8 byte-order-mark character, prepended when `RenderOptions.bom` is `true`. */
export const BOM = '﻿'

/**
 * The resolved default {@link ParseOptions} - what `parseCSV` uses for any
 * option left unspecified.
 */
export const DEFAULT_PARSE_OPTIONS: Required<ParseOptions> = {
	delimiter: ',',
	quote: '"',
	escape: 'double',
	header: true,
	comment: false,
	blanks: 'keep',
	trim: false,
	ragged: 'collect',
	infer: false,
	limit: 0,
	strict: false,
}

/**
 * The resolved default {@link RenderOptions} (everything but `columns`, which
 * has no default) - what `renderCSV` uses for any option left unspecified.
 */
export const DEFAULT_RENDER_OPTIONS: Required<Omit<RenderOptions, 'columns'>> = {
	delimiter: ',',
	quote: '"',
	escape: 'double',
	newline: '\r\n',
	header: true,
	quotes: 'minimal',
	blank: '',
	sanitize: true,
	bom: false,
}

/**
 * The leading characters the OWASP CSV-injection guard treats as
 * formula-triggering - a field starting with any of these is prefixed with a
 * protective `'` when `RenderOptions.sanitize` is `true`.
 */
export const SANITIZE_PREFIXES: ReadonlySet<string> = new Set([
	'=',
	'+',
	'-',
	'@',
	'\t',
	'\r',
	'\n',
])

/**
 * The prefix used to name positional columns (`column1`, `column2`, …) when
 * `ParseOptions.header` is `false`, or a header field is empty - 1-based.
 */
export const POSITIONAL_COLUMN_PREFIX = 'column'

/**
 * The protective prefix {@link sanitizeField} prepends to a field starting
 * with a formula-triggering character (the OWASP CSV-injection guidance).
 */
export const SANITIZE_ESCAPE = "'"

/**
 * The separator between a disambiguated column name and its collision
 * counter (`name` -> `name_2`, `name_3`, …) - see {@link uniqueName}.
 */
export const SUFFIX_SEPARATOR = '_'

/**
 * Matches a canonical integer only - an optional leading `-`, no leading
 * zeros (except the bare digit `0`), digits only. No `+` sign, no
 * whitespace.
 */
export const INTEGER_PATTERN = /^-?(0|[1-9]\d*)$/

/**
 * Matches a canonical decimal only - an optional leading `-`, an integer
 * part with no leading zeros (except the bare digit `0`), an optional `.`
 * followed by at least one digit. No scientific notation, no `NaN` /
 * `Infinity`, no decimal comma, no trailing dot.
 */
export const REAL_PATTERN = /^-?(0|[1-9]\d*)(\.\d+)?$/

/**
 * Matches what the renderer treats as a plain number for the `'nonnumeric'`
 * {@link QuoteStyle} and the sanitize `+` / `-` exemption - like
 * {@link REAL_PATTERN} but also allowing a leading `+`.
 */
export const NUMERIC_PATTERN = /^[+-]?(0|[1-9]\d*)(\.\d+)?$/

/** The canonical serialized form of the boolean `true`. */
export const BOOLEAN_TRUE = 'true'

/** The canonical serialized form of the boolean `false`. */
export const BOOLEAN_FALSE = 'false'

/**
 * The maximum number of {@link CSVError}s collected into a parse result -
 * once reached, error collection stops (earlier records already parsed are
 * kept, later malformations are silently no longer recorded).
 */
export const MAX_ERRORS = 100
