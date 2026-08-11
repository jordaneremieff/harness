#!/usr/bin/env node

import { closeSync, existsSync, openSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const STANDARD_OPTIONAL_FIELDS = new Set(["license", "compatibility", "metadata", "allowed-tools"]);
const PI_ONLY_FIELDS = new Set(["disable-model-invocation"]);
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_REPORTED_PER_LEVEL = 40;
const MAX_DIAGNOSTIC_LENGTH = 500;
const DANGEROUS_YAML_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SCRIPT_TEST_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".py", ".sh"]);

type YamlScalar = string | number | boolean | null;
type YamlMapping = { [key: string]: YamlValue };
type YamlValue = YamlScalar | YamlMapping;
type BlockScalar = { style: "|" | ">"; chomping: "+" | "-" | "clip" };
type ScalarResult =
	| { value: YamlScalar }
	| { value: string; block: BlockScalar }
	| { error: string };
type Frontmatter = { yaml: string; body: string };
type BoundedText = { text: string; size: number; truncated: boolean };
type Finding = { code: string; message: string };
type SkillReference = { path: string; text: string };
type Skill = {
	directory: string;
	frontmatter?: YamlMapping;
	body?: string;
	files: string[];
	references: SkillReference[];
	scriptFiles: string[];
};
type OutputFormat = "text" | "json";
type ParseOptions = { help: true } | { help: false; directory: string; format: OutputFormat };
type ScalarKind = "string" | "boolean";
type ScalarCheck = { missing: boolean; value?: YamlValue };
type CodeFence = { character: string; length: number };
type LinkCandidate = { text: string; source: string };
type ValidationCounts = {
	fail: number;
	warn: number;
	shown: { fail: number; warn: number };
	omitted: { fail: number; warn: number };
};
type ValidationReport = {
	directory: string;
	ok: boolean;
	fail: Finding[];
	warn: Finding[];
	counts: ValidationCounts;
};

type YamlStackEntry = { indent: number; path: string[] };

function createYamlMapping(): YamlMapping {
	return Object.create(null) as YamlMapping;
}

function isYamlMapping(value: unknown): value is YamlMapping {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

const issues: Finding[] = [];
const warnings: Finding[] = [];
let issueCount = 0;
let warningCount = 0;
let skill: Skill;

function boundedDiagnostic(message: unknown): string {
	const safe = String(message).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, (character: string) =>
		`\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);
	return safe.length <= MAX_DIAGNOSTIC_LENGTH ? safe : `${safe.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function fail(code: string, message: string) {
	issueCount++;
	if (issues.length < MAX_REPORTED_PER_LEVEL) issues.push({ code, message: boundedDiagnostic(message) });
}

function warn(code: string, message: string) {
	warningCount++;
	if (warnings.length < MAX_REPORTED_PER_LEVEL) warnings.push({ code, message: boundedDiagnostic(message) });
}

function usage() {
	return `Usage: node scripts/validate-skill.mts [OPTIONS] [SKILL_DIR]

Validate a portable Agent Skills directory using dependency-free Node.

Options:
  --format text|json  Output format (default: text)
  -h, --help          Show this help

Output:
  stdout  Validation summary or JSON report
  stderr  Diagnostics for usage errors

Exit codes:
  0  No FAIL findings (WARN findings may remain)
  1  One or more FAIL findings
  2  Invalid invocation

Checks:
  - SKILL.md exists and is readable
  - frontmatter has required name and description fields
  - name matches the parent directory and portable naming rules
  - description is 1-1024 characters
  - standard optional fields and metadata values have portable types
  - unknown top-level fields are warnings; Pi-only fields are identified
  - inline and reference-style local links resolve, including fragments
  - common placeholders, operator-local paths, and tilde-home path forms are warnings
  - the body H1 must exist and match the frontmatter name (warning)
  - scripts must have a colocated test file (warning)
  - the description should state a do-not-use or boundary clause (warning)
  - standalone common credential forms are failures
  - scripts have discoverable --help documentation
  - diagnostic lists and individual messages are bounded
`;
}

function parseArgs(argv: string[]): ParseOptions {
	let directory: string | undefined;
	let format: OutputFormat = "text";
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--format") {
			const requested = argv[++index] ?? "";
			if (requested !== "text" && requested !== "json") throw new Error(`--format must be text or json, received: ${requested}`);
			format = requested;
			continue;
		}
		if (arg.startsWith("--format=")) {
			const requested = arg.slice("--format=".length);
			if (requested !== "text" && requested !== "json") throw new Error(`--format must be text or json, received: ${requested}`);
			format = requested;
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		if (directory) throw new Error(`Expected one skill directory, received extra argument: ${arg}`);
		directory = arg;
	}
	return { help: false, directory: directory ?? process.cwd(), format };
}

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function readBoundedText(path: string): BoundedText {
	const size = statSync(path).size;
	if (size === 0) return { text: "", size, truncated: false };
	const buffer = Buffer.allocUnsafe(Math.min(size, MAX_FILE_BYTES));
	const descriptor = openSync(path, "r");
	let bytesRead = 0;
	try {
		bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
	} finally {
		closeSync(descriptor);
	}
	return { text: buffer.subarray(0, bytesRead).toString("utf8"), size, truncated: size > MAX_FILE_BYTES };
}

function extractFrontmatter(markdown: string): Frontmatter | undefined {
	const normalized = markdown.replace(/^\uFEFF/, "");
	const match = normalized.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
	if (!match) return undefined;
	return { yaml: match[1], body: normalized.slice(match[0].length) };
}

function stripYamlComment(value: string): string {
	let quote: string | undefined;
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
			if (quote === char) quote = undefined;
			else if (!quote) quote = char;
		}
		if (char === "#" && !quote && (index === 0 || /\s/.test(value[index - 1]))) break;
		result += char;
	}
	return result.trim();
}

function _splitTopLevel(value: string, delimiter: string): string[] {
	const parts = [];
	let current = "";
	let square = 0;
	let curly = 0;
	let quote: string | undefined;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
			if (quote === char) quote = undefined;
			else if (!quote) quote = char;
		}
		if (!quote) {
			if (char === "[") square++;
			if (char === "]") square--;
			if (char === "{") curly++;
			if (char === "}") curly--;
			if (char === delimiter && square === 0 && curly === 0) {
				parts.push(current);
				current = "";
				continue;
			}
		}
		current += char;
	}
	parts.push(current);
	return parts;
}

function parseScalar(raw: string, path: string): ScalarResult {
	const value = stripYamlComment(raw);
	if (!value) return { value: "" };
	const block = value.match(/^([|>])([+-])?$/);
	if (block) {
		const style = block[1] === ">" ? ">" : "|";
		const chomping = block[2] === "+" || block[2] === "-" ? block[2] : "clip";
		return { value: "", block: { style, chomping } };
	}
	if (value.startsWith('"')) {
		if (!value.endsWith('"') || value.length < 2) return { error: `${path}: unterminated double-quoted scalar` };
		try {
			const parsed: unknown = JSON.parse(value);
			return typeof parsed === "string" ? { value: parsed } : { error: `${path}: invalid double-quoted scalar` };
		} catch {
			return { error: `${path}: invalid double-quoted scalar` };
		}
	}
	if (value.startsWith("'")) {
		if (!value.endsWith("'") || value.length < 2) return { error: `${path}: unterminated single-quoted scalar` };
		return { value: value.slice(1, -1).replace(/''/g, "'") };
	}
	if (value.startsWith("[") || value.startsWith("{")) {
		return { error: `${path}: flow collections are outside this conservative validator; use block YAML` };
	}
	if (/^(?:null|~)$/i.test(value)) return { value: null };
	if (/^(?:true|false)$/i.test(value)) return { value: value.toLowerCase() === "true" };
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return { value: Number(value) };
	return { value };
}

function setNested(root: YamlMapping, path: string[], value: YamlValue): void {
	let target = root;
	for (let index = 0; index < path.length - 1; index++) {
		const key = path[index];
		const current = target[key];
		if (!current || typeof current !== "object" || Array.isArray(current)) {
			const next = createYamlMapping();
			target[key] = next;
			target = next;
		} else {
			target = current;
		}
	}
	target[path[path.length - 1]] = value;
}

function foldBlockLines(lines: string[]): string {
	let result = "";
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		result += line;
		if (index === lines.length - 1) continue;
		result += line === "" || lines[index + 1] === "" ? "\n" : " ";
	}
	return result;
}

function finishBlockScalar(lines: string[], block: BlockScalar): string {
	let value = block.style === ">" ? foldBlockLines(lines) : lines.join("\n");
	if (block.chomping === "-") return value.replace(/\n+$/, "");
	if (block.chomping === "+") return lines.length > 0 && !value.endsWith("\n") ? `${value}\n` : value;
	value = value.replace(/\n+$/, "");
	return lines.length > 0 ? `${value}\n` : "";
}

function parseSimpleYaml(source: string): { value: YamlMapping } | { error: string } {
	const root = createYamlMapping();
	const lines = source.split(/\r?\n/);
	const stack: YamlStackEntry[] = [{ indent: -1, path: [] }];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		if (/^ *\t/.test(line)) return { error: `line ${index + 1}: tabs are not supported for indentation` };
		const indentMatch = line.match(/^ */);
		const indent = indentMatch ? indentMatch[0].length : 0;
		const trimmed = line.trimEnd().slice(indent);
		if (trimmed.startsWith("-")) return { error: `line ${index + 1}: sequences are outside this conservative validator` };
		const match = trimmed.match(/^([^:]+):(.*)$/);
		if (!match) return { error: `line ${index + 1}: expected a YAML mapping entry` };
		const key = match[1].trim();
		if (!key) return { error: `line ${index + 1}: empty mapping key` };
		if (DANGEROUS_YAML_KEYS.has(key)) return { error: `line ${index + 1}: unsafe mapping key: ${key}` };
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
		const parent = stack[stack.length - 1];
		if (indent <= parent.indent) return { error: `line ${index + 1}: inconsistent indentation` };
		const path = [...parent.path, key];
		const raw = match[2];
		const scalar = parseScalar(raw, path.join("."));
		if ("error" in scalar) return { error: `line ${index + 1}: ${scalar.error}` };
		if ("block" in scalar) {
			const rawBlockLines: string[] = [];
			let cursor = index + 1;
			for (; cursor < lines.length; cursor++) {
				const next = lines[cursor];
				if (!next.trim()) {
					rawBlockLines.push(next);
					continue;
				}
				const nextIndentMatch = next.match(/^ */);
				const nextIndent = nextIndentMatch ? nextIndentMatch[0].length : 0;
				if (nextIndent <= indent) break;
				rawBlockLines.push(next);
			}
			const contentIndents = rawBlockLines
				.filter((blockLine) => blockLine.trim())
				.map((blockLine) => {
					const blockIndentMatch = blockLine.match(/^ */);
					return blockIndentMatch ? blockIndentMatch[0].length : 0;
				});
			const contentIndent = contentIndents.length > 0 ? Math.min(...contentIndents) : indent + 1;
			const blockLines = rawBlockLines.map((blockLine) => blockLine.trim() ? blockLine.slice(contentIndent) : "");
			index = cursor - 1;
			setNested(root, path, finishBlockScalar(blockLines, scalar.block));
			continue;
		}
		setNested(root, path, scalar.value);
		if (!raw.trim()) stack.push({ indent, path });
	}
	return { value: root };
}

function checkScalar(path: string[], expected: ScalarKind): ScalarCheck {
	const value = path.reduce<YamlValue | undefined>(
		(target, key) => (isYamlMapping(target) ? target[key] : undefined),
		skill.frontmatter,
	);
	if (value === undefined) return { missing: true };
	if (expected === "string" && typeof value !== "string") {
		fail("frontmatter.type", `${path.join(".")} must be a string`);
		return { missing: false };
	}
	if (expected === "boolean" && typeof value !== "boolean") {
		fail("frontmatter.type", `${path.join(".")} must be a boolean`);
		return { missing: false };
	}
	return { missing: false, value };
}

function checkName(): void {
	const { value, missing } = checkScalar(["name"], "string");
	if (missing) {
		fail("frontmatter.required", "frontmatter.name is required");
		return;
	}
	if (typeof value !== "string") return;
	if (!value) {
		fail("name.empty", "frontmatter.name must not be empty");
		return;
	}
	if (value.length > MAX_NAME_LENGTH) fail("name.length", `name is ${value.length} characters; maximum is ${MAX_NAME_LENGTH}`);
	if (!/^[a-z0-9-]+$/.test(value)) fail("name.characters", "name must contain only lowercase letters, digits, and hyphens");
	if (value.startsWith("-") || value.endsWith("-")) fail("name.edges", "name must not start or end with a hyphen");
	if (value.includes("--")) fail("name.consecutive", "name must not contain consecutive hyphens");
	const parent = basename(skill.directory);
	if (parent !== value) fail("name.directory", `name '${value}' does not match parent directory '${parent}'`);
}

function normalizedToken(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function firstH1(markdown: string): string | undefined {
	const match = markdown.match(/^[ \t]{0,3}#[ \t]+(.+?)[ \t]*$/m);
	return match ? match[1].trim() : undefined;
}

function checkBodyH1(): void {
	const name = skill.frontmatter?.name;
	const body = skill.body;
	if (typeof name !== "string" || name === "" || body === undefined) return;
	const h1 = firstH1(body);
	if (!h1) {
		warn("body.h1", "SKILL.md body has no H1 heading matching the frontmatter name");
		return;
	}
	if (normalizedToken(h1) !== normalizedToken(name)) {
		warn("body.h1", `body H1 '${h1}' does not match frontmatter name '${name}'`);
	}
}

function checkDescription(): void {
	const { value, missing } = checkScalar(["description"], "string");
	if (missing) {
		fail("frontmatter.required", "frontmatter.description is required");
		return;
	}
	if (typeof value !== "string") return;
	if (!value.trim()) {
		fail("description.empty", "description must not be empty");
		return;
	}
	if (value.length > MAX_DESCRIPTION_LENGTH) fail("description.length", `description is ${value.length} characters; maximum is ${MAX_DESCRIPTION_LENGTH}`);
	if (!/\buse\b|\bwhen\b/i.test(value)) warn("description.trigger", "description should state when to use the skill");
	if (!/\bdo not use\b/i.test(value)) warn("description.boundary", "description should state a do-not-use or boundary clause");
}

function checkFields(): void {
	const frontmatter = skill.frontmatter;
	if (!frontmatter) return;
	for (const key of Object.keys(frontmatter)) {
		if (["name", "description"].includes(key)) continue;
		if (STANDARD_OPTIONAL_FIELDS.has(key)) continue;
		if (PI_ONLY_FIELDS.has(key)) {
			warn("frontmatter.client", `${key} is Pi-specific, not part of the portable Agent Skills core`);
			continue;
		}
		warn("frontmatter.unknown", `unknown frontmatter field: ${key}`);
	}

	const license = frontmatter.license;
	if (license !== undefined && typeof license !== "string") fail("license.type", "license must be a string");

	const compatibility = frontmatter.compatibility;
	if (compatibility !== undefined) {
		if (typeof compatibility !== "string") fail("compatibility.type", "compatibility must be a string");
		else if (compatibility.length < 1 || compatibility.length > 500) {
			fail("compatibility.length", `compatibility is ${compatibility.length} characters; expected 1-500`);
		}
	}

	const metadata = frontmatter.metadata;
	if (metadata !== undefined) {
		if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
			fail("metadata.type", "metadata must be a mapping from string keys to string values");
		} else {
			for (const [key, value] of Object.entries(metadata)) {
				if (typeof value !== "string") fail("metadata.value", `metadata.${key} must be a string`);
			}
		}
	}

	const allowedTools = frontmatter["allowed-tools"];
	if (allowedTools !== undefined && typeof allowedTools !== "string") {
		fail("allowed-tools.type", "allowed-tools must be a space-separated string");
	}

	if (frontmatter["disable-model-invocation"] !== undefined) {
		checkScalar(["disable-model-invocation"], "boolean");
	}
}

function decodeLink(link: string): string {
	try {
		return decodeURIComponent(link);
	} catch {
		return link;
	}
}

function markdownWithoutCode(text: string): string {
	let fence: CodeFence | undefined;
	return text.split(/\r?\n/).map((line) => {
		if (fence) {
			const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
			if (close && close[1][0] === fence.character && close[1].length >= fence.length) fence = undefined;
			return "";
		}
		const open = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
		if (open) {
			fence = { character: open[1][0], length: open[1].length };
			return "";
		}
		return line.replace(/(`+)[^`\n]*?\1/g, "");
	}).join("\n");
}

function referenceId(value: string): string {
	return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function headingSlug(value: string): string {
	return value
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[`*_~]/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s_-]/gu, "")
		.trim()
		.replace(/\s+/g, "-");
}

function markdownAnchors(text: string): Set<string> {
	const markdown = markdownWithoutCode(text);
	const lines = markdown.split(/\r?\n/);
	const anchors = new Set<string>();
	const slugCounts = new Map<string, number>();
	const addHeading = (heading: string): void => {
		const explicit = heading.match(/\s+\{#([^}]+)\}\s*$/);
		if (explicit) {
			anchors.add(explicit[1]);
			heading = heading.slice(0, explicit.index);
		}
		const base = headingSlug(heading.replace(/[ \t]+#+[ \t]*$/, ""));
		if (!base) return;
		const count = slugCounts.get(base) ?? 0;
		anchors.add(count === 0 ? base : `${base}-${count}`);
		slugCounts.set(base, count + 1);
	};

	for (let index = 0; index < lines.length; index++) {
		const atx = lines[index].match(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)\s*$/);
		if (atx) addHeading(atx[1]);
		else if (index + 1 < lines.length && /^[ \t]{0,3}(?:=+|-+)[ \t]*$/.test(lines[index + 1]) && lines[index].trim()) {
			addHeading(lines[index].trim());
			index++;
		}
	}
	for (const match of markdown.matchAll(/<[^>]+\s(?:id|name)=["']([^"']+)["'][^>]*>/gi)) anchors.add(match[1]);
	return anchors;
}

function checkFragment(resolved: string, fragment: string, source: string, target: string): void {
	if (fragment === "") {
		fail("link.fragment-empty", `${source}: link '${target}' has an empty fragment`);
		return;
	}
	if (![".md", ".markdown"].includes(extname(resolved).toLowerCase())) return;
	const loaded = readBoundedText(resolved);
	if (loaded.truncated) {
		warn("link.fragment-unchecked", `${source}: fragment not checked in oversized file: ${target}`);
		return;
	}
	const decoded = decodeLink(fragment);
	const anchors = markdownAnchors(loaded.text);
	if (!anchors.has(decoded) && !anchors.has(decoded.toLowerCase())) {
		fail("link.fragment-missing", `${source}: fragment does not match a heading or explicit anchor: ${target}`);
	}
}

function checkLinkTarget(rawTarget: string, source: string): void {
	let target = rawTarget.trim();
	if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
	if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/")) {
		fail("link.absolute", `${source}: link '${target}' is absolute, not skill-relative`);
		return;
	}
	if (/^(?:https?:|mailto:)/i.test(target)) return;
	if (/^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(target)) return;

	const hashIndex = target.indexOf("#");
	const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined;
	const beforeFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
	const pathOnly = beforeFragment.split("?", 1)[0];
	const sourceFile = source === "SKILL.md body" ? join(skill.directory, "SKILL.md") : join(skill.directory, source);
	const resolved = pathOnly ? resolve(dirname(sourceFile), decodeLink(pathOnly)) : sourceFile;
	const relativeTarget = relative(skill.directory, resolved);
	if (relativeTarget === ".." || relativeTarget.startsWith(`..${sep}`)) {
		fail("link.escape", `${source}: link '${target}' escapes the skill directory`);
		return;
	}
	if (!existsSync(resolved)) {
		fail("link.missing", `${source}: linked path does not exist: ${target}`);
		return;
	}
	const realTarget = realpathSync(resolved);
	const realRoot = realpathSync(skill.directory);
	const realRelative = relative(realRoot, realTarget);
	if (realRelative === ".." || realRelative.startsWith(`..${sep}`)) {
		fail("link.escape", `${source}: link '${target}' resolves through a symlink outside the skill directory`);
		return;
	}
	if (fragment !== undefined) checkFragment(resolved, fragment, source, target);
}

function checkLinks(): void {
	const body = skill.body;
	if (body === undefined) return;
	const inlineLink = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
	const referenceDefinition = /^[ \t]{0,3}\[((?!\^)[^\]]+)\]:[ \t]*(<[^>]+>|\S+)/gm;
	const referenceUse = /!?\[([^\]]+)\]\[([^\]]*)\]/g;
	const candidates: LinkCandidate[] = [
		{ text: body, source: "SKILL.md body" },
		...skill.references.map((file) => ({ text: file.text, source: relative(skill.directory, file.path) })),
	];
	for (const candidate of candidates) {
		const markdown = markdownWithoutCode(candidate.text);
		for (const match of markdown.matchAll(inlineLink)) checkLinkTarget(match[1], candidate.source);

		const definitions = new Map<string, string>();
		for (const match of markdown.matchAll(referenceDefinition)) {
			definitions.set(referenceId(match[1]), match[2]);
			checkLinkTarget(match[2], candidate.source);
		}
		for (const match of markdown.matchAll(referenceUse)) {
			const id = referenceId(match[2] || match[1]);
			if (!definitions.has(id)) fail("link.reference-missing", `${candidate.source}: reference link definition is missing: ${id}`);
		}
	}
}

function walk(directory: string): string[] {
	const results: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) results.push(...walk(path));
		else if (entry.isFile()) results.push(path);
	}
	return results;
}

function likelySecret(text: string): boolean {
	return [
		/\bsk-[A-Za-z0-9_-]{12,}/,
		/\bgh[pousr]_[A-Za-z0-9_]{12,}/,
		/\bxox[baprs]-[A-Za-z0-9-]{10,}/,
		/\bAKIA[0-9A-Z]{16}\b/,
		/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
		/(?:api[_-]?key|secret|token|password|credential)[^\n]{0,24}[=:][ \t]*["']?[A-Za-z0-9_./+=-]{16,}/i,
	].some((pattern) => pattern.test(text));
}

function checkFiles(): void {
	for (const file of skill.files) {
		const rel = relative(skill.directory, file);
		const extension = extname(file).toLowerCase();
		if (![".md", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".sh", ".json", ".yaml", ".yml", ".txt"].includes(extension)) continue;
		const size = statSync(file).size;
		if (size > MAX_FILE_BYTES) {
			warn("file.large", `${rel} is ${size} bytes; not scanned for placeholder/security markers`);
			continue;
		}
		const text = readBoundedText(file).text;
		const placeholderPattern = new RegExp(`\\b(?:${["TO" + "DO:", "FIX" + "ME:", "<replace-" + "me>"].join("|")})`, "i");
		if (placeholderPattern.test(text)) warn("file.placeholder", `${rel} contains a task marker or replacement token`);
		if (/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/m.test(text)) {
			warn("file.absolute-path", `${rel} contains an operator-local absolute path`);
		}
		if (/(?:^|[\s"'`(])~\/+/m.test(text)) {
			warn("path.operator-home", `${rel} contains an operator-private home path form (tilde-slash)`);
		}
		if (likelySecret(text)) fail("file.secret", `${rel} contains a likely credential or private key`);
	}
	for (const file of skill.scriptFiles) {
		if (statSync(file).size > MAX_FILE_BYTES) continue;
		const rel = relative(skill.directory, file);
		const text = readBoundedText(file).text;
		if (!text.includes("--help") && !text.includes("usage")) warn("script.help", `${rel} does not visibly document --help or usage`);
	}
}

function checkScriptTests(): void {
	const scriptsDir = join(skill.directory, "scripts");
	if (!isDirectory(scriptsDir)) return;
	const names = new Set(skill.scriptFiles.filter((file) => dirname(file) === scriptsDir).map((file) => basename(file)));
	for (const file of skill.scriptFiles) {
		if (dirname(file) !== scriptsDir) continue;
		const name = basename(file);
		if (!SCRIPT_TEST_EXTENSIONS.has(extname(name).toLowerCase())) continue;
		if (/\.test\./i.test(name) || /^test-/i.test(name)) continue;
		const stem = name.slice(0, name.lastIndexOf("."));
		const extension = name.slice(name.lastIndexOf("."));
		if (names.has(`${stem}.test${extension}`) || names.has(`test-${name}`)) continue;
		warn("script.test-missing", `${relative(skill.directory, file)} has no colocated test file (expected ${stem}.test${extension} or test-${name})`);
	}
}

function collectFiles(): void {
	skill.files = walk(skill.directory);
	skill.references = [];
	const referencesDir = join(skill.directory, "references");
	if (isDirectory(referencesDir)) {
		for (const file of walk(referencesDir).filter((path) => path.toLowerCase().endsWith(".md"))) {
			skill.references.push({ path: file, text: readBoundedText(file).text });
		}
	}
	const scriptsDir = join(skill.directory, "scripts");
	skill.scriptFiles = isDirectory(scriptsDir) ? walk(scriptsDir) : [];
}

function main(): void {
	let options: ParseOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`Error: ${message}`);
		console.error(usage());
		process.exit(2);
	}
	if (options.help) {
		console.log(usage());
		process.exit(0);
	}
	const directory = resolve(options.directory);
	skill = { directory, files: [], references: [], scriptFiles: [] };
	if (!isDirectory(directory)) {
		console.error(`Error: skill directory does not exist or is not a directory: ${directory}`);
		process.exit(2);
	}
	const skillPath = join(directory, "SKILL.md");
	if (!existsSync(skillPath)) fail("skill.missing", `SKILL.md is required at ${skillPath}`);
	else {
		const markdown = readBoundedText(skillPath).text;
		const parsed = extractFrontmatter(markdown);
		if (!parsed) fail("frontmatter.missing", "SKILL.md must start with YAML frontmatter fenced by --- lines");
		else {
			const frontmatter = parseSimpleYaml(parsed.yaml);
			if ("error" in frontmatter) fail("frontmatter.parse", frontmatter.error);
			else {
				skill.frontmatter = frontmatter.value;
				skill.body = parsed.body;
			}
		}
	}
	if (skill.frontmatter) {
		checkName();
		checkDescription();
		checkFields();
		if (skill.body !== undefined) checkBodyH1();
	}
	collectFiles();
	if (skill.body !== undefined) checkLinks();
	checkScriptTests();
	checkFiles();

	const omittedFail = issueCount - issues.length;
	const omittedWarn = warningCount - warnings.length;
	const report: ValidationReport = {
		directory,
		ok: issueCount === 0,
		fail: issues,
		warn: warnings,
		counts: {
			fail: issueCount,
			warn: warningCount,
			shown: { fail: issues.length, warn: warnings.length },
			omitted: { fail: omittedFail, warn: omittedWarn },
		},
	};
	if (options.format === "json") {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`${issueCount === 0 ? "PASS" : "FAIL"} ${directory}`);
		for (const issue of issues) console.log(`FAIL ${issue.code}: ${issue.message}`);
		if (omittedFail > 0) console.log(`FAIL report.truncated: ${omittedFail} additional FAIL findings omitted`);
		for (const warning of warnings) console.log(`WARN ${warning.code}: ${warning.message}`);
		if (omittedWarn > 0) console.log(`WARN report.truncated: ${omittedWarn} additional WARN findings omitted`);
		console.log(`Summary: ${issueCount} fail, ${warningCount} warn`);
	}
	process.exit(issueCount === 0 ? 0 : 1);
}

main();
