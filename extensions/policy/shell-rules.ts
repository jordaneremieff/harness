/*
 * The shell policy domain: declarative rules over `bash` command text.
 *
 * Each rule names a class group, an id, a predicate over one pipeline stage,
 * and one line of guidance. Rules add observations only. A call carries every
 * matched id because co-occurrence is evidence needed by later analysis.
 */

import type { Domain, Rule } from "./rule.ts";
import { redactCommand } from "./redact.ts";
import { parseStatements, type Stage, type Statement } from "./shell.ts";

export interface RuleContext {
	statement: Statement;
	stage: Stage;
	index: number;
}

export interface ShellRule extends Rule<RuleContext> {}

const READ_TOOL_NOTE = "Use the read tool for file contents.";
const READ_SLICE_NOTE = "Use the read tool with offset and limit for a file slice.";
const OUTPUT_BOUND_NOTE = "Bound the output with a cap that stops the producer.";

const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep"]);
const TEXT_FILTERS = new Set([...GREP_COMMANDS, "rg", "ripgrep", "ag", "ack"]);
const INLINE_SCRIPT = new Map([
	["python", "-c"],
	["python3", "-c"],
	["perl", "-e"],
	["node", "-e"],
]);
const READ_MARKERS = [/\bopen\s*\(/, /\bread_text\b/, /\breadFile/, /\bjson\.load/, /\bPath\s*\(/];
const WHOLE_INPUT_STAGES = new Set(["sort", "wc", "tac", "shuf", "sponge", "column", "datamash"]);

function commandName(stage: Stage): string {
	const command = stage.command;
	if (/^g(?:sort|head|tail|wc|tac|shuf)$/.test(command)) return command.slice(1);
	return command;
}

function flags(stage: Stage): string[] {
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
function operands(stage: Stage, flagsWithValue: Set<string> = new Set()): string[] {
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

function isStreamingTail(stage: Stage): boolean {
	if (commandName(stage) !== "tail") return false;
	const value = optionValue(stage, "n", "lines") ?? optionValue(stage, "c", "bytes");
	return value?.startsWith("+") === true || stage.args.some((arg) => /^\+\d+$/.test(arg));
}

function xargsChild(stage: Stage): string | undefined {
	if (stage.command !== "xargs") return undefined;
	const values = new Set(["a", "arg-file", "d", "delimiter", "E", "eof", "I", "replace", "L", "max-lines", "n", "max-args", "P", "max-procs", "s", "max-chars"]);
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

/** A downstream streaming head stops the producer unless a full-input stage intervenes. */
function producerStoppedByHead(statement: Statement, index: number): boolean {
	for (let position = index + 1; position < statement.length; position++) {
		const stage = statement[position];
		if (commandName(stage) === "head") return isStoppingHead(stage);
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
	if (stage.command !== "sed" || !hasFlag(stage, "n") || stage.fromPipe || stage.fromRedirect || stage.toRedirect) return false;
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

function isInlineScriptRead(stage: Stage): boolean {
	const flag = INLINE_SCRIPT.get(stage.command);
	if (!flag) return false;
	const position = stage.args.indexOf(flag);
	if (position === -1) return false;
	const script = stage.args[position + 1] ?? "";
	return READ_MARKERS.some((marker) => marker.test(script));
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
		"e", "regexp", "f", "file", "m", "max-count", "A", "after-context", "B", "before-context", "C", "context",
	]);
	const files = operands(stage, values);
	return hasFlag(stage, "e", "regexp", "f", "file") ? files.length > 0 : files.length > 1;
}

function isUncapped(statement: Statement, index: number): boolean {
	return !producerStoppedByHead(statement, index);
}

export const RULES: ShellRule[] = [
	{
		id: "routing.cat-read",
		note: READ_TOOL_NOTE,
		matches: ({ stage }) => isCatRead(stage) && !stage.toPipe,
	},
	{
		id: "routing.cat-pipe",
		note: "Give the file to the next command directly instead of a cat pipe.",
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
		note: "Filter with rg, or narrow the command that produces the output.",
		matches: ({ stage }) => GREP_COMMANDS.has(stage.command) && stage.fromPipe && !hasFlag(stage, "q", "quiet", "silent"),
	},
	{
		id: "form.grep-file",
		note: "Use rg for text search, or git grep for tracked text.",
		matches: ({ stage }) => isGrepFile(stage),
	},
	{
		id: "form.find-discovery",
		note: "Use rg --files or fd for discovery, and git ls-files for tracked files.",
		matches: ({ stage }) => stage.command === "find",
	},
	{
		id: "form.ls-recursive",
		note: "Use rg --files or fd for a recursive listing.",
		matches: ({ stage }) => isRecursiveLs(stage),
	},
	{
		id: "form.du-traversal",
		note: "Scope the traversal to the smallest root that holds the target.",
		matches: ({ stage }) => isDu(stage),
	},
	{
		id: "form.env-grep",
		note: "Use printenv NAME for one environment variable.",
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
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) =>
			stage.command === "rg" && hasFlag(stage, "files") && isUncapped(statement, index),
	},
	{
		id: "bounds.fd-uncapped",
		note: OUTPUT_BOUND_NOTE,
		matches: ({ statement, stage, index }) => stage.command === "fd" && isUncapped(statement, index),
	},
	{
		id: "bounds.rg-search-uncapped",
		note: "Scope the search to a path, or cap the results.",
		matches: ({ statement, stage, index }) =>
			stage.command === "rg" &&
			isRecursiveSearch(stage) &&
			!hasScopingPath(stage) &&
			!hasResultCap(stage) &&
			isUncapped(statement, index),
	},
	{
		id: "bounds.git-grep-uncapped",
		note: "Scope the search to a path, or cap the results.",
		matches: ({ statement, stage, index }) =>
			isGitGrep(stage) && !hasScopingPath(stage) && !hasResultCap(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.false-cap",
		note: "This cap does not stop its producer. Bound the producer itself.",
		matches: ({ statement, stage, index }) =>
			(stage.command === "find" ||
				isRecursiveGrep(stage) ||
				isRecursiveLs(stage) ||
				isDu(stage) ||
				isDiscoveryTraversal(stage) ||
				(isRecursiveSearch(stage) && !hasScopingPath(stage) && !hasResultCap(stage))) &&
			falseCap(statement, index),
	},
];

const NOTES = new Map(RULES.map((rule) => [rule.id, rule.note]));

/** The shell domain: `bash` command text, its rules, and their guidance. */
export const shellDomain: Domain = {
	tool: "bash",
	capture: (input) => {
		// One read, so an accessor-backed input cannot yield two different
		// commands to the classifier and the recorded text.
		const command = input.command;
		return typeof command === "string" ? command : undefined;
	},
	redact: redactCommand,
	classify(command) {
		const matched = new Set<string>();
		for (const statement of parseStatements(command)) {
			for (let index = 0; index < statement.length; index++) {
				const context: RuleContext = { statement, stage: statement[index], index };
				for (const rule of RULES) if (rule.matches(context)) matched.add(rule.id);
			}
		}
		return [...matched].sort();
	},
	note: (ruleId) => NOTES.get(ruleId),
};
