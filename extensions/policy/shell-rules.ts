/*
 * The shell policy domain: declarative rules over `bash` command text.
 *
 * Each rule names a class group, an id, a predicate over one pipeline stage,
 * and one line of guidance. Rules add observations only. A call carries every
 * matched id because co-occurrence is evidence needed by later analysis.
 */

import { packageRowRevision, POLICY_DOMAIN, type PackageDefinitionRow, type RuleEffect } from "./rule.ts";
import { redactCommand } from "./redact.ts";
import type { Stage, Statement } from "./shell.ts";

export interface RuleContext {
	statement: Statement;
	stage: Stage;
	index: number;
}

export type CodeMatcher = (context: RuleContext) => boolean;

interface PredicateRule {
	id: string;
	note: string;
	matches: CodeMatcher;
}

export interface ShellRule extends PredicateRule {
	domain: typeof POLICY_DOMAIN;
	key: string;
	effect: RuleEffect;
}

const READ_TOOL_NOTE = "Use the read tool for file contents, one call per file: read path=README.md.";
const READ_SLICE_NOTE =
	"Use the read tool for a file slice, one call per file: read path=src/index.ts offset=40 limit=20.";
const OUTPUT_BOUND_NOTE = "Bound the output with a cap that stops the producer: | head -n 50.";
const FD_BOUND_NOTE = "Bound fd with its own result cap: fd --max-results 50, or | head -n 50.";
const RG_FILES_BOUND_NOTE = "Bound rg --files with | head -n 50; --max-count does not bound a file listing.";
const SEARCH_SCOPE_NOTE = "Scope the search to a path, or cap the results: rg -n pattern src/, or rg -m 20 -n pattern.";

const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep"]);
const TEXT_FILTERS = new Set([...GREP_COMMANDS, "rg", "ripgrep", "ag", "ack"]);
const INLINE_SCRIPT = new Map([
	["python", "-c"],
	["python3", "-c"],
	["perl", "-e"],
	["node", "-e"],
]);
const READ_MARKERS = [/\bopen\s*\(/, /\bread_text\b/, /\breadFile/, /\bjson\.load/, /\bPath\s*\(/];
/*
 * Script shapes that compute rather than read: a loop, a definition, a context
 * manager, an error handler, or an imported module. A `require` call is not one
 * of these, because a bare file read in Node needs it.
 */
const SCRIPT_PROCESSING = /(^|[\s;:({[])(for|while|def|class|try|with|import)\b/;
const MAX_READ_SCRIPT_BYTES = 200;
const MAX_READ_SCRIPT_LINES = 2;
const AWK_COMMANDS = new Set(["awk", "gawk", "mawk", "nawk"]);
const HELP_FLAGS = ["help", "version", "V"];
const WHOLE_INPUT_STAGES = new Set(["sort", "wc", "tac", "shuf", "sponge", "column", "datamash"]);

function commandName(stage: Stage): string {
	const command = stage.command;
	if (/^g(?:sort|head|tail|wc|tac|shuf)$/.test(command)) return command.slice(1);
	return command;
}

export function flags(stage: Stage): string[] {
	const present: string[] = [];
	for (const arg of stage.args) {
		if (arg === "--") break;
		if (arg.startsWith("--")) {
			present.push(arg.slice(2).split("=", 1)[0]);
		} else if (arg.startsWith("-") && arg.length > 1) {
			present.push(...arg.slice(1).split(""));
		}
	}
	return present;
}

function hasFlag(stage: Stage, ...names: string[]): boolean {
	const present = flags(stage);
	return names.some((name) => present.includes(name));
}

/** Operands that are neither flags nor values consumed by named flags. */
export function operands(stage: Stage, flagsWithValue: Set<string> = new Set()): string[] {
	const result: string[] = [];
	let skipNext = false;
	let literal = false;
	for (const arg of stage.args) {
		if (skipNext) {
			skipNext = false;
			continue;
		}
		if (!literal && arg === "--") {
			literal = true;
			continue;
		}
		if (!literal && arg.startsWith("--")) {
			const [name, attached] = arg.slice(2).split("=", 2);
			if (flagsWithValue.has(name) && attached === undefined) skipNext = true;
			continue;
		}
		if (!literal && arg.startsWith("-") && arg.length > 1) {
			const letters = arg.slice(1);
			for (let index = 0; index < letters.length; index++) {
				if (!flagsWithValue.has(letters[index])) continue;
				if (index === letters.length - 1) skipNext = true;
				break;
			}
			continue;
		}
		result.push(arg);
	}
	return result;
}

function optionValue(stage: Stage, short: string, long: string): string | undefined {
	for (let index = 0; index < stage.args.length; index++) {
		const arg = stage.args[index];
		if (arg === `-${short}` || arg === `--${long}`) return stage.args[index + 1];
		if (arg.startsWith(`-${short}`) && arg.length > 2) return arg.slice(2);
		if (arg.startsWith(`--${long}=`)) return arg.slice(long.length + 3);
	}
	return undefined;
}

function isStoppingHead(stage: Stage): boolean {
	if (commandName(stage) !== "head") return false;
	const value = optionValue(stage, "n", "lines") ?? optionValue(stage, "c", "bytes");
	return value === undefined || !/^[+-]/.test(value);
}

/**
 * An awk stage that leaves its script early. It stops an upstream producer the
 * way a streaming `head` does; an awk range test without `exit` reads all input.
 */
function isStoppingAwk(stage: Stage): boolean {
	return AWK_COMMANDS.has(commandName(stage)) && stage.args.some((arg) => /(^|[\s;{])exit\b/.test(arg));
}

/** A command asked for its own usage or version, so it does not read the tree. */
function isHelpInvocation(stage: Stage): boolean {
	return hasFlag(stage, ...HELP_FLAGS);
}

function isStreamingTail(stage: Stage): boolean {
	if (commandName(stage) !== "tail") return false;
	const value = optionValue(stage, "n", "lines") ?? optionValue(stage, "c", "bytes");
	return value?.startsWith("+") === true || stage.args.some((arg) => /^\+\d+$/.test(arg));
}

function xargsChild(stage: Stage): string | undefined {
	if (stage.command !== "xargs") return undefined;
	const values = new Set([
		"a",
		"arg-file",
		"d",
		"delimiter",
		"E",
		"eof",
		"I",
		"replace",
		"L",
		"max-lines",
		"n",
		"max-args",
		"P",
		"max-procs",
		"s",
		"max-chars",
	]);
	return operands(stage, values)[0];
}

/** A stage that can consume all upstream output before a later cap runs. */
function isWholeInputStage(stage: Stage): boolean {
	const command = commandName(stage);
	if (WHOLE_INPUT_STAGES.has(command)) return true;
	if (command === "tail") return !isStreamingTail(stage);
	if (GREP_COMMANDS.has(command) && hasFlag(stage, "c", "count")) return true;
	if (command === "jq" && hasFlag(stage, "s", "slurp")) return true;
	const child = xargsChild(stage);
	if (child === undefined) return false;
	const normalizedChild = child.replace(/^g(?=sort|head|tail|wc|tac|shuf$)/, "");
	return WHOLE_INPUT_STAGES.has(normalizedChild) || normalizedChild === "tail";
}

/** A downstream stage that stops the producer, unless a full-input stage intervenes. */
function producerStopped(statement: Statement, index: number): boolean {
	for (let position = index + 1; position < statement.length; position++) {
		const stage = statement[position];
		if (commandName(stage) === "head") return isStoppingHead(stage);
		if (isStoppingAwk(stage)) return true;
		if (isWholeInputStage(stage)) return false;
	}
	return false;
}

/** A cap-shaped downstream command cannot stop the producer. */
function falseCap(statement: Statement, index: number): boolean {
	let blocked = false;
	for (let position = index + 1; position < statement.length; position++) {
		const stage = statement[position];
		const command = commandName(stage);
		if (command === "tail" && !isStreamingTail(stage)) return true;
		if (command === "head") return !isStoppingHead(stage) || blocked;
		if (isStoppingAwk(stage)) return blocked;
		if (isWholeInputStage(stage)) blocked = true;
	}
	return false;
}

function isCatRead(stage: Stage): boolean {
	if (stage.command !== "cat" || stage.fromPipe || stage.fromRedirect || stage.toRedirect) return false;
	return operands(stage).length === 1;
}

function isCatPipe(stage: Stage): boolean {
	if (stage.command !== "cat" || stage.fromPipe || stage.fromRedirect || !stage.toPipe) return false;
	return operands(stage).length > 0;
}

function isSedSlice(stage: Stage): boolean {
	if (stage.command !== "sed" || !hasFlag(stage, "n") || stage.fromPipe || stage.fromRedirect || stage.toRedirect)
		return false;
	const script = stage.args.find((arg) => /^\d+\s*,\s*\d+\s*p$/.test(arg) || /^\d+p$/.test(arg));
	return script !== undefined && operands(stage, new Set(["e", "f", "expression", "file"])).length > 1;
}

function isFileSlice(stage: Stage, command: "head" | "tail"): boolean {
	if (commandName(stage) !== command || stage.fromPipe || stage.fromRedirect || stage.toRedirect) return false;
	return operands(stage, new Set(["n", "c", "lines", "bytes"])).length > 0;
}

/**
 * A tail file slice that starts at an offset line: the shape the read tool
 * covers. A from-end slice (last N lines or bytes) is a slice the read tool
 * cannot give, so the harness command-line rules permit it.
 */
function isTailSliceFromStart(stage: Stage): boolean {
	if (commandName(stage) !== "tail") return false;
	const lines = optionValue(stage, "n", "lines");
	if (lines?.startsWith("+") === true) return true;
	return stage.args.some((arg) => /^\+\d+$/.test(arg));
}

/**
 * A head file slice the read tool covers: a positive line count. Byte slices
 * and all-but-last counts are slices the read tool cannot give, so the harness
 * command-line rules permit them.
 */
function isHeadSliceReadable(stage: Stage): boolean {
	if (hasFlag(stage, "c", "bytes")) return false;
	const lines = optionValue(stage, "n", "lines");
	return !(lines?.startsWith("-") === true);
}

/**
 * An inline script that only reads a file: the work the read tool performs. A
 * longer, multi-line, or computing script does work the read tool cannot do, so
 * the command-line rules permit it.
 */
function isInlineScriptRead(stage: Stage): boolean {
	const flag = INLINE_SCRIPT.get(stage.command);
	if (!flag) return false;
	const position = stage.args.indexOf(flag);
	if (position === -1) return false;
	const script = (stage.args[position + 1] ?? "").trim();
	if (!READ_MARKERS.some((marker) => marker.test(script))) return false;
	if (Buffer.byteLength(script, "utf8") > MAX_READ_SCRIPT_BYTES) return false;
	if (script.split("\n").length > MAX_READ_SCRIPT_LINES) return false;
	return !SCRIPT_PROCESSING.test(script);
}

function isRecursiveGrep(stage: Stage): boolean {
	return GREP_COMMANDS.has(stage.command) && hasFlag(stage, "r", "R", "recursive", "dereference-recursive");
}

function isRecursiveLs(stage: Stage): boolean {
	return stage.command === "ls" && hasFlag(stage, "R", "recursive");
}

function isDu(stage: Stage): boolean {
	return stage.command === "du" || stage.command === "gdu";
}

/** `rg --files` or `fd`: a discovery traversal of the tree, like `find`. */
function isDiscoveryTraversal(stage: Stage): boolean {
	return (stage.command === "rg" && hasFlag(stage, "files")) || stage.command === "fd";
}

/** `git grep`: a recursive search over the worktree by default. */
function isGitGrep(stage: Stage): boolean {
	return stage.command === "git" && operands(stage)[0] === "grep";
}

/** `rg` in search mode or `git grep`: a recursive text search. */
function isRecursiveSearch(stage: Stage): boolean {
	if (stage.command === "rg") {
		// With a pipe or redirect, rg reads standard input and does not
		// traverse the tree, so it is a filter, not a producer.
		return !hasFlag(stage, "files") && !stage.fromPipe && !stage.fromRedirect;
	}
	return isGitGrep(stage);
}

/**
 * A path operand that scopes a search: a named path, not the current or
 * parent directory, and not a glob.
 */
function isScopingPath(path: string): boolean {
	const trimmed = path.replace(/\/+$/, "");
	return trimmed !== "" && trimmed !== "." && trimmed !== ".." && !/[*?[]/.test(trimmed);
}

/** A search operand after the pattern that names a scope. */
function hasScopingPath(stage: Stage): boolean {
	const patternSlots = stage.command === "rg" ? 1 : 2;
	return operands(stage).slice(patternSlots).some(isScopingPath);
}

/** A flag that caps the producer's own result count. */
function hasResultCap(stage: Stage): boolean {
	return hasFlag(stage, "m", "max-count");
}

/**
 * A discovery traversal that stops itself at a result count. `fd` quits at
 * `--max-results` (`-1` is its one-result alias), so the traversal bounds its
 * own output. `rg --files` has no such flag: `--max-count` bounds matches per
 * file and a file listing matches nothing.
 */
function hasTraversalResultCap(stage: Stage): boolean {
	return stage.command === "fd" && hasFlag(stage, "max-results", "1");
}

/**
 * A filter pattern that names one variable: a bare identifier or a fully
 * anchored identifier. An open-ended pattern (prefix, alternation, or
 * inversion) selects several variables, so naming one variable cannot serve
 * that intent.
 */
function isSingleVariablePattern(pattern: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(pattern) || /^\^[A-Za-z_][A-Za-z0-9_]*\$$/.test(pattern);
}

function isGrepFile(stage: Stage): boolean {
	if (!GREP_COMMANDS.has(stage.command) || stage.fromPipe) return false;
	const values = new Set([
		"e",
		"regexp",
		"f",
		"file",
		"m",
		"max-count",
		"A",
		"after-context",
		"B",
		"before-context",
		"C",
		"context",
	]);
	const files = operands(stage, values);
	return hasFlag(stage, "e", "regexp", "f", "file") ? files.length > 0 : files.length > 1;
}

function isUncapped(statement: Statement, index: number): boolean {
	return !producerStopped(statement, index);
}

const PREDICATE_RULES: PredicateRule[] = [
	{
		id: "routing.cat-read",
		note: READ_TOOL_NOTE,
		matches: ({ stage }) => isCatRead(stage) && !stage.toPipe,
	},
	{
		id: "routing.cat-pipe",
		note: "Give the file to the next command directly: jq . data.json.",
		matches: ({ stage }) => isCatPipe(stage),
	},
	{ id: "routing.sed-slice", note: READ_SLICE_NOTE, matches: ({ stage }) => isSedSlice(stage) },
	{
		id: "routing.head-slice",
		note: READ_SLICE_NOTE,
		matches: ({ stage }) => isFileSlice(stage, "head") && isHeadSliceReadable(stage),
	},
	{
		id: "routing.tail-slice",
		note: READ_SLICE_NOTE,
		matches: ({ stage }) => isFileSlice(stage, "tail") && isTailSliceFromStart(stage),
	},
	{
		id: "routing.inline-script-read",
		note: READ_TOOL_NOTE,
		matches: ({ stage }) => isInlineScriptRead(stage),
	},
	{
		id: "routing.grep-pipe",
		note: "Filter with rg, or narrow the producing command: git config -l | rg hook.",
		matches: ({ stage }) =>
			GREP_COMMANDS.has(stage.command) && stage.fromPipe && !hasFlag(stage, "q", "quiet", "silent"),
	},
	{
		id: "form.grep-file",
		note: "Use rg for text search, or git grep for tracked text: rg -n pattern src/.",
		matches: ({ stage }) => isGrepFile(stage),
	},
	{
		id: "form.find-discovery",
		note: "Use rg --files, fd, or git ls-files for discovery: fd --max-results 50 -e ts src/.",
		matches: ({ stage }) => stage.command === "find",
	},
	{
		id: "form.ls-recursive",
		note: "Use rg --files or fd for a recursive listing: fd --max-results 50 . src/.",
		matches: ({ stage }) => isRecursiveLs(stage),
	},
	{
		id: "form.du-traversal",
		note: "Scope the traversal to the smallest root that holds the target: du -sh dist.",
		matches: ({ stage }) => isDu(stage),
	},
	{
		id: "form.env-grep",
		note: "Use printenv NAME for one environment variable: printenv PATH.",
		matches: ({ statement, stage, index }) => {
			const later = statement.slice(index + 1);
			if (stage.command === "env" && !hasFlag(stage, "a", "argv0", "S", "split-string", "help", "version")) {
				return later.some((candidate) => TEXT_FILTERS.has(candidate.command));
			}
			if (stage.command !== "printenv" || operands(stage).length !== 0) return false;
			const filter = later.find((candidate) => TEXT_FILTERS.has(candidate.command));
			if (filter === undefined || hasFlag(filter, "v", "invert-match")) return false;
			const pattern = operands(filter)[0];
			return pattern !== undefined && isSingleVariablePattern(pattern);
		},
	},
	{
		id: "bounds.find-output-uncapped",
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) =>
			stage.command === "find" && !stage.args.includes("-quit") && isUncapped(statement, index),
	},
	{
		id: "bounds.grep-recursive-uncapped",
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) => isRecursiveGrep(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.ls-recursive-uncapped",
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) => isRecursiveLs(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.du-uncapped",
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) => isDu(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.rg-files-uncapped",
		note: RG_FILES_BOUND_NOTE,
		matches: ({ statement, stage, index }) =>
			stage.command === "rg" && hasFlag(stage, "files") && isUncapped(statement, index),
	},
	{
		id: "bounds.fd-uncapped",
		note: FD_BOUND_NOTE,
		matches: ({ statement, stage, index }) =>
			stage.command === "fd" && !hasTraversalResultCap(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.rg-search-uncapped",
		note: SEARCH_SCOPE_NOTE,
		matches: ({ statement, stage, index }) =>
			stage.command === "rg" &&
			isRecursiveSearch(stage) &&
			!hasScopingPath(stage) &&
			!hasResultCap(stage) &&
			isUncapped(statement, index),
	},
	{
		id: "bounds.git-grep-uncapped",
		note: SEARCH_SCOPE_NOTE,
		matches: ({ statement, stage, index }) =>
			isGitGrep(stage) && !hasScopingPath(stage) && !hasResultCap(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.false-cap",
		note: "This cap does not stop its producer. Bound the producer itself: head -n 50 before sort.",
		matches: ({ statement, stage, index }) =>
			(stage.command === "find" ||
				isRecursiveGrep(stage) ||
				isRecursiveLs(stage) ||
				isDu(stage) ||
				(isDiscoveryTraversal(stage) && !hasTraversalResultCap(stage)) ||
				(isRecursiveSearch(stage) && !hasScopingPath(stage) && !hasResultCap(stage))) &&
			falseCap(statement, index),
	},
];

export const RULES: ShellRule[] = PREDICATE_RULES.map((rule) => ({
	...rule,
	domain: POLICY_DOMAIN,
	key: rule.id,
	effect: "block",
}));

export const PACKAGE_CATALOG: PackageDefinitionRow[] = RULES.map((rule) => {
	const row = {
		id: rule.id,
		domain: rule.domain,
		matcher: { kind: "code" as const, key: rule.key },
		effect: rule.effect,
		note: rule.note,
	};
	return { ...row, revision: packageRowRevision(row) };
});

const CODE_MATCHERS = new Map(RULES.map((rule) => [`${rule.domain}\0${rule.key}`, rule.matches]));

/** Resolve only predicates shipped by this installed package. */
export function resolveCodeMatcher(domain: string, key: string): CodeMatcher | undefined {
	return CODE_MATCHERS.get(`${domain}\0${key}`);
}

export function hasCodeMatcher(domain: string, key: string): boolean {
	return CODE_MATCHERS.has(`${domain}\0${key}`);
}

/** Code rules keep the established exemption for usage and version stages. */
export function codeMatcherStageEligible(stage: Stage): boolean {
	return !isHelpInvocation(stage);
}

/** Capture shell text once; no other tool currently has a policy capture. */
export function captureShell(tool: string, input: Record<string, unknown>): string | undefined {
	if (tool !== "bash") return undefined;
	const command = input.command;
	return typeof command === "string" ? command : undefined;
}

export function redactShell(tool: string, captured: string): string {
	return tool === "bash" ? redactCommand(captured) : captured;
}
