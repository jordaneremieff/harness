/**
 * Declarative command-policy rules and the classifier that applies them.
 *
 * A rule is a code-level entry: an id, a class group, the tool it reads, and a
 * predicate over that tool's call. Rules add classes to a call; they never
 * change it. A call carries every class it matches, because collapsing matches
 * by priority hides the co-occurrence that analysis needs.
 *
 * The shell rules read command shape only. A shape cannot establish that a
 * purpose-built command exists for a given operation, so composition as such is
 * not classified: a loop, `xargs`, or a substitution is flagged only when a
 * rule identifies the specific work a bounded tool owns.
 */

import { parseStatements, type Stage, type Statement } from "./shell.ts";

/** Class groups, derived from the command-line rules the harness states. */
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

/** Stages that consume their whole input before emitting, so a later `head` cannot stop the producer. */
const BLOCKING_STAGES = new Set(["sort", "tail", "wc", "tac", "shuf", "sponge"]);

const GREP_COMMANDS = new Set(["grep", "egrep", "fgrep"]);
const INLINE_SCRIPT = new Map([
	["python", "-c"],
	["python3", "-c"],
	["perl", "-e"],
	["node", "-e"],
]);
const READ_MARKERS = [/\bopen\s*\(/, /\bread_text\b/, /\breadFile/, /\bjson\.load/, /\bPath\s*\(/];

function flags(stage: Stage): string[] {
	const letters: string[] = [];
	for (const arg of stage.args) {
		if (arg === "--") break;
		if (arg.startsWith("--")) letters.push(arg.slice(2));
		else if (arg.startsWith("-") && arg.length > 1) letters.push(...arg.slice(1).split(""));
	}
	return letters;
}

function hasFlag(stage: Stage, ...names: string[]): boolean {
	const present = flags(stage);
	return names.some((name) => present.includes(name));
}

/** Operands that are not flags and not flag values. */
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
		if (!literal && arg.startsWith("-") && arg.length > 1) {
			const bare = arg.replace(/^-+/, "");
			if (flagsWithValue.has(bare)) skipNext = true;
			continue;
		}
		result.push(arg);
	}
	return result;
}

/**
 * A downstream `head` stops a streaming producer through the pipe.
 * It stops nothing once a stage between them consumes the whole stream first,
 * and `tail` never stops a producer at all.
 */
function producerStoppedByHead(statement: Statement, index: number): boolean {
	for (let position = index + 1; position < statement.length; position++) {
		const command = statement[position].command;
		if (command === "head") return true;
		if (BLOCKING_STAGES.has(command)) return false;
	}
	return false;
}

/** A downstream cap exists but cannot reach the producer. */
function falseCap(statement: Statement, index: number): boolean {
	let blocked = false;
	for (let position = index + 1; position < statement.length; position++) {
		const command = statement[position].command;
		if (BLOCKING_STAGES.has(command)) {
			if (command === "tail") return true;
			blocked = true;
			continue;
		}
		if (command === "head") return blocked;
	}
	return false;
}

function isCatRead(stage: Stage): boolean {
	if (stage.command !== "cat") return false;
	if (stage.fromPipe || stage.fromRedirect) return false;
	return operands(stage).length > 0;
}

function isSedSlice(stage: Stage): boolean {
	if (stage.command !== "sed" || !hasFlag(stage, "n")) return false;
	const script = stage.args.find((arg) => /^\d+\s*,\s*\d+\s*p$/.test(arg) || /^\d+p$/.test(arg));
	return script !== undefined && operands(stage, new Set(["e", "f"])).length > 1;
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

export const RULES: Rule[] = [
	{
		id: "routing.cat-read",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => isCatRead(stage) && !stage.toPipe,
	},
	{
		id: "routing.cat-pipe",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => isCatRead(stage) && stage.toPipe,
	},
	{
		id: "routing.sed-slice",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => isSedSlice(stage),
	},
	{
		id: "routing.inline-script-read",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => isInlineScriptRead(stage),
	},
	{
		id: "routing.grep-pipe",
		group: "routing",
		tool: "bash",
		matches: ({ stage }) => GREP_COMMANDS.has(stage.command) && stage.fromPipe,
	},
	{
		id: "form.grep-file",
		group: "form",
		tool: "bash",
		matches: ({ stage }) =>
			GREP_COMMANDS.has(stage.command) &&
			!stage.fromPipe &&
			operands(stage, new Set(["e", "f", "m", "A", "B", "C"])).length > 1,
	},
	{
		id: "form.find-discovery",
		group: "form",
		tool: "bash",
		matches: ({ stage }) => stage.command === "find",
	},
	{
		id: "form.ls-recursive",
		group: "form",
		tool: "bash",
		matches: ({ stage }) => stage.command === "ls" && hasFlag(stage, "R", "recursive"),
	},
	{
		id: "form.env-grep",
		group: "form",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			stage.command === "env" &&
			operands(stage).length === 0 &&
			statement.slice(index + 1).some((later) => GREP_COMMANDS.has(later.command)),
	},
	{
		id: "bounds.find-unbounded",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			stage.command === "find" &&
			!stage.args.includes("-quit") &&
			!producerStoppedByHead(statement, index),
	},
	{
		id: "bounds.grep-recursive-uncapped",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			isRecursiveGrep(stage) && !producerStoppedByHead(statement, index),
	},
	{
		id: "bounds.false-cap",
		group: "bounds",
		tool: "bash",
		matches: ({ statement, stage, index }) =>
			(stage.command === "find" || isRecursiveGrep(stage)) && falseCap(statement, index),
	},
];

/** Tools whose input a rule reads. Only these tools have input recorded. */
export const INPUT_CAPTURE: Record<string, (input: Record<string, unknown>) => string | undefined> = {
	bash: (input) => (typeof input.command === "string" ? input.command : undefined),
};

/** Rule ids a call matches, sorted and deduplicated. Unmatched calls return an empty list. */
export function classify(tool: string, input: Record<string, unknown>): string[] {
	const capture = INPUT_CAPTURE[tool];
	const command = capture?.(input);
	if (command === undefined) return [];
	const rules = RULES.filter((rule) => rule.tool === tool);
	const matched = new Set<string>();
	for (const statement of parseStatements(command)) {
		for (let index = 0; index < statement.length; index++) {
			const context: RuleContext = { statement, stage: statement[index], index };
			for (const rule of rules) {
				if (rule.matches(context)) matched.add(rule.id);
			}
		}
	}
	return [...matched].sort();
}
