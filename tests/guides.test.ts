// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow are this
// package's own, as is the executed section that closes the file.

import { GuideCommand } from '@orkestrel/guide/server'
import { readInventory } from '@orkestrel/test/server'
import { createVitest } from 'vitest/node'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** The package identity that binds its manifest, module map, and README pitch. */
const PACKAGE_NAME = '@orkestrel/csv'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ [PACKAGE_NAME]: 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the assertion that follows it fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** The one guide this package sources, whose tagline the README pitch equals. */
const GUIDE_SPEC = 'guides/csv.md'
/** The package README whose usage fences the executed cases below transcribe. */
const PACKAGE_README = 'README.md'

await new GuideCommand({
	root: new URL('../', import.meta.url),
	patterns: ['src/**/*.ts', 'tests/**/*.ts', 'guides/*.md', '*.md', 'package.json'],
	modules: MODULES,
	languages: FENCE_LANGUAGES,
	language: EXAMPLE_LANGUAGE,
	reader: readInventory,
	runner: createVitest,
}).execute(async ({ files, report, rows }) => {
	const { isRecord, parseJSON } = await import('@orkestrel/contract')
	const { computeSymbolKey, findMissingSymbols } = await import('@orkestrel/guide')
	const { captureError, requireValue } = await import('@orkestrel/test')
	const {
		coerceInferred,
		columnTypeShape,
		createCSV,
		createTableContract,
		isBreakChar,
		isCSVError,
		isRowList,
		parseCSV,
		renderCSV,
		resolveParseOptions,
		scanField,
	} = await import('@src/core')
	const { describe, expect, it } = await import('vitest')
	const manifest = parseJSON(requireValue(files['package.json'], 'Missing inventory: package.json'))
	if (!isRecord(manifest)) throw new Error('Invalid package manifest: package.json')

	it('manifest lists at least one guide', () => {
		expect(report.input).toEqual([])
		expect(rows.length).toBeGreaterThan(0)
		expect(rows.map((row) => row.entry.spec)).toContain(GUIDE_SPEC)
	})

	// The example half of the equality case is silent over an empty population: with no
	// title on both sides `findDrift` compares no pair and the case passes on the summaries
	// alone. This pins the population this repository's own guide contributes, so removing
	// every `@example` title reddens the suite instead of quietly retiring half the gate.
	// The failure names both title sets, because a pin reporting only its own emptiness
	// leaves the reader to work out which side dropped the title.
	it('pairs at least one example title across the guide and the source', () => {
		expect(report.examples.titles.filter((finding) => finding.spec === GUIDE_SPEC)).toEqual([])
	})

	// The README's pitch and the guide's tagline are one text, each read as the blockquote
	// under its file's H1. `README.md` is outside the concept index, so the reader is
	// applied to it directly rather than through a manifest row. Each side is guarded
	// against `undefined` first, so a file that lost its blockquote reports that rather
	// than reporting two absences as agreement.
	it('opens the README with the guide tagline', () => {
		expect(manifest.name).toBe(PACKAGE_NAME)
		expect(report.pitch).toEqual([])
	})

	for (const { entry, guide, source } of rows) {
		describe(`${entry.concept}`, () => {
			it('uses only listed fence languages', () => {
				expect(report.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('extracts a non-empty documented surface', () => {
				expect(guide.surface().length).toBeGreaterThan(0)
			})
			it('re-exports every direct declaration that is not named internal', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(stranded.filter((key) => !INTERNAL.includes(key))).toEqual([])
			})
			it('names no symbol internal that the barrel already exports', () => {
				const stranded = findMissingSymbols(source.exports(), source.surface())
				expect(INTERNAL.filter((key) => !stranded.includes(key))).toEqual([])
			})
			it('re-exports only direct declarations', () => {
				expect(findMissingSymbols(source.surface(), source.exports())).toEqual([])
			})
			it('documents every barrel export', () => {
				expect(findMissingSymbols(source.surface(), guide.surface())).toEqual([])
			})
			it('documents only barrel exports', () => {
				expect(findMissingSymbols(guide.surface(), source.surface())).toEqual([])
			})

			it('exposes no hidden module-scope declarations', () => {
				expect(source.hidden().map(computeSymbolKey)).toEqual([])
			})

			it('carries every required populated section', () => {
				expect(report.sections.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps behavioral interfaces and implementing classes in parity', () => {
				expect(report.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents every behavioral declaration', () => {
				expect(report.declarations.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			// The equality gate: a `Summary` cell against its export's description paragraph, a
			// titled fence against the `@example` of that title. `findDrift` owns the comparison
			// and names both sides; converge the two sides through the native entry, never by
			// weakening this assertion. `findDrift` pairs an example only where a title is
			// present on both sides, so an untitled `@example` block is outside this case. Each
			// collected line is the spec, the key, and each side's text or `absent` — the same
			// worklist the native entry prints, so a failure here is read the way that command's
			// output is. Select source authority with `--to guide`, or guide authority with
			// `--to source`.
			it('keeps every compared summary and example equal to its source', () => {
				expect(report.drift.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('keeps the executable example population non-empty', () => {
				expect(report.examples.fences.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('documents an example for every Surface function', () => {
				expect(report.examples.functions.filter((finding) => finding.spec === entry.spec)).toEqual(
					[],
				)
			})

			it('documents an example for every method', () => {
				expect(report.examples.methods.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('imports only real exports in every ```ts fence', () => {
				expect(report.imports.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})

			it('resolves every relative link', () => {
				expect(report.links.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
			it('links only to test files that exist', () => {
				expect(report.tests.filter((finding) => finding.spec === entry.spec)).toEqual([])
			})
		})
	}

	// The EXECUTED half. Every preceding check reads a name, and a name that
	// resolves proves nothing about the sentence beside it, so a fence whose
	// comment claims a value the code contradicts passes all of them. The cases
	// here run the flagship fences and assert the values their comments claim,
	// each beside a presence guard binding the documented line. Change a fence,
	// change the transcription beside it.
	describe('flagship fences', () => {
		const guideText = requireValue(files[GUIDE_SPEC], `Missing file: ${GUIDE_SPEC}`)
		const readmeText = requireValue(files[PACKAGE_README], `Missing file: ${PACKAGE_README}`)

		it('parses the Surface fence into inferred rows', () => {
			const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })

			expect(csv.rows).toEqual([
				{ name: 'Ada', age: 36 },
				{ name: 'Grace', age: 85 },
			])
			expect(guideText).toContain(
				"csv.rows // [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }]",
			)
		})

		it('reads the parse-and-query fence table', () => {
			const csv = createCSV('name,age\nAda,36\nGrace,85', { infer: true })

			expect(csv.table).toEqual({
				columns: ['name', 'age'],
				rows: [
					{ name: 'Ada', age: 36 },
					{ name: 'Grace', age: 85 },
				],
			})
			expect(guideText).toContain(
				"csv.table // { columns: ['name', 'age'], rows: [{ name: 'Ada', age: 36 }, { name: 'Grace', age: 85 }] }",
			)
		})

		it('renders the rewritten table the map fence produces', () => {
			const csv = createCSV('name,age\nAda,36', { infer: true })
			const older = csv.map((row) => ({ ...row, age: Number(row.age) + 1 }))

			expect(renderCSV(older.toJSON())).toBe('name,age\r\nAda,37')
			expect(guideText).toContain("renderCSV(older.toJSON()) // 'name,age\\r\\nAda,37'")
		})

		it('folds the reduce fence to its documented total', () => {
			const csv = createCSV('amount\n10\n20\n30', { infer: true })

			expect(csv.reduce<number>((sum, row) => sum + Number(row.amount), 0)).toBe(60)
			expect(guideText).toContain(
				'const total = csv.reduce<number>((sum, row) => sum + Number(row.amount), 0) // 60',
			)
		})

		it('drains the streaming fence to its documented values', async () => {
			const csv = createCSV('a\n1\n2\n3')
			const reader = csv.stream().getReader()
			const values: string[] = []
			for (let result = await reader.read(); !result.done; result = await reader.read()) {
				values.push(String(result.value.a))
			}

			expect(values).toEqual(['1', '2', '3'])
			expect(guideText).toContain("// values: ['1', '2', '3']")
		})

		it('collects rather than throws in the non-strict error fence', () => {
			const csv = createCSV('a,b\n1,2,3')

			expect(csv.errors.length > 0).toBe(true)
			expect(guideText).toContain('csv.errors.length > 0 // true')
		})

		it('throws the documented code in the strict fence', () => {
			const caught = captureError(() => createCSV('a,b\n1,2,3', { strict: true }))

			expect(isCSVError(caught) ? caught.code : undefined).toBe('RAGGED_ROW')
			expect(guideText).toContain("if (isCSVError(error)) error.code // 'RAGGED_ROW'")
		})

		it('keys the export fence at its first column', () => {
			const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })

			expect(csv.export().key).toBe('id')
			expect(guideText).toContain('const table = csv.export()')
			expect(readmeText).toContain("table.key // 'id'")
		})

		it('answers from the contract the row-validation fence compiles', () => {
			const contract = createTableContract({
				id: columnTypeShape('integer'),
				name: columnTypeShape('text'),
			})

			expect(contract.is({ id: 1, name: 'Ada' })).toBe(true)
			expect(contract.is({ id: 'x', name: 'Ada' })).toBe(false)
			expect(guideText).toContain("contract.is({ id: 1, name: 'Ada' }) // true")
			expect(guideText).toContain("contract.is({ id: 'x', name: 'Ada' }) // false")
		})

		it('returns the documented values from the tokenizer-leaf fence', () => {
			const scan = scanField('ab,c', { offset: 0, line: 1, column: 1 }, resolveParseOptions())

			expect(isBreakChar('\n')).toBe(true)
			expect(isBreakChar('a')).toBe(false)
			expect(scan.field).toEqual({ value: 'ab', quoted: false })
			expect(coerceInferred('42', 'integer')).toBe(42)
			expect(isRowList([{ a: 1 }])).toBe(true)
			expect(isRowList({ columns: ['a'], rows: [{ a: 1 }] })).toBe(false)
			expect(guideText).toContain("isBreakChar('\\n') // true")
			expect(guideText).toContain("isBreakChar('a') // false")
			expect(guideText).toContain("scan.field // { value: 'ab', quoted: false }")
			expect(guideText).toContain("coerceInferred('42', 'integer') // 42")
			expect(guideText).toContain('isRowList([{ a: 1 }]) // true')
			expect(guideText).toContain("isRowList({ columns: ['a'], rows: [{ a: 1 }] }) // false")
		})

		it('parses the README usage fence into inferred rows', () => {
			const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })

			expect(csv.rows).toEqual([
				{ id: 1, name: 'Ada' },
				{ id: 2, name: 'Grace' },
			])
			expect(readmeText).toContain("csv.rows // [{ id: 1, name: 'Ada' }, { id: 2, name: 'Grace' }]")
		})

		it('renders the README table to its documented text', () => {
			const csv = createCSV('id,name\n1,Ada\n2,Grace', { infer: true })

			expect(renderCSV(csv.table)).toBe('id,name\r\n1,Ada\r\n2,Grace')
			expect(readmeText).toContain("// 'id,name\\r\\n1,Ada\\r\\n2,Grace'")
		})

		it('positions the README error fence at its documented code and line', () => {
			const { errors } = parseCSV('a,b\n"unterminated,x')

			expect(errors[0]?.code).toBe('UNTERMINATED_QUOTE')
			expect(errors[0]?.line).toBe(2)
			expect(readmeText).toContain("errors[0]?.code // 'UNTERMINATED_QUOTE'")
			expect(readmeText).toContain('errors[0]?.line // 2')
		})
	})
})
