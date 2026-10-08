#!/usr/bin/env node
// check-slices.mts — repo gate for the vertical-slice architecture rules.
//
// Enforces the AGENTS.md invariants that npm test cannot see:
//   1. every extension under extensions/ is a complete vertical slice:
//      index.ts with a default-export factory, README.md, and at least one
//      colocated *.test.mts;
//   2. no extension imports a sibling or escapes its slice except through the
//      documented package-level evaluation interfaces in colocated suites/tests;
//   3. no hardcoded counts of tests, tools, or files in tracked docs
//      (AGENTS.md: "Do not hardcode counts ... in durable documentation");
//   4. pillar corpus contract: strict frontmatter on every entry, README as
//      a verbatim-quote inventory, GOVERNANCE.md present with required
//      sections, armory targets resolving, and no retired governance file
//      returning;
//   5. every tracked *.test.mts file is matched by at least one glob in the
//      `test` script of package.json, so a slice that owns a new top-level
//      directory cannot ship tests that `npm test` silently never runs.
//
// Dependency-free by design (node builtins only), mirroring the established
// pattern of skills/harness/scripts/validate-skill.mts.
//
// Exit status: 0 when all rules hold, 1 listing every violation otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionsRoot = join(root, "extensions");
const main =
	process.argv[1] !== undefined &&
	existsSync(process.argv[1]) &&
	realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

// --- rule 1: extension anatomy -----------------------------------------

for (const entry of main ? readdirSync(extensionsRoot, { withFileTypes: true }) : []) {
	if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
	const slice = join(extensionsRoot, entry.name);
	const label = `extensions/${entry.name}`;

	const indexFile = join(slice, "index.ts");
	if (!existsSync(indexFile)) {
		fail(`${label}: missing index.ts (every extension registers via index.ts)`);
	} else {
		const source = readFileSync(indexFile, "utf8");
		if (!/\bexport\s+default\b/.test(source)) {
			fail(`${label}: index.ts has no default export (the Pi factory contract)`);
		}
	}
	if (!existsSync(join(slice, "README.md"))) {
		fail(`${label}: missing README.md (every extension documents its own surface)`);
	}
	const tests = readdirSync(slice).filter((name) => name.endsWith(".test.mts"));
	if (tests.length === 0) {
		fail(`${label}: no colocated *.test.mts file`);
	}
}

// --- rule 2: no sibling imports ----------------------------------------

const sourceFiles: string[] = [];
const walk = (dir: string) => {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name.startsWith(".")) continue;
		const path = join(dir, entry.name);
		if (entry.isDirectory()) walk(path);
		else if (entry.isFile() && /\.(ts|mts)$/.test(entry.name)) sourceFiles.push(path);
	}
};
if (main && existsSync(extensionsRoot)) walk(extensionsRoot);

const specifierPattern = /(?:from|import)\s*(?:\(\s*)?["']([^"']+)["']/g;

for (const file of sourceFiles) {
	const rel = relative(root, file);
	const sliceName = rel.split(/[\\/]/)[1];
	const sliceDir = join(extensionsRoot, sliceName);
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(specifierPattern)) {
		const specifier = match[1];
		// Literal './' and '../' spellings are resolved against the importing
		// file before comparison, so a './' prefix cannot dodge the escape
		// check (e.g. './../sibling/index.ts').
		const isRelative = specifier.startsWith("./") || specifier.startsWith("../");
		const normalized = isRelative ? relative(sliceDir, resolve(dirname(file), specifier)) : specifier;
		const target = isRelative ? resolve(dirname(file), specifier) : undefined;
		const evaluationContract =
			dirname(file) === sliceDir &&
			((file.endsWith(".eval.mts") && target === join(root, "evals", "vitest-evals.mts")) ||
				(file.endsWith(".test.mts") && target === join(root, "evals", "subjects", "pi-sdk.mts")));
		if (isRelative && normalized.startsWith("..") && !evaluationContract) {
			fail(`${rel}: import "${specifier}" escapes the extension slice`);
		} else if (specifier.startsWith("/")) {
			fail(`${rel}: absolute import "${specifier}"`);
		} else if (/^extensions\//.test(normalized)) {
			fail(`${rel}: import "${specifier}" reaches into extensions/ by path`);
		} else {
			const cross = normalized.match(/\/extensions\/([^/]+)\//);
			if (cross && cross[1] !== sliceName) {
				fail(`${rel}: import "${specifier}" reaches into extension "${cross[1]}"`);
			}
		}
	}
}

// --- configuration declaration and documentation contract -------------

function configurationSource(repositoryRoot: string, file: string): boolean {
	const path = relative(join(repositoryRoot, "extensions"), file).replaceAll("\\", "/");
	return (
		!/\.(test|eval)\.mts$/.test(path) &&
		!/(?:^|\/)(?:fixtures|test-fixtures)\//.test(path) &&
		!/(?:^|\/)[^/]*-fixture\.(ts|mts)$/.test(path)
	);
}
const contextVariables = new Set([
	"PI_AGENT_DIR",
	"PI_AGENT_SESSIONS_DIR",
	"PI_MANAGED_INSTALL_ROOT",
	"PI_SESSION_ID",
	"PI_HARNESS_FILE",
]);
const configurationVariable = (name: string) => !contextVariables.has(name) && !/^PI_.*_TEST_/.test(name);
// Lexical detection covers direct and injected env access, not arbitrary aliases.
export function environmentReads(source: string): string[] {
	const pattern = /(?:\benv|\bprocess\s*\.\s*env|\))\s*(?:\.\s*(PI_[A-Z0-9_]+)|\[\s*["'](PI_[A-Z0-9_]+)["']\s*\])/g;
	return [...new Set([...source.matchAll(pattern)].map((match) => match[1] ?? match[2]).filter(configurationVariable))];
}

export type Field = {
	type: "string" | "path" | "integer" | "number" | "boolean" | "enum" | "json";
	env: string;
	description: string;
	default?: unknown;
	defaultText?: string;
	secret?: boolean;
	absolute?: boolean;
	min?: number;
	max?: number;
	minLength?: number;
	maxLength?: number;
	choices?: readonly string[];
};
export type Declaration = { slice: string; fields: Record<string, Field> };
const fieldKeys = new Set([
	"type",
	"env",
	"description",
	"default",
	"defaultText",
	"secret",
	"absolute",
	"min",
	"max",
	"minLength",
	"maxLength",
	"choices",
]);
const settingTypes = new Set(["string", "path", "integer", "number", "boolean", "enum", "json"]);
const validText = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max && !/[\p{Cc}\p{Cf}\ud800-\udfff]/u.test(value);
const plainObject = (value: unknown): value is Record<string, unknown> =>
	value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

function assertPlainData(value: unknown, seen = new Set<object>(), depth = 0): void {
	if (depth > 32) throw new Error("Declaration is too deep");
	if (value === null || typeof value === "string" || typeof value === "boolean") return;
	if (typeof value === "number" && Number.isFinite(value)) return;
	if ((!plainObject(value) && !Array.isArray(value)) || seen.has(value))
		throw new Error("Declaration must be plain data");
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") throw new Error("Declaration contains a symbol");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !("value" in descriptor)) throw new Error("Declaration contains an accessor");
		assertPlainData(descriptor.value, seen, depth + 1);
	}
	seen.delete(value);
}

function validateFieldBounds(field: Field): void {
	const numeric = field.type === "integer" || field.type === "number";
	for (const key of ["min", "max"] as const) {
		const bound = field[key];
		if (bound !== undefined && (!numeric || !Number.isFinite(bound))) throw new Error("Invalid numeric bound");
	}
	validateTextBounds(field);
	if ((field.min ?? -Infinity) > (field.max ?? Infinity)) throw new Error("Inverted bounds");
}
function validateTextBounds(field: Field): void {
	const text = field.type === "string" || field.type === "path";
	for (const key of ["minLength", "maxLength"] as const) {
		const bound = field[key];
		if (bound !== undefined && (!text || !Number.isSafeInteger(bound) || bound < 0))
			throw new Error("Invalid text bound");
	}
	if ((field.minLength ?? 0) > (field.maxLength ?? Infinity)) throw new Error("Inverted bounds");
}
function validateFieldOptions(field: Field): void {
	if (Object.hasOwn(field, "default") && Object.hasOwn(field, "defaultText")) throw new Error("Conflicting defaults");
	if (field.defaultText !== undefined && !validText(field.defaultText, 2048)) throw new Error("Invalid default text");
	for (const key of ["secret", "absolute"] as const)
		if (field[key] !== undefined && typeof field[key] !== "boolean") throw new Error("Invalid field flag");
	if (
		field.secret &&
		(field.type !== "string" || Object.hasOwn(field, "default") || Object.hasOwn(field, "defaultText"))
	)
		throw new Error("Secrets are strings without defaults");
	if (field.absolute !== undefined && field.type !== "path") throw new Error("Absolute applies to paths");
}
function validateField(field: Field): void {
	if (
		!plainObject(field) ||
		Object.keys(field).some((key) => !fieldKeys.has(key)) ||
		!settingTypes.has(field.type) ||
		!validText(field.description, 2048)
	)
		throw new Error("Invalid field declaration");
	validateFieldBounds(field);
	validateFieldOptions(field);
	if (field.type === "enum") {
		if (
			!Array.isArray(field.choices) ||
			!field.choices.length ||
			field.choices.some((choice) => !validText(choice, 4096)) ||
			new Set(field.choices).size !== field.choices.length
		)
			throw new Error("Invalid enum choices");
	} else if (field.choices !== undefined) throw new Error("Choices apply to enums");
}

function snakeName(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.toUpperCase();
}

export function validateSettingsDeclaration(value: unknown, slice: string): asserts value is Declaration {
	assertPlainData(value);
	if (
		!plainObject(value) ||
		Object.keys(value).some((key) => key !== "slice" && key !== "fields") ||
		value.slice !== slice ||
		!/^[a-z][a-zA-Z0-9]{0,63}$/.test(slice) ||
		slice === "version" ||
		!plainObject(value.fields)
	)
		throw new Error("Declaration export mismatch");
	if (Object.keys(value.fields).length > 128) throw new Error("Too many fields");
	const names = new Set<string>();
	for (const [key, candidate] of Object.entries(value.fields)) {
		if (!/^[a-z][a-zA-Z0-9]{0,63}$/.test(key)) throw new Error("Invalid field key");
		const field = candidate as Field;
		validateField(field);
		if (
			typeof field.env !== "string" ||
			!/^PI_[A-Z][A-Z0-9_]*$/.test(field.env) ||
			field.env.length > 128 ||
			names.has(field.env) ||
			field.env !== `PI_${snakeName(slice)}_${snakeName(key)}`
		)
			throw new Error("Invalid or duplicate explicit environment name");
		names.add(field.env);
	}
}

const README_START = "<!-- harness:settings:start -->";
const README_END = "<!-- harness:settings:end -->";
function tableCell(value: string): string {
	return value
		.replace(/\|/g, "\\|")
		.replace(/[\r\n]/g, " ")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
export function settingsReadme(declaration: Declaration): string {
	const rows = Object.entries(declaration.fields).map(([key, field]) => {
		const fallback = field.secret
			? "env-only"
			: (field.defaultText ?? (Object.hasOwn(field, "default") ? JSON.stringify(field.default) : "unset"));
		const constraints = (["min", "max", "minLength", "maxLength"] as const)
			.filter((name) => field[name] !== undefined)
			.map((name) => `${name} ${field[name]}`);
		if (field.absolute) constraints.push("absolute input");
		if (field.choices) constraints.push(field.choices.join(", "));
		return `| ${[key, `\`${field.env}\``, field.type, tableCell(fallback), tableCell(constraints.join("; ") || "none"), tableCell(field.description)].join(" | ")} |`;
	});
	return [
		README_START,
		"| Key | Environment | Type | Default | Constraints | Description |",
		"|---|---|---|---|---|---|",
		...rows,
		README_END,
	].join("\n");
}
export function checkSettingsReadme(declaration: Declaration, readme: string): boolean {
	const start = readme.indexOf(README_START);
	const end = readme.indexOf(README_END, start);
	return (
		start >= 0 &&
		end >= start &&
		readme.indexOf(README_START, start + README_START.length) < 0 &&
		readme.indexOf(README_END, end + README_END.length) < 0 &&
		readme.slice(start, end + README_END.length) === settingsReadme(declaration)
	);
}

function hasSettingsReader(runtime: string[]): boolean {
	return runtime.some((file) => /\breadSettings\s*\(/.test(readFileSync(file, "utf8")));
}
async function loadSettingsDeclaration(
	repositoryRoot: string,
	declarationPath: string,
	slice: string,
): Promise<Declaration> {
	const source = readFileSync(declarationPath, "utf8");
	const importsEntrypoint = [...source.matchAll(specifierPattern)].some((match) => {
		const target = resolve(dirname(declarationPath), match[1]);
		return target.startsWith(`${join(repositoryRoot, "extensions")}/`) && target.endsWith("/index.ts");
	});
	if (importsEntrypoint) throw new Error("Settings module imports an entrypoint");
	// Module import-time passivity is enforced by source review.
	const module = await import(pathToFileURL(declarationPath).href);
	validateSettingsDeclaration(module.settings, slice);
	if (typeof module.readSettings !== "function" || typeof module.publishSettings !== "function")
		throw new Error("Missing local settings functions");
	return module.settings;
}

export async function auditSettings(repositoryRoot: string, files: string[]): Promise<string[]> {
	const violations: string[] = [];
	const sliceNames = [
		...new Set(files.map((file) => relative(join(repositoryRoot, "extensions"), file).split(/[\\/]/)[0])),
	];
	for (const slice of sliceNames) {
		const directory = join(repositoryRoot, "extensions", slice);
		const runtime = files.filter(
			(file) => file.startsWith(`${directory}/`) && configurationSource(repositoryRoot, file),
		);
		const reads = runtime.flatMap((file) =>
			environmentReads(readFileSync(file, "utf8")).map((name) => ({ file, name })),
		);
		const declarationPath = join(directory, "settings.ts");
		if (!existsSync(declarationPath)) {
			violations.push(
				...reads.map(
					({ file, name }) => `${relative(repositoryRoot, file)}: ${name} requires an owning settings.ts declaration`,
				),
			);
			if (!reads.length && hasSettingsReader(runtime))
				violations.push(`extensions/${slice}: readSettings consumer requires an owning settings.ts declaration`);
			continue;
		}
		const readmePath = join(directory, "README.md");
		const readme = existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "";
		try {
			const declaration = await loadSettingsDeclaration(repositoryRoot, declarationPath, slice);
			if (!checkSettingsReadme(declaration, readme))
				violations.push(
					`extensions/${slice}/README.md: configuration table differs from settings.ts; use settingsReadme(settings)`,
				);
			violations.push(
				...reads
					.filter(({ name }) => !Object.values(declaration.fields).some((field) => field.env === name))
					.map(({ file, name }) => `${relative(repositoryRoot, file)}: ${name} is not declared by settings.ts`),
			);
		} catch {
			violations.push(
				`extensions/${slice}/settings.ts: cannot load valid plain settings declaration and local functions`,
			);
		}
	}
	return violations;
}
if (main) for (const violation of await auditSettings(root, sourceFiles)) fail(violation);

// --- rule 3: no hardcoded counts in tracked docs -----------------------

const tracked = main
	? execFileSync("git", ["ls-files"], {
			cwd: root,
			encoding: "utf8",
		})
	: "";
const countPattern = /\b\d+\s+(test|tests|tool|tools|file|files)\b/g;
for (const doc of tracked.split("\n")) {
	if (!doc.endsWith(".md")) continue;
	const path = join(root, doc);
	// `git ls-files` includes an unstaged deletion. A gate over the working tree
	// must ignore that absent path rather than crash before it reports findings.
	if (!existsSync(path)) continue;
	const text = readFileSync(path, "utf8");
	for (const match of text.matchAll(countPattern)) {
		fail(`${doc}: hardcoded count "${match[0]}"`);
	}
}

// --- rule 4: pillar corpus contract ------------------------------------

export interface PillarEntry {
	type: string;
	filename: string;
	title: string;
	index: string;
}

const PILLAR_SECTIONS: Array<[string, string]> = [
	["principle", "Principles"],
	["pattern", "Patterns"],
	["heuristic", "Heuristics"],
];
const TYPE_BY_HEADING: Record<string, string> = {
	"# Principle:": "principle",
	"# Pattern:": "pattern",
	"# Heuristic:": "heuristic",
};
const REQUIRED_GOVERNANCE_HEADINGS = [
	"Document Types",
	"Application Contract",
	"Consultation Procedure",
	"Supplying doctrine to subagents",
	"Contradiction Handling",
	"Common Composition Paths",
	"Mutation Rules",
	"Provenance Policy",
];

function decodeFatalUtf8(raw: Buffer): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(raw);
}

function frontmatterEnd(lines: string[]): number {
	for (let i = 1; i < lines.length && i <= 20; i += 1) {
		if (/^---\s*$/.test(lines[i])) return i;
		if (/^# /.test(lines[i])) break;
	}
	throw new Error(`frontmatter opened on line 1 but has no closing --- fence`);
}

function parsePillarFrontmatter(text: string): { title: string; index: string } {
	if (!/^---\r?\n/.test(text)) {
		throw new Error(`frontmatter missing; expected opening --- on line 1`);
	}
	const lines = text.split(/\r?\n/);
	const closeIndex = frontmatterEnd(lines);

	const seen = new Map<string, string>();
	for (let i = 1; i < closeIndex; i += 1) {
		const line = lines[i];
		const kv = line.match(/^([A-Za-z]+):\s+("(?:[^"\\]|\\.)*")\s*$/);
		if (!kv) {
			throw new Error(`frontmatter line ${i + 1}: expected double-quoted scalar (allowed keys: title, index)`);
		}
		const key = kv[1];
		if (key !== "title" && key !== "index") {
			throw new Error(`frontmatter line ${i + 1}: unknown key "${key}"; allowed keys are title, index`);
		}
		if (seen.has(key)) {
			throw new Error(`frontmatter line ${i + 1}: duplicate key "${key}"`);
		}
		try {
			seen.set(key, JSON.parse(kv[2]) as string);
		} catch {
			throw new Error(`frontmatter line ${i + 1}: key "${key}" is not a valid quoted string`);
		}
	}
	const title = seen.get("title");
	if (title === undefined) throw new Error(`frontmatter missing required key "title"`);
	const index = seen.get("index");
	if (index === undefined) throw new Error(`frontmatter missing required key "index"`);
	return { title, index };
}

function parseInventory(readme: string): Array<{ href: string; title: string; cell: string }> {
	const inventory: Array<{ href: string; title: string; cell: string }> = [];
	for (const match of readme.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\) \| (.+?) \|$/gm)) {
		inventory.push({ href: match[2].replace(/^pillars\//, ""), title: match[1], cell: match[3] });
	}
	return inventory;
}

function pillarText(path: string, label: string, violations: string[]): string | undefined {
	try {
		return decodeFatalUtf8(readFileSync(path));
	} catch {
		violations.push(`${label}: invalid UTF-8`);
		return undefined;
	}
}

function pillarHeading(text: string, label: string, violations: string[]): { type: string; title: string } | undefined {
	const bodyLines = text.split(/\r?\n/).slice(text.split(/\r?\n/).findIndex((line) => /^---\s*$/.test(line)) + 1);
	for (const line of bodyLines) {
		const h1 = line.match(/^(#[^#].*)$/);
		if (!h1) continue;
		const typed = h1[1].match(/^(# (?:Principle|Pattern|Heuristic):) (.+)$/);
		if (typed) return { type: TYPE_BY_HEADING[typed[1]], title: typed[2] };
		violations.push(`${label}: H1 "${h1[1]}" lacks a typed "# Principle:/Pattern:/Heuristic:" form`);
		break;
	}
	return undefined;
}

function pillarEntry(pillarsDir: string, filename: string, violations: string[]): PillarEntry | undefined {
	const typeMatch = filename.match(/^(principle|pattern|heuristic)-.+\.md$/);
	if (!typeMatch) return undefined;
	const label = `pillars/${filename}`;
	const text = pillarText(join(pillarsDir, filename), label, violations);
	if (text === undefined) return undefined;
	let meta: { title: string; index: string };
	try {
		meta = parsePillarFrontmatter(text);
	} catch (error) {
		violations.push(`${label}: ${(error as Error).message}`);
		return undefined;
	}
	const heading = pillarHeading(text, label, violations);
	if (!heading?.title || !heading.type) {
		violations.push(`${label}: no typed H1 found after frontmatter`);
		return undefined;
	}
	if (typeMatch[1] !== heading.type) {
		violations.push(`${label}: filename prefix "${typeMatch[1]}" disagrees with H1 type "${heading.type}"`);
	}
	if (meta.title !== heading.title) {
		violations.push(`${label}: frontmatter title "${meta.title}" != H1 name "${heading.title}"`);
	}
	return { type: heading.type, filename, title: meta.title, index: meta.index };
}

function auditPillarIdentities(entries: PillarEntry[], violations: string[]): void {
	const identityKeys = new Set<string>();
	for (const entry of entries) {
		const identity = `${entry.type}:${entry.title}`;
		if (identityKeys.has(identity)) violations.push(`duplicate (type,title) identity "${identity}"`);
		identityKeys.add(identity);
	}
}

function auditPillarInventory(
	inventory: ReturnType<typeof parseInventory>,
	filesByKey: ReadonlyMap<string, PillarEntry>,
	violations: string[],
): boolean {
	const inventoryByHref = new Map(inventory.map((row) => [row.href, row] as const));
	for (const [href, row] of inventoryByHref) {
		const entry = filesByKey.get(href);
		if (!entry) {
			violations.push(`pillars/README.md: row links to unknown entry "${href}"`);
			continue;
		}
		if (row.title !== entry.title) {
			violations.push(`pillars/README.md: row label "${row.title}" != frontmatter title "${entry.title}" (${href})`);
		}
		if (row.cell !== entry.index) {
			violations.push(`pillars/README.md: row cell for ${href} does not byte-match the frontmatter index`);
		}
	}
	for (const [href] of filesByKey) {
		if (!inventoryByHref.has(href)) violations.push(`pillars/README.md: missing inventory row for ${href}`);
	}
	return ![...filesByKey].every(([href, entry]) => {
		const row = inventoryByHref.get(href);
		return row !== undefined && row.title === entry.title && row.cell === entry.index;
	});
}

function auditPillarGovernance(pillarsDir: string, violations: string[]): void {
	const governancePath = join(pillarsDir, "GOVERNANCE.md");
	if (!existsSync(governancePath)) {
		violations.push("pillars/GOVERNANCE.md: required governance document is missing");
		return;
	}
	const governance = decodeFatalUtf8(readFileSync(governancePath));
	for (const heading of REQUIRED_GOVERNANCE_HEADINGS) {
		if (!governance.includes(`## ${heading}`)) {
			violations.push(`pillars/GOVERNANCE.md: missing required section "## ${heading}"`);
		}
	}
}

function auditArmoryPaths(root: string, violations: string[]): void {
	// The skill contract resolves corpus paths against the skill directory, not this reference's directory.
	const label = "skills/troll/references/pillar-armory.md";
	const armoryPath = join(root, label);
	if (!existsSync(armoryPath)) return;
	const armory = decodeFatalUtf8(readFileSync(armoryPath));
	for (const match of armory.matchAll(/(?:\.\.\/)+pillars\/[A-Za-z0-9-]+\.md/g)) {
		if (!existsSync(resolve(root, "skills/troll", match[0]))) {
			violations.push(`${label}: corpus path ${match[0]} does not resolve from the skill directory`);
		}
	}
}

function projectPillarInventory(entries: PillarEntry[], inventory: ReturnType<typeof parseInventory>): string {
	const filesByKey = new Map(entries.map((entry) => [entry.filename, entry]));
	const sortedEntries = [...entries].sort((a, b) => a.filename.localeCompare(b.filename));
	return PILLAR_SECTIONS.map(([type, heading]) => {
		// Preserve inventory order, then append new entries in filename order.
		const ordered = inventory.flatMap((row) => {
			const entry = filesByKey.get(row.href);
			return entry?.type === type ? [entry] : [];
		});
		for (const entry of sortedEntries) {
			if (entry.type === type && !ordered.includes(entry)) ordered.push(entry);
		}
		const column = type === "principle" ? "Core belief" : type === "pattern" ? "Structure" : "Recognition → move";
		return [
			`### ${heading}`,
			``,
			`| ${heading.replace(/s$/, "")} | ${column} |`,
			`|---|---|`,
			...ordered.map((entry) => `| [${entry.title}](${entry.filename}) | ${entry.index} |`),
		].join("\n");
	}).join("\n\n");
}

export function auditPillars(root: string): { violations: string[]; readmeProjection: string } {
	const violations: string[] = [];
	const pillarsDir = join(root, "pillars");

	if (!existsSync(pillarsDir)) {
		// Fixture roots for the extension-only rules carry no corpus; nothing to audit.
		return { violations, readmeProjection: "" };
	}

	if (existsSync(join(pillarsDir, "AGENTS.md"))) {
		violations.push("pillars/AGENTS.md must not exist; durable rules live in pillars/GOVERNANCE.md");
	}
	const readmePath = join(pillarsDir, "README.md");
	if (existsSync(readmePath)) {
		const content = pillarText(readmePath, "pillars/README.md", violations);
		if (content?.includes("pillars/AGENTS.md")) {
			violations.push("pillars/README.md: references retired pillars/AGENTS.md; point at pillars/GOVERNANCE.md");
		}
	}

	const entries: PillarEntry[] = [];
	for (const filename of readdirSync(pillarsDir).sort()) {
		const entry = pillarEntry(pillarsDir, filename, violations);
		if (entry) entries.push(entry);
	}
	auditPillarIdentities(entries, violations);
	const readme = pillarText(readmePath, "pillars/README.md", violations) ?? "";
	const inventory = parseInventory(readme);
	const filesByKey = new Map(entries.map((entry) => [entry.filename, entry]));
	const inventoryMismatch = auditPillarInventory(inventory, filesByKey, violations);

	auditPillarGovernance(pillarsDir, violations);
	auditArmoryPaths(root, violations);

	// Build the paste-ready projection only from fully valid metadata.
	const metaInvalid = violations.some((violation) =>
		/^(pillars\/(principle|pattern|heuristic)-|duplicate \(|skills\/troll\/references\/pillar-armory)/.test(violation),
	);
	const readmeDiverged = entries.length !== inventory.length || inventoryMismatch;
	const readmeProjection = !metaInvalid && readmeDiverged ? projectPillarInventory(entries, inventory) : "";
	return { violations, readmeProjection };
}

// --- rule 5: npm test globs cover every tracked test file ---------------

// `*` matches any run of characters except a path separator; no other glob
// feature is used by the test script, so none is supported here.
const globToRegExp = (glob: string): RegExp =>
	new RegExp(`^${glob.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "[^/]*" : `\\${ch}`))}$`);

const packageJsonPath = join(root, "package.json");
if (main && existsSync(packageJsonPath)) {
	let testScript: string | undefined;
	try {
		const manifest = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
			scripts?: Record<string, string>;
		};
		const candidate = manifest.scripts?.test;
		if (typeof candidate === "string") testScript = candidate;
	} catch {
		// An unparseable manifest is not this rule's business; other gates own it.
	}
	if (testScript !== undefined) {
		const globs = [...testScript.matchAll(/["']([^"']*\.test\.mts)["']/g)].map((match) => globToRegExp(match[1]));
		for (const file of tracked.split("\n")) {
			if (!file.endsWith(".test.mts")) continue;
			if (globs.some((pattern) => pattern.test(file))) continue;
			fail(`${file}: no npm test glob matches it, so \`npm test\` never runs this file`);
		}
	}
}

if (main) {
	const pillarAudit = auditPillars(root);
	if (pillarAudit.readmeProjection) {
		console.log(
			`check-slices: paste-ready replacement for pillars/README.md\n--- BEGIN pillars/README.md inventory ---\n${pillarAudit.readmeProjection}\n--- END pillars/README.md inventory ---`,
		);
		fail("pillars/README.md: rows diverge from entry frontmatter; apply the replacement printed above");
	}
	for (const violation of pillarAudit.violations) fail(violation);

	if (failures.length > 0) {
		console.error(`check-slices: ${failures.length} violation(s)`);
		for (const failure of failures) console.error(`  - ${failure}`);
		process.exit(1);
	}
	console.log("check-slices: ok — extension anatomy, slice isolation, settings declarations, doc counts, test globs");
}
