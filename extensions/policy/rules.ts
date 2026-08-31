/*
 * Declarative shell-policy rules and the classifier that applies them.
 *
 * Each code-level rule names a tool, class group, id, and predicate. Rules add
 * observations only. A call carries every matched id because co-occurrence is
 * evidence needed by later analysis.
 */

import { parseStatements, type Stage, type Statement } from "./shell.ts";

/** Class groups derived from the harness command-line rules. */
export type ClassGroup = "routing" | "form" | "bounds";

export interface RuleContext {
	statement: Statement;
	stage: Stage;
	index: number;
}

export interface Rule {
	id: string;
	group: ClassGroup;
	/** Tool whose calls this rule reads. */
	tool: "bash";
	matches(context: RuleContext): boolean;
}

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

export const RULES: Rule[] = [
	{ id: "routing.cat-read", group: "routing", tool: "bash", matches: ({ stage }) => isCatRead(stage) && !stage.toPipe },
	{ id: "routing.cat-pipe", group: "routing", tool: "bash", matches: ({ stage }) => isCatPipe(stage) },
	{ id: "routing.sed-slice", group: "routing", tool: "bash", matches: ({ stage }) => isSedSlice(stage) },
	{ id: "routing.head-slice", group: "routing", tool: "bash", matches: ({ stage }) => isFileSlice(stage, "head") },
	{ id: "routing.tail-slice", group: "routing", tool: "bash", matches: ({ stage }) => isFileSlice(stage, "tail") },
	{ id: "routing.inline-script-read", group: "routing", tool: "bash", matches: ({ stage }) => isInlineScriptRead(stage) },
	{
		id: "routing.grep-pipe",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => GREP_COMMANDS.has(stage.command) && stage.fromPipe && !hasFlag(stage, "q", "quiet", "silent"),
	},
	{ id: "form.grep-file", group: "form", tool: "bash", matches: ({ stage }) => isGrepFile(stage) },
	{ id: "form.find-discovery", group: "form", tool: "bash", matches: ({ stage }) => stage.command === "find" },
	{ id: "form.ls-recursive", group: "form", tool: "bash", matches: ({ stage }) => isRecursiveLs(stage) },
	{ id: "form.du-traversal", group: "form", tool: "bash", matches: ({ stage }) => isDu(stage) },
	{
		id: "form.env-grep",
		group: "form",
		tool: "bash",
		matches: ({ statement, stage, index }) => {
			const dumpsEnvironment =
				stage.command === "env"
					? !hasFlag(stage, "a", "argv0", "S", "split-string", "help", "version")
					: stage.command === "printenv" && operands(stage).length === 0;
			return dumpsEnvironment && statement.slice(index + 1).some((later) => TEXT_FILTERS.has(later.command));
		},
	},
	{
		id: "bounds.find-output-uncapped",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			stage.command === "find" && !stage.args.includes("-quit") && isUncapped(statement, index),
	},
	{
		id: "bounds.grep-recursive-uncapped",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) => isRecursiveGrep(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.ls-recursive-uncapped",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) => isRecursiveLs(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.du-uncapped",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) => isDu(stage) && isUncapped(statement, index),
	},
	{
		id: "bounds.false-cap",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			(stage.command === "find" || isRecursiveGrep(stage) || isRecursiveLs(stage) || isDu(stage)) &&
			falseCap(statement, index),
	},
];

/** Tools whose input a rule reads. Only these tools have input recorded. */
export const INPUT_CAPTURE: Record<string, (input: Record<string, unknown>) => string | undefined> = {
	bash: (input) => (typeof input.command === "string" ? input.command : undefined),
};

/** Rule ids a call matches, sorted and deduplicated. */
export function classify(tool: string, input: Record<string, unknown>): string[] {
	const capture = INPUT_CAPTURE[tool];
	const command = capture?.(input);
	if (command === undefined) return [];
	const rules = RULES.filter((rule) => rule.tool === tool);
	const matched = new Set<string>();
	for (const statement of parseStatements(command)) {
		for (let index = 0; index < statement.length; index++) {
			const context: RuleContext = { statement, stage: statement[index], index };
			for (const rule of rules) if (rule.matches(context)) matched.add(rule.id);
		}
	}
	return [...matched].sort();
}
