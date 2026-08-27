#!/usr/bin/env node
// check-slices.mts — repo gate for the vertical-slice architecture rules.
//
// Enforces the AGENTS.md invariants that npm test cannot see:
//   1. every extension under extensions/ is a complete vertical slice:
//      index.ts with a default-export factory, README.md, and at least one
//      colocated *.test.mts;
//   2. no extension imports a sibling: no `from "../"`, no absolute import,
//      no path that reaches into another extension's directory;
//   3. no hardcoded counts of tests, tools, or files in tracked docs
//      (AGENTS.md: "Do not hardcode counts ... in durable documentation");
//   4. pillar corpus contract: strict frontmatter on every entry, README as
//      a verbatim-quote inventory, GOVERNANCE.md present with required
//      sections, skill pointers intact, armory targets resolving, and no
//      retired governance file returning.
//
// Dependency-free by design (node builtins only), mirroring the established
// pattern of skills/harness/scripts/validate-skill.mts.
//
// Exit status: 0 when all rules hold, 1 listing every violation otherwise.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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
	const source = readFileSync(file, "utf8");
	for (const match of source.matchAll(specifierPattern)) {
		const specifier = match[1];
		if (specifier.startsWith("../")) {
			fail(`${rel}: import "${specifier}" escapes the extension slice`);
		} else if (specifier.startsWith("/")) {
			fail(`${rel}: absolute import "${specifier}"`);
		} else if (/^extensions\//.test(specifier)) {
			fail(`${rel}: import "${specifier}" reaches into extensions/ by path`);
		} else {
			const cross = specifier.match(/\/extensions\/([^/]+)\//);
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

function parsePillarFrontmatter(text: string): { title: string; index: string } {
	if (!/^---\r?\n/.test(text)) {
		throw new Error(`frontmatter missing; expected opening --- on line 1`);
	}
	const lines = text.split(/\r?\n/);
	let closeIndex = -1;
	for (let i = 1; i < lines.length && i <= 20; i += 1) {
		if (/^---\s*$/.test(lines[i])) {
			closeIndex = i;
			break;
		}
		if (/^# /.test(lines[i])) break;
	}
	if (closeIndex < 0) throw new Error(`frontmatter opened on line 1 but has no closing --- fence`);

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
	for (const required of ["title", "index"] as const) {
		if (!seen.has(required)) throw new Error(`frontmatter missing required key "${required}"`);
	}
	return { title: seen.get("title")!, index: seen.get("index")! };
}

function parseInventory(readme: string): Array<{ href: string; title: string; cell: string }> {
	const inventory: Array<{ href: string; title: string; cell: string }> = [];
	for (const match of readme.matchAll(/^\| \[([^\]]+)\]\(([^)]+)\) \| (.+?) \|$/gm)) {
		inventory.push({ href: match[2].replace(/^pillars\//, ""), title: match[1], cell: match[3] });
	}
	return inventory;
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
	for (const watched of [join(pillarsDir, "README.md"), join(root, "skills", "pillars", "SKILL.md")]) {
		if (existsSync(watched)) {
			let content: string;
			try {
				content = decodeFatalUtf8(readFileSync(watched));
			} catch {
				violations.push(`${relative(root, watched)}: invalid UTF-8`);
				content = "";
			}
			if (content.includes("pillars/AGENTS.md")) {
				violations.push(
					`${relative(root, watched)}: references retired pillars/AGENTS.md; point at pillars/GOVERNANCE.md`,
				);
			}
		}
	}

	const entries: PillarEntry[] = [];
	for (const filename of readdirSync(pillarsDir).sort()) {
		const typeMatch = filename.match(/^(principle|pattern|heuristic)-.+\.md$/);
		if (!typeMatch || filename === "README.md" || filename === "GOVERNANCE.md") continue;
		const relPath = `pillars/${filename}`;
		const filePath = join(pillarsDir, filename);
		let text: string;
		try {
			text = decodeFatalUtf8(readFileSync(filePath));
		} catch {
			violations.push(`${relPath}: invalid UTF-8`);
			continue;
		}
		let meta: { title: string; index: string };
		try {
			meta = parsePillarFrontmatter(text);
		} catch (error) {
			violations.push(`${relPath}: ${(error as Error).message}`);
			continue;
		}
		const bodyLines = text.split(/\r?\n/).slice(text.split(/\r?\n/).findIndex((l) => /^---\s*$/.test(l)) + 1);
		let typeWord: string | undefined;
		let bodyTitle: string | undefined;
		for (const line of bodyLines) {
			const h1 = line.match(/^(#[^#].*)$/);
			if (h1) {
				const typed = h1[1].match(/^(# (?:Principle|Pattern|Heuristic):) (.+)$/);
				if (typed) {
					typeWord = TYPE_BY_HEADING[typed[1]];
					bodyTitle = typed[2];
				} else {
					violations.push(`${relPath}: H1 "${h1[1]}" lacks a typed "# Principle:/Pattern:/Heuristic:" form`);
				}
				break;
			}
		}
		if (!bodyTitle || !typeWord) {
			violations.push(`${relPath}: no typed H1 found after frontmatter`);
			continue;
		}
		if (typeMatch[1] !== typeWord) {
			violations.push(`${relPath}: filename prefix "${typeMatch[1]}" disagrees with H1 type "${typeWord}"`);
		}
		if (meta.title !== bodyTitle) {
			violations.push(`${relPath}: frontmatter title "${meta.title}" != H1 name "${bodyTitle}"`);
		}
		entries.push({ type: typeWord, filename, title: meta.title, index: meta.index });
	}

	const identityKeys = new Set<string>();
	for (const entry of entries) {
		const identity = `${entry.type}:${entry.title}`;
		if (identityKeys.has(identity)) {
			violations.push(`duplicate (type,title) identity "${identity}"`);
		}
		identityKeys.add(identity);
	}

	const readmeRel = "pillars/README.md";
	const readmePathAbs = join(pillarsDir, "README.md");
	let readme: string;
	try {
		readme = decodeFatalUtf8(readFileSync(readmePathAbs));
	} catch {
		violations.push(`${readmeRel}: invalid UTF-8`);
		readme = "";
	}
	const inventory = parseInventory(readme);
	const inventoryByHref = new Map(inventory.map((row) => [row.href, row] as const));
	const filesByKey = new Map(entries.map((e) => [e.filename, e] as const));
	for (const [href, row] of inventoryByHref) {
		if (!filesByKey.has(href)) {
			violations.push(`${readmeRel}: row links to unknown entry "${href}"`);
			continue;
		}
		const entry = filesByKey.get(href)!;
		if (row.title !== entry.title) {
			violations.push(`${readmeRel}: row label "${row.title}" != frontmatter title "${entry.title}" (${href})`);
		}
		if (row.cell !== entry.index) {
			violations.push(`${readmeRel}: row cell for ${href} does not byte-match the frontmatter index`);
		}
	}
	for (const [href] of filesByKey) {
		if (!inventoryByHref.has(href)) {
			violations.push(`${readmeRel}: missing inventory row for ${href}`);
		}
	}

	const governancePath = join(pillarsDir, "GOVERNANCE.md");
	if (!existsSync(governancePath)) {
		violations.push("pillars/GOVERNANCE.md: required governance document is missing");
	} else {
		const governance = decodeFatalUtf8(readFileSync(governancePath));
		for (const heading of REQUIRED_GOVERNANCE_HEADINGS) {
			if (!governance.includes(`## ${heading}`)) {
				violations.push(`pillars/GOVERNANCE.md: missing required section "## ${heading}"`);
			}
		}
	}

	const skillRel = "skills/pillars/SKILL.md";
	const skillPath = join(root, skillRel);
	if (existsSync(skillPath)) {
		const skill = decodeFatalUtf8(readFileSync(skillPath));
		for (const pointer of ["../../pillars/README.md", "../../pillars/GOVERNANCE.md"]) {
			if (!skill.includes(pointer)) {
				violations.push(`${skillRel}: missing required pointer "${pointer}"`);
			}
		}
	} else {
		violations.push(`${skillRel}: consultation adapter is missing`);
	}

	const armoryPath = join(root, "skills", "troll", "references", "pillar-armory.md");
	if (existsSync(armoryPath)) {
		const armory = decodeFatalUtf8(readFileSync(armoryPath));
		for (const match of armory.matchAll(/\.\.\/\.\.\/(pillars\/[a-z-]+\.md)/g)) {
			const target = join(pillarsDir, match[1].replace(/^pillars\//, ""));
			if (!existsSync(target)) {
				violations.push(`skills/troll/references/pillar-armory.md: mapping target ../../${match[1]} does not exist`);
			}
		}
	}

	// Build the paste-ready projection only from fully valid metadata.
	let readmeProjection = "";
	const metaInvalid = violations.some((violation) =>
		/^(pillars\/(principle|pattern|heuristic)-|duplicate \(|skills\/troll\/references\/pillar-armory)/.test(violation),
	);
	const readmeDiverged =
		entries.length !== inventory.length ||
		![...filesByKey].every(([href, entry]) => {
			const row = inventoryByHref.get(href);
			return row !== undefined && row.title === entry.title && row.cell === entry.index;
		});
	if (!metaInvalid && readmeDiverged) {
		// Projection preserves the existing README row order; genuinely new
		// entries append to their section sorted by filename.
		const orderedForType = new Map<string, PillarEntry[]>();
		for (const [type] of PILLAR_SECTIONS) orderedForType.set(type, []);
		for (const row of inventory) {
			const entry = filesByKey.get(row.href);
			if (entry) orderedForType.get(entry.type)?.push(entry);
		}
		for (const entry of [...entries].sort((a, b) => a.filename.localeCompare(b.filename))) {
			const bucket = orderedForType.get(entry.type)!;
			if (!bucket.includes(entry)) bucket.push(entry);
		}
		const blocks: string[] = [];
		for (const [type, heading] of PILLAR_SECTIONS) {
			const column = type === "principle" ? "Core belief" : type === "pattern" ? "Structure" : "Recognition → move";
			blocks.push(
				[
					`### ${heading}`,
					``,
					`| ${heading.replace(/s$/, "")} | ${column} |`,
					`|---|---|`,
					...(orderedForType.get(type) ?? []).map((e) => `| [${e.title}](${e.filename}) | ${e.index} |`),
				].join("\n"),
			);
		}
		readmeProjection = blocks.join("\n\n");
	}
	return { violations, readmeProjection };
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
console.log("check-slices: ok — extension anatomy, slice isolation, doc counts");
