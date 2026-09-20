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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const extensionsRoot = join(root, "extensions");

const failures: string[] = [];
const fail = (message: string) => failures.push(message);

// --- rule 1: extension anatomy -----------------------------------------

for (const entry of readdirSync(extensionsRoot, { withFileTypes: true })) {
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
if (existsSync(extensionsRoot)) walk(extensionsRoot);

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

// --- rule 3: no hardcoded counts in tracked docs -----------------------

const tracked = execFileSync("git", ["ls-files"], {
	cwd: root,
	encoding: "utf8",
});
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
if (existsSync(packageJsonPath)) {
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
console.log("check-slices: ok — extension anatomy, slice isolation, doc counts, test globs");
