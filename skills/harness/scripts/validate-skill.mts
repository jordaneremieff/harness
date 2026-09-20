#!/usr/bin/env node

import { closeSync, type Dirent, existsSync, openSync, opendirSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

const STANDARD_OPTIONAL_FIELDS = new Set(["license", "compatibility", "metadata", "allowed-tools"]);
const PI_ONLY_FIELDS = new Set(["disable-model-invocation"]);
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TREE_ENTRIES = 2048;
const MAX_TREE_DEPTH = 16;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_REPORTED_PER_LEVEL = 40;
const MAX_DIAGNOSTIC_LENGTH = 500;
const DANGEROUS_YAML_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const SCRIPT_TEST_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".mts", ".py", ".sh"]);
const SCANNABLE_EXTENSIONS = new Set([
	".md",
	".py",
	".js",
	".mjs",
	".cjs",
	".ts",
	".mts",
	".sh",
	".json",
	".yaml",
	".yml",
	".txt",
]);
const PLACEHOLDER_PATTERN = new RegExp(`\\b(?:${["TO" + "DO:", "FIX" + "ME:", "<replace-" + "me>"].join("|")})`, "i");
const ABSOLUTE_PATH_PATTERN = /(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\/Users\/|\/home\/)/m;
const OPERATOR_HOME_PATTERN = /(?:^|[\s"'`(])~\/+/m;

type YamlScalar = string | number | boolean | null;
type YamlMapping = { [key: string]: YamlValue };
type YamlValue = YamlScalar | YamlMapping;
type BlockScalar = { style: "|" | ">"; chomping: "+" | "-" | "clip" };
type ScalarResult = { value: YamlScalar } | { value: string; block: BlockScalar } | { error: string };
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
type LineEntry = { key: string; raw: string; indent: number };
type LineResult = { kind: "skip" } | { kind: "error"; error: string } | { kind: "entry"; entry: LineEntry };
type WalkState = { results: string[]; visited: number };

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
let scannedBytes = 0;
let scanLimitReported = false;
let skill: Skill;

function boundedDiagnostic(message: unknown): string {
	const safe = String(message).replace(
		/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
		(character: string) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
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
	return `Usage: node skills/harness/scripts/validate-skill.mts [OPTIONS] [SKILL_DIR]

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
  - traversal stops at 2048 entries or 16 directory levels; hidden entries and node_modules are skipped
  - text reads stop at 16 MiB total; incomplete scans fail
  - diagnostic lists and individual messages are bounded
`;
}

function parseFormatValue(requested: string): OutputFormat {
	if (requested !== "text" && requested !== "json")
		throw new Error(`--format must be text or json, received: ${requested}`);
	return requested;
}

function parseArgs(argv: string[]): ParseOptions {
	let directory: string | undefined;
	let format: OutputFormat = "text";
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--format") {
			format = parseFormatValue(argv[++index] ?? "");
			continue;
		}
		if (arg.startsWith("--format=")) {
			format = parseFormatValue(arg.slice("--format=".length));
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
	const readSize = Math.min(size, MAX_FILE_BYTES);
	if (scannedBytes + readSize > MAX_SCAN_BYTES) {
		if (!scanLimitReported) fail("scan.limit", "text read budget exceeded; validation is incomplete");
		scanLimitReported = true;
		return { text: "", size, truncated: true };
	}
	scannedBytes += readSize;
	const buffer = Buffer.allocUnsafe(readSize);
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

function toggleQuote(char: string, previous: string | undefined, quote: string | undefined): string | undefined {
	if ((char !== '"' && char !== "'") || previous === "\\") return quote;
	return quote === char ? undefined : (quote ?? char);
}

function bracketDelta(char: string): { square: number; curly: number } | undefined {
	if (char === "[") return { square: 1, curly: 0 };
	if (char === "]") return { square: -1, curly: 0 };
	if (char === "{") return { square: 0, curly: 1 };
	if (char === "}") return { square: 0, curly: -1 };
	return undefined;
}

function _splitTopLevel(value: string, delimiter: string): string[] {
	const parts: string[] = [];
	let current = "";
	let square = 0;
	let curly = 0;
	let quote: string | undefined;
	let previous: string | undefined;
	for (const char of value) {
		quote = toggleQuote(char, previous, quote);
		if (!quote) {
			const delta = bracketDelta(char);
			if (delta) {
				square += delta.square;
				curly += delta.curly;
			} else if (char === delimiter && square === 0 && curly === 0) {
				parts.push(current);
				current = "";
				previous = char;
				continue;
			}
		}
		current += char;
		previous = char;
	}
	parts.push(current);
	return parts;
}

function parseBlockHeader(value: string): { value: ""; block: BlockScalar } | undefined {
	const match = value.match(/^([|>])([+-])?$/);
	if (!match) return undefined;
	const style = match[1] === ">" ? ">" : "|";
	const chomping = match[2] === "+" || match[2] === "-" ? match[2] : "clip";
	return { value: "", block: { style, chomping } };
}

function parseDoubleQuoted(value: string, path: string): ScalarResult {
	if (!value.endsWith('"') || value.length < 2) return { error: `${path}: unterminated double-quoted scalar` };
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === "string" ? { value: parsed } : { error: `${path}: invalid double-quoted scalar` };
	} catch {
		return { error: `${path}: invalid double-quoted scalar` };
	}
}

function parseSingleQuoted(value: string, path: string): ScalarResult {
	if (!value.endsWith("'") || value.length < 2) return { error: `${path}: unterminated single-quoted scalar` };
	return { value: value.slice(1, -1).replace(/''/g, "'") };
}

function parsePlainScalar(value: string): ScalarResult {
	if (/^(?:null|~)$/i.test(value)) return { value: null };
	if (/^(?:true|false)$/i.test(value)) return { value: value.toLowerCase() === "true" };
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return { value: Number(value) };
	return { value };
}

function parseScalar(raw: string, path: string): ScalarResult {
	const value = stripYamlComment(raw);
	if (!value) return { value: "" };
	const block = parseBlockHeader(value);
	if (block) return block;
	if (value.startsWith('"')) return parseDoubleQuoted(value, path);
	if (value.startsWith("'")) return parseSingleQuoted(value, path);
	if (value.startsWith("[") || value.startsWith("{")) {
		return { error: `${path}: flow collections are outside this conservative validator; use block YAML` };
	}
	return parsePlainScalar(value);
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

function leadingSpaces(line: string): number {
	const match = line.match(/^ */);
	return match ? match[0].length : 0;
}

function parseLineEntry(line: string, lineNumber: number): LineResult {
	if (!line.trim() || line.trimStart().startsWith("#")) return { kind: "skip" };
	if (/^ *\t/.test(line)) return { kind: "error", error: `line ${lineNumber}: tabs are not supported for indentation` };
	const indent = leadingSpaces(line);
	const trimmed = line.trimEnd().slice(indent);
	if (trimmed.startsWith("-"))
		return { kind: "error", error: `line ${lineNumber}: sequences are outside this conservative validator` };
	const match = trimmed.match(/^([^:]+):(.*)$/);
	if (!match) return { kind: "error", error: `line ${lineNumber}: expected a YAML mapping entry` };
	const key = match[1].trim();
	if (!key) return { kind: "error", error: `line ${lineNumber}: empty mapping key` };
	if (DANGEROUS_YAML_KEYS.has(key))
		return { kind: "error", error: `line ${lineNumber}: unsafe mapping key: ${key}` };
	return { kind: "entry", entry: { key, raw: match[2], indent } };
}

function resolveParent(stack: YamlStackEntry[], indent: number): YamlStackEntry | undefined {
	while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
	const parent = stack[stack.length - 1];
	return indent <= parent.indent ? undefined : parent;
}

function collectBlockLines(
	lines: string[],
	startIndex: number,
	parentIndent: number,
): { rawBlockLines: string[]; nextIndex: number } {
	const rawBlockLines: string[] = [];
	let cursor = startIndex;
	for (; cursor < lines.length; cursor++) {
		const next = lines[cursor];
		if (!next.trim()) {
			rawBlockLines.push(next);
			continue;
		}
		if (leadingSpaces(next) <= parentIndent) break;
		rawBlockLines.push(next);
	}
	return { rawBlockLines, nextIndex: cursor };
}

function blockContentIndent(rawBlockLines: string[], fallback: number): number {
	const indents = rawBlockLines.filter((line) => line.trim()).map(leadingSpaces);
	return indents.length > 0 ? Math.min(...indents) : fallback;
}

function indentBlockLines(rawBlockLines: string[], contentIndent: number): string[] {
	return rawBlockLines.map((line) => (line.trim() ? line.slice(contentIndent) : ""));
}

function parseSimpleYaml(source: string): { value: YamlMapping } | { error: string } {
	const root = createYamlMapping();
	const lines = source.split(/\r?\n/);
	const stack: YamlStackEntry[] = [{ indent: -1, path: [] }];
	for (let index = 0; index < lines.length; index++) {
		const parsed = parseLineEntry(lines[index], index + 1);
		if (parsed.kind === "skip") continue;
		if (parsed.kind === "error") return { error: parsed.error };
		const { key, raw, indent } = parsed.entry;
		const parent = resolveParent(stack, indent);
		if (!parent) return { error: `line ${index + 1}: inconsistent indentation` };
		const path = [...parent.path, key];
		const scalar = parseScalar(raw, path.join("."));
		if ("error" in scalar) return { error: `line ${index + 1}: ${scalar.error}` };
		if ("block" in scalar) {
			const { rawBlockLines, nextIndex } = collectBlockLines(lines, index + 1, indent);
			const contentIndent = blockContentIndent(rawBlockLines, indent + 1);
			index = nextIndex - 1;
			setNested(root, path, finishBlockScalar(indentBlockLines(rawBlockLines, contentIndent), scalar.block));
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
	if (value.length > MAX_NAME_LENGTH)
		fail("name.length", `name is ${value.length} characters; maximum is ${MAX_NAME_LENGTH}`);
	if (!/^[a-z0-9-]+$/.test(value))
		fail("name.characters", "name must contain only lowercase letters, digits, and hyphens");
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
	if (value.length > MAX_DESCRIPTION_LENGTH)
		fail("description.length", `description is ${value.length} characters; maximum is ${MAX_DESCRIPTION_LENGTH}`);
	if (!/\buse\b|\bwhen\b/i.test(value)) warn("description.trigger", "description should state when to use the skill");
	if (!/\bdo not use\b/i.test(value))
		warn("description.boundary", "description should state a do-not-use or boundary clause");
}

function checkUnknownFields(frontmatter: YamlMapping): void {
	for (const key of Object.keys(frontmatter)) {
		if (["name", "description"].includes(key)) continue;
		if (STANDARD_OPTIONAL_FIELDS.has(key)) continue;
		if (PI_ONLY_FIELDS.has(key)) {
			warn("frontmatter.client", `${key} is Pi-specific, not part of the portable Agent Skills core`);
			continue;
		}
		warn("frontmatter.unknown", `unknown frontmatter field: ${key}`);
	}
}

function checkLicenseField(frontmatter: YamlMapping): void {
	const license = frontmatter.license;
	if (license !== undefined && typeof license !== "string") fail("license.type", "license must be a string");
}

function checkCompatibilityField(frontmatter: YamlMapping): void {
	const compatibility = frontmatter.compatibility;
	if (compatibility === undefined) return;
	if (typeof compatibility !== "string") {
		fail("compatibility.type", "compatibility must be a string");
		return;
	}
	if (compatibility.length < 1 || compatibility.length > 500) {
		fail("compatibility.length", `compatibility is ${compatibility.length} characters; expected 1-500`);
	}
}

function checkMetadataField(frontmatter: YamlMapping): void {
	const metadata = frontmatter.metadata;
	if (metadata === undefined) return;
	if (!isYamlMapping(metadata)) {
		fail("metadata.type", "metadata must be a mapping from string keys to string values");
		return;
	}
	for (const [key, value] of Object.entries(metadata)) {
		if (typeof value !== "string") fail("metadata.value", `metadata.${key} must be a string`);
	}
}

function checkAllowedToolsField(frontmatter: YamlMapping): void {
	const allowedTools = frontmatter["allowed-tools"];
	if (allowedTools !== undefined && typeof allowedTools !== "string") {
		fail("allowed-tools.type", "allowed-tools must be a space-separated string");
	}
}

function checkDisableModelInvocation(frontmatter: YamlMapping): void {
	if (frontmatter["disable-model-invocation"] !== undefined) {
		checkScalar(["disable-model-invocation"], "boolean");
	}
}

function checkFields(): void {
	const frontmatter = skill.frontmatter;
	if (!frontmatter) return;
	checkUnknownFields(frontmatter);
	checkLicenseField(frontmatter);
	checkCompatibilityField(frontmatter);
	checkMetadataField(frontmatter);
	checkAllowedToolsField(frontmatter);
	checkDisableModelInvocation(frontmatter);
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
	return text
		.split(/\r?\n/)
		.map((line) => {
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
		})
		.join("\n");
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

function withoutAngleBrackets(target: string): string {
	return target.startsWith("<") && target.endsWith(">") ? target.slice(1, -1) : target;
}

function isExternalReference(target: string): boolean {
	return /^(?:https?:|mailto:)/i.test(target) || /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)/.test(target);
}

function escapesDirectory(root: string, candidate: string): boolean {
	const relativeCandidate = relative(root, candidate);
	return relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`);
}

function linkTargetParts(target: string): { fragment: string | undefined; pathOnly: string } {
	const hashIndex = target.indexOf("#");
	const fragment = hashIndex >= 0 ? target.slice(hashIndex + 1) : undefined;
	const beforeFragment = hashIndex >= 0 ? target.slice(0, hashIndex) : target;
	return { fragment, pathOnly: beforeFragment.split("?", 1)[0] };
}

function checkLinkTarget(rawTarget: string, source: string): void {
	const target = withoutAngleBrackets(rawTarget.trim());
	if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith("/")) {
		fail("link.absolute", `${source}: link '${target}' is absolute, not skill-relative`);
		return;
	}
	if (isExternalReference(target)) return;

	const { fragment, pathOnly } = linkTargetParts(target);
	const sourceFile = source === "SKILL.md body" ? join(skill.directory, "SKILL.md") : join(skill.directory, source);
	const resolved = pathOnly ? resolve(dirname(sourceFile), decodeLink(pathOnly)) : sourceFile;
	if (escapesDirectory(skill.directory, resolved)) {
		fail("link.escape", `${source}: link '${target}' escapes the skill directory`);
		return;
	}
	if (!existsSync(resolved)) {
		fail("link.missing", `${source}: linked path does not exist: ${target}`);
		return;
	}
	if (escapesDirectory(realpathSync(skill.directory), realpathSync(resolved))) {
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
			if (!definitions.has(id))
				fail("link.reference-missing", `${candidate.source}: reference link definition is missing: ${id}`);
		}
	}
}

function visitDirectory(current: string, depth: number, state: WalkState): boolean {
	const handle = opendirSync(current);
	try {
		for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
			if (!visitEntry(current, depth, entry, state)) return false;
		}
		return true;
	} finally {
		handle.closeSync();
	}
}

function visitEntry(current: string, depth: number, entry: Dirent, state: WalkState): boolean {
	if (++state.visited > MAX_TREE_ENTRIES) {
		fail("tree.limit", "directory entry budget exceeded; validation is incomplete");
		return false;
	}
	if (entry.name.startsWith(".") || entry.name === "node_modules") return true;
	const path = join(current, entry.name);
	if (!entry.isDirectory()) {
		if (entry.isFile()) state.results.push(path);
		return true;
	}
	if (depth >= MAX_TREE_DEPTH) {
		fail("tree.depth", "directory depth budget exceeded; validation is incomplete");
		return false;
	}
	return visitDirectory(path, depth + 1, state);
}

function walk(directory: string): string[] {
	const state: WalkState = { results: [], visited: 0 };
	visitDirectory(directory, 0, state);
	return state.results;
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

function checkDocumentedFile(file: string): void {
	const extension = extname(file).toLowerCase();
	if (!SCANNABLE_EXTENSIONS.has(extension)) return;
	const rel = relative(skill.directory, file);
	const size = statSync(file).size;
	if (size > MAX_FILE_BYTES) {
		warn("file.large", `${rel} is ${size} bytes; not scanned for placeholder/security markers`);
		return;
	}
	const text = readBoundedText(file).text;
	if (PLACEHOLDER_PATTERN.test(text)) warn("file.placeholder", `${rel} contains a task marker or replacement token`);
	if (ABSOLUTE_PATH_PATTERN.test(text)) warn("file.absolute-path", `${rel} contains an operator-local absolute path`);
	if (OPERATOR_HOME_PATTERN.test(text)) {
		warn("path.operator-home", `${rel} contains an operator-private home path form (tilde-slash)`);
	}
	if (likelySecret(text)) fail("file.secret", `${rel} contains a likely credential or private key`);
}

function checkScriptFile(file: string): void {
	if (statSync(file).size > MAX_FILE_BYTES) return;
	const rel = relative(skill.directory, file);
	const text = readBoundedText(file).text;
	if (!text.includes("--help") && !text.includes("usage"))
		warn("script.help", `${rel} does not visibly document --help or usage`);
}

function checkFiles(): void {
	for (const file of skill.files) checkDocumentedFile(file);
	for (const file of skill.scriptFiles) checkScriptFile(file);
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
		warn(
			"script.test-missing",
			`${relative(skill.directory, file)} has no colocated test file (expected ${stem}.test${extension} or test-${name})`,
		);
	}
}

function collectFiles(): void {
	skill.files = walk(skill.directory);
	skill.references = [];
	const referencesDir = join(skill.directory, "references");
	if (isDirectory(referencesDir)) {
		for (const file of skill.files.filter(
			(path) => path.startsWith(`${referencesDir}${sep}`) && path.toLowerCase().endsWith(".md"),
		)) {
			skill.references.push({ path: file, text: readBoundedText(file).text });
		}
	}
	const scriptsDir = join(skill.directory, "scripts");
	skill.scriptFiles = skill.files.filter((path) => path.startsWith(`${scriptsDir}${sep}`));
}

function loadSkillFrontmatter(directory: string): void {
	const skillPath = join(directory, "SKILL.md");
	if (!existsSync(skillPath)) {
		fail("skill.missing", `SKILL.md is required at ${skillPath}`);
		return;
	}
	const markdown = readBoundedText(skillPath).text;
	const parsed = extractFrontmatter(markdown);
	if (!parsed) {
		fail("frontmatter.missing", "SKILL.md must start with YAML frontmatter fenced by --- lines");
		return;
	}
	const frontmatter = parseSimpleYaml(parsed.yaml);
	if ("error" in frontmatter) {
		fail("frontmatter.parse", frontmatter.error);
		return;
	}
	skill.frontmatter = frontmatter.value;
	skill.body = parsed.body;
}

function runSkillChecks(): void {
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
}

function logReport(format: OutputFormat, directory: string): void {
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
	if (format === "json") {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	console.log(`${issueCount === 0 ? "PASS" : "FAIL"} ${directory}`);
	for (const issue of issues) console.log(`FAIL ${issue.code}: ${issue.message}`);
	if (omittedFail > 0) console.log(`FAIL report.truncated: ${omittedFail} additional FAIL findings omitted`);
	for (const warning of warnings) console.log(`WARN ${warning.code}: ${warning.message}`);
	if (omittedWarn > 0) console.log(`WARN report.truncated: ${omittedWarn} additional WARN findings omitted`);
	console.log(`Summary: ${issueCount} fail, ${warningCount} warn`);
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
	loadSkillFrontmatter(directory);
	runSkillChecks();
	logReport(options.format, directory);
	process.exit(issueCount === 0 ? 0 : 1);
}

main();
