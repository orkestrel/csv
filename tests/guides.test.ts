// The consumer-side guides-parity drop-in: runs `@orkestrel/guide`'s checks against
// this repo's own `guides/README.md` manifest. The constants that follow and the
// `flagship fences` block are this package's own; a sibling package rewrites each of them.

import { describe, expect, it } from 'vitest'
import {
	computeSymbolKey,
	createGuide,
	createSource,
	createSourceManager,
	extractFenceImports,
	findMissing,
	findMissingSymbols,
	findUnexampled,
	findUnlisted,
	isExternalLink,
	parseManifest,
	resolveLink,
} from '@orkestrel/guide'
import {
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
} from '@src/core'
import { readFileSync } from 'node:fs'
import { captureError, requireValue } from '@orkestrel/test'
import { readInventory } from '@orkestrel/test/server'

/** Every fence language this package's guides are allowed to use. */
const FENCE_LANGUAGES = Object.freeze(['ts'])
/** The fence language whose blocks count as worked examples. */
const EXAMPLE_LANGUAGE = 'ts'
/** Each import specifier this package's own guides may resolve against. */
const MODULES = Object.freeze({ '@orkestrel/csv': 'src/core', '@src/core': 'src/core' })
/**
 * Declarations deliberately kept out of the barrel, as `computeSymbolKey` strings.
 *
 * A class that one-class-per-file evicted from its single consumer cannot become a
 * local, so it stays exported without being public. Naming it here is what makes that
 * intentional rather than forgotten — and the second assertion below fails when a name
 * here stops being stranded, so the list cannot rot.
 */
const INTERNAL: readonly string[] = Object.freeze([])

/** Root-level files the flagship-fence cases read. `readInventory` walks directories only. */
const ROOT_FILES = Object.freeze(['README.md'])
/** The guide whose flagship fences the executed cases below transcribe. */
const CORE_GUIDE = 'guides/csv.md'
/** The package README whose usage fences the executed cases below transcribe. */
const PACKAGE_README = 'README.md'

const root = new URL('../', import.meta.url)
const files: Record<string, string> = {
	...readInventory(root, ['src', 'guides', 'tests'], { extensions: ['.ts', '.md'] }),
}
for (const name of ROOT_FILES) files[name] = readFileSync(new URL(name, root), 'utf8')
const manifest = parseManifest(
	requireValue(files['guides/README.md'], 'Missing file: guides/README.md'),
	'guides',
)
const sources = createSourceManager({ files, modules: MODULES })

it('manifest lists at least one guide', () => {
	expect(manifest.length).toBeGreaterThan(0)
})

for (const entry of manifest) {
	const guide = createGuide(requireValue(files[entry.spec], `Missing file: ${entry.spec}`))
	const source = createSource({ files, module: entry.source })

	describe(`${entry.concept}`, () => {
		it('uses only listed fence languages', () => {
			expect(findUnlisted(guide.fences(), FENCE_LANGUAGES)).toEqual([])
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

		for (const group of guide.methods()) {
			const members = source.methods(group.interface)
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface}`, () => {
				it('documents at least one method', () => {
					expect(group.methods.length).toBeGreaterThan(0)
				})
				it('documents every interface method', () => {
					expect(findMissing(members, group.methods)).toEqual([])
				})
				it('documents no phantom method', () => {
					expect(findMissing(group.methods, members)).toEqual([])
				})
				it(`${entity} exposes no undocumented method`, () => {
					const extra =
						entity === group.interface ? [] : findMissing(source.methods(entity), group.methods)
					expect(extra).toEqual([])
				})
			})
		}

		it('documents an example for every Surface function', () => {
			const fences = guide
				.fences()
				.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
				.map((fence) => fence.code)
			const names = guide
				.surface()
				.filter((symbol) => symbol.kind === 'function')
				.map((symbol) => symbol.name)
			expect(findUnexampled(names, fences, source.examples())).toEqual([])
		})

		for (const group of guide.methods()) {
			const entity = group.interface.replace(/Interface$/, '')
			describe(`${group.interface} examples`, () => {
				it('documents an example for every method', () => {
					const fences = guide
						.fences()
						.filter((fence) => fence.language === EXAMPLE_LANGUAGE)
						.map((fence) => fence.code)
					const examples =
						entity === group.interface
							? source.examples(group.interface)
							: source.examples(group.interface).concat(source.examples(entity))
					expect(findUnexampled(group.methods, fences, examples)).toEqual([])
				})
			})
		}

		it('imports only real exports in every ```ts fence', () => {
			const fences = guide.fences().filter((fence) => fence.language === EXAMPLE_LANGUAGE)
			for (const fence of fences) {
				for (const { specifier, names } of extractFenceImports(fence.code)) {
					const imported = sources.source(specifier)
					if (imported === undefined) continue
					const surface = imported.surface().map((symbol) => symbol.name)
					expect(findMissing(names, surface)).toEqual([])
				}
			}
		})

		it('resolves every relative link', () => {
			const broken = guide
				.links()
				.filter((href) => !isExternalLink(href))
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(broken).toEqual([])
		})
		it('links only to test files that exist', () => {
			const missing = guide
				.tests()
				.map((href) => resolveLink(entry.spec, href))
				.filter((path) => !source.exists(path))
			expect(missing).toEqual([])
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
	const guideText = requireValue(files[CORE_GUIDE], `Missing file: ${CORE_GUIDE}`)
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
