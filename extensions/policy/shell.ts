/*
 * Small shell-shape reader for command classification.
 *
 * It recognizes top-level statements, pipelines, quoting, redirects, heredocs,
 * and nested command or process substitutions. It does not expand shell data.
 * Substitutions stay opaque in their parent stage and their command bodies are
 * classified as separate statements.
 */

/** One pipeline stage: a command word, its operands, and its stream context. */
export interface Stage {
	/** Command word with any directory prefix removed. Empty for an empty stage. */
	command: string;
	/** Operands and flags after the command word. */
	args: string[];
	/** Certainty belongs to shell words, not their rendered strings. */
	commandLiteral?: boolean;
	argLiterals?: boolean[];
	/** Fixed reason codes only; no command contents. */
	shellReasons?: string[];
	/** A pipe feeds this stage's standard input. */
	fromPipe: boolean;
	/** This stage's standard output feeds a pipe. */
	toPipe: boolean;
	/** A redirect, heredoc, or here-string feeds standard input. */
	fromRedirect: boolean;
	/** A file or file-descriptor redirect receives standard output. */
	toRedirect: boolean;
}

/** One statement: pipeline stages separated by `|`. */
export type Statement = Stage[];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const MAX_NESTED_DEPTH = 8;
const SHELL_PREFIXES = new Set(["!", "if", "then", "elif", "else", "do", "while", "until"]);
const SIMPLE_PREFIXES = new Set(["builtin", "nohup"]);

function isBlank(char: string): boolean {
	return char === " " || char === "\t";
}

function basename(word: string): string {
	return word.replace(/^.*\//, "");
}

/** Scan a single-quoted span from the opening quote; returns the index after the close. */
function skipSingleQuoted(text: string, index: number): number {
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "'") return index + 1;
		index++;
	}
	return text.length;
}

/** Scan a double-quoted span from the opening quote, nesting command substitutions. */
function skipDoubleQuoted(text: string, index: number, nesting: number): number {
	while (index < text.length) {
		const char = text[index];
		if (char === '"') return index + 1;
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "$" && text[index + 1] === "(") {
			index = skipBalanced(text, index + 1, "(", ")", nesting + 1);
			continue;
		}
		index++;
	}
	return text.length;
}

/** Advance past a backtick span in a balanced scan. */
function skipBacktickSpan(text: string, index: number): number {
	const end = text.indexOf("`", index + 1);
	return end === -1 ? text.length : end + 1;
}

interface BalancedStep {
	next: number;
	quote: "single" | "double" | null;
	depth: number;
	/** Set when the balanced body closed at this index; the value is the index after the close. */
	done?: number;
}

function balancedStep(
	text: string,
	index: number,
	quote: "single" | "double" | null,
	open: string,
	close: string,
	nesting: number,
): BalancedStep {
	const char = text[index];
	const advance: BalancedStep = { next: index + 1, quote, depth: 0 };
	if (char === "\\") return { ...advance, next: index + 2 };
	if (quote === "single") return { ...advance, quote: null, next: skipSingleQuoted(text, index) };
	if (quote === "double") return { ...advance, quote: null, next: skipDoubleQuoted(text, index, nesting) };
	if (char === "'") return { ...advance, quote: "single" };
	if (char === '"') return { ...advance, quote: "double" };
	if (char === "`") return { ...advance, next: skipBacktickSpan(text, index) };
	if (char === "$" && text[index + 1] === "{") return { ...advance, next: skipBalanced(text, index + 1, "{", "}", nesting + 1) };
	if (char === open) return { ...advance, depth: 1 };
	if (char === close) return { ...advance, depth: -1, done: index + 1 };
	return advance;
}

/** Consume a balanced shell body and return the index after its close. */
function skipBalanced(text: string, start: number, open: string, close: string, nesting = 0): number {
	if (nesting > MAX_NESTED_DEPTH) return text.length;
	let depth = 0;
	let quote: "single" | "double" | null = null;
	let index = start;
	while (index < text.length) {
		const step = balancedStep(text, index, quote, open, close, nesting);
		index = step.next;
		quote = step.quote;
		depth += step.depth;
		if (step.done !== undefined && depth === 0) return step.done;
	}
	return text.length;
}

/** Index after the closing single quote, or the scan end for an unterminated quote. */
function afterSingleQuote(text: string, index: number, end: number): number {
	const close = text.indexOf("'", index + 1);
	return close === -1 ? end : close + 1;
}

/** Advance past a dollar expansion inside a nested-command scan; records nested bodies. */
function collectDollar(text: string, index: number, nestedCommands: string[], depth: number): number {
	if (text[index + 1] === "{") {
		return skipBalanced(text, index + 1, "{", "}");
	}
	if (text.slice(index, index + 3) === "$((") {
		const close = skipBalanced(text, index + 1, "(", ")");
		collectNestedCommands(text, index + 3, Math.max(index + 3, close - 2), nestedCommands, depth + 1);
		return close;
	}
	if (text[index + 1] === "(") {
		const close = skipBalanced(text, index + 1, "(", ")");
		nestedCommands.push(text.slice(index + 2, Math.max(index + 2, close - 1)));
		return close;
	}
	return index + 1;
}

/** Advance past a backtick body inside a nested-command scan; records the nested body. */
function collectBacktick(text: string, index: number, end: number, nestedCommands: string[]): number {
	const close = text.indexOf("`", index + 1);
	nestedCommands.push(text.slice(index + 1, close === -1 ? end : close));
	return close === -1 ? end : close + 1;
}

/** Find real command substitutions inside an otherwise opaque shell body. */
function collectNestedCommands(text: string, start: number, end: number, nestedCommands: string[], depth = 0): void {
	if (depth > MAX_NESTED_DEPTH) return;
	let index = start;
	while (index < end) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "'") {
			index = afterSingleQuote(text, index, end);
			continue;
		}
		if (char === "$") {
			index = collectDollar(text, index, nestedCommands, depth);
			continue;
		}
		if (char === "`") {
			index = collectBacktick(text, index, end, nestedCommands);
			continue;
		}
		index++;
	}
}

interface Word {
	text: string;
	literal: boolean;
	/** Only unquoted, unescaped literal words are reserved-word candidates. */
	keyword: boolean;
	/** The word carries a redirect operator rather than an operand. */
	redirect?: "in" | "out";
	/** The word opened a heredoc; its text is the delimiter. */
	heredoc?: boolean;
	/** Explicit or default descriptor affected by a redirect. */
	fd?: number;
}

interface ParseFrame {
	/** Last physical shift token, shared by non-advancing arithmetic checks. */
	lastShift: number;
	groups: string[];
	loop?: { phase: "do" | "body"; body: boolean };
}

interface ParseBudget {
	/** Supplemental commands consume only budgets left by the original tree. */
	actions: { command: string; depth: number }[];
	/** Reason-only scans of opaque command bodies retain continuation evidence. */
	continuedDollar?: boolean;
	inspectionDepth?: number;
	bytes: number;
	words: number;
	stages: number;
	reasons: Set<string>;
}

export interface ShellEvidence {
	statements: Statement[];
	wordCount: number;
	complete: boolean;
	reasons: string[];
}

interface Split {
	words: Word[];
	/** Separator that ended this run of words. */
	end: "pipe" | "statement" | "eof";
	/** Control operators and group boundaries are outside the plain-loop grammar. */
	control?: boolean;
	separator?: "newline" | "semicolon";
}

function escapedRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface Heredoc {
	delimiter: string;
	stripTabs: boolean;
}

interface ReaderState {
	text: string;
	index: number;
	current: string;
	literal: boolean;
	quoted: boolean;
	/** Quotes on a descriptor do not establish a quoted delimiter. */
	heredocQuoted: boolean;
	escaped: boolean;
	started: boolean;
	pendingRedirect: "in" | "out" | null;
	pendingHeredoc: "<<" | "<<-" | null;
	pendingFd: number | null;
	words: Word[];
	heredocs: Heredoc[];
	nestedCommands: string[];
	budget: ParseBudget;
	frame: ParseFrame;
}

type ReaderAction = { kind: "continue" } | { kind: "split"; split: Split; next: number };

function dynamicChar(char: string, next: string | undefined): boolean {
	return char === "`" || (char === "$" && next !== undefined && /[A-Za-z_0-9{(?!@$*#'"-]/.test(next));
}

function afterContinuations(text: string, start: number): number {
	let index = start;
	while (text[index] === "\\" && text[index + 1] === "\n") index += 2;
	return index;
}

function unsafeDelimiterUnits(text: string): boolean {
	for (let index = 0; index < text.length; index++) {
		const unit = text.charCodeAt(index);
		if (unit === 1 || unit === 127) return true;
		if (unit >= 0xd800 && unit <= 0xdbff) {
			const next = text.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			index++;
		} else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
	}
	return false;
}

/** These checks add uncertainty without changing the reader's token boundaries. */
function inspectDollarReasons(state: ReaderState, index: number, doubleQuoted: boolean): void {
	const next = state.text[index + 1];
	if (afterContinuations(state.text, index + 1) !== index + 1 ||
		(next === "(" && afterContinuations(state.text, index + 2) !== index + 2 &&
			state.text[afterContinuations(state.text, index + 2)] === "(")) {
		state.budget.reasons.add("unsupported-shell");
		state.budget.continuedDollar = true;
	}
	if (next === "[" && state.frame.lastShift > index + 1) state.budget.reasons.add("unexpanded-arithmetic");
	if (doubleQuoted) return;
	if (state.pendingHeredoc && (next === "'" || next === '"')) state.budget.reasons.add("unexpanded-heredoc");
	if (next !== "'") return;
	const close = state.text.indexOf("'", index + 2);
	if (close === -1) return;
	let slash = close;
	while (state.text[slash - 1] === "\\") slash--;
	if ((close - slash) % 2) state.budget.reasons.add("unsupported-shell");
}

/** Inspect otherwise opaque bodies, retaining the enclosing parameter quote context. */
function inspectOpaqueExpansions(state: ReaderState, start: number, end: number, doubleQuoted: boolean, depth = 0): void {
	let quoted = doubleQuoted;
	for (let index = start; index < end; index++) {
		const char = state.text[index];
		if (char === "\\") { index++; continue; }
		if (char === "'" && !quoted) {
			index = afterSingleQuote(state.text, index, end) - 1;
			continue;
		}
		if (char === '"') { quoted = !quoted; continue; }
		if (char !== "$") continue;
		inspectDollarReasons(state, index, quoted);
		index = inspectOpaqueDollar(state, index, end, quoted, depth);
	}
}

function inspectOpaqueDollar(state: ReaderState, index: number, end: number, quoted: boolean, depth: number): number {
	const open = state.text[index + 1];
	if ((open !== "(" && open !== "{") || depth >= MAX_NESTED_DEPTH) return index;
	const close = skipBalanced(state.text, index + 1, open, open === "(" ? ")" : "}");
	if (open === "{") inspectOpaqueExpansions(state, index + 2, Math.min(end, close), quoted, depth + 1);
	else inspectOpaqueCommand(state, index + 2, Math.min(end, close - 1), depth + 1);
	return close - 1;
}

function inspectOpaqueCommand(state: ReaderState, start: number, end: number, depth: number): void {
	const budget: ParseBudget = { words: 0, stages: 0, reasons: new Set(), actions: [], bytes: 0, inspectionDepth: depth };
	parse(state.text.slice(start, end), depth, budget);
	if (budget.continuedDollar) {
		state.budget.reasons.add("unsupported-shell");
		state.budget.continuedDollar = true;
	}
}

function delimiterReasons(state: ReaderState): void {
	if (!state.heredocQuoted) state.budget.reasons.add("unexpanded-heredoc");
	if (unsafeDelimiterUnits(state.current)) state.budget.reasons.add("malformed-shell");
}

function inspectHeredocContinuation(state: ReaderState): void {
	let index = state.index + 2;
	if (state.text[index] === "-") index++;
	for (;;) {
		if (isBlank(state.text[index])) { index++; continue; }
		const next = afterContinuations(state.text, index);
		if (next === index) return;
		state.budget.reasons.add("unexpanded-heredoc");
		index = next;
		if (state.text[index] === "-") index++;
	}
}

function keywordEligible(state: ReaderState): boolean {
	return state.literal && !state.quoted && !state.escaped && !state.pendingRedirect && !state.pendingHeredoc;
}

function flushWord(state: ReaderState): void {
	if (!state.started) return;
	const word: Word = {
		text: state.current, literal: state.literal,
		keyword: keywordEligible(state),
	};
	state.budget.words++;
	if (state.budget.words > 4096) state.budget.reasons.add("word-limit");
	if ((state.pendingRedirect || state.pendingHeredoc) && !state.current) state.budget.reasons.add("malformed-shell");
	if (state.pendingHeredoc) {
		delimiterReasons(state);
		if (!state.quoted) state.budget.reasons.add("unexpanded-heredoc");
		if (state.current !== "") {
			word.heredoc = true;
			word.fd = state.pendingFd ?? 0;
			state.heredocs.push({ delimiter: state.current, stripTabs: state.pendingHeredoc === "<<-" });
		}
	} else if (state.pendingRedirect) {
		word.redirect = state.pendingRedirect;
		word.fd = state.pendingFd ?? (state.pendingRedirect === "in" ? 0 : 1);
	}
	state.words.push(word);
	state.current = "";
	state.literal = true;
	state.quoted = false;
	state.heredocQuoted = false;
	state.escaped = false;
	state.started = false;
	state.pendingRedirect = null;
	state.pendingHeredoc = null;
	state.pendingFd = null;
}

function afterHeredocBody(text: string, from: number, heredoc: Heredoc): number | undefined {
	let position = from;
	while (position < text.length) {
		const newline = text.indexOf("\n", position);
		const end = newline === -1 ? text.length : newline;
		const raw = text.slice(position, end);
		const line = heredoc.stripTabs ? raw.replace(/^\t+/, "") : raw;
		position = newline === -1 ? end : end + 1;
		if (line === heredoc.delimiter) return position;
	}
	return undefined;
}

function afterHeredocBodies(state: ReaderState, from: number): number {
	let position = from;
	for (const heredoc of state.heredocs) {
		const delimiter = escapedRegex(heredoc.delimiter.replace(/['"\\]/g, ""));
		const pattern = new RegExp(`^[ \\t]*${delimiter}[ \\t]*(?:\\n|$)`, "m");
		const match = pattern.exec(state.text.slice(position));
		const end = match ? position + match.index + match[0].length : undefined;
		if (unsafeDelimiterUnits(state.text.slice(position, end ?? state.text.length))) state.budget.reasons.add("malformed-shell");
		if (end === undefined || afterHeredocBody(state.text, position, heredoc) !== end)
			state.budget.reasons.add("malformed-shell");
		position = end ?? state.text.length;
	}
	state.heredocs.length = 0;
	return position;
}

function readerBalanced(state: ReaderState, start: number, open: string, close: string, doubleQuoted = false): number {
	const end = skipBalanced(state.text, start, open, close);
	if (open === "{" || (state.text[start - 1] === "$" && state.text[start + 1] === "("))
		inspectOpaqueExpansions(state, start + 1, end, open === "{" && doubleQuoted, state.budget.inspectionDepth ?? 0);
	if (state.text[end - 1] !== close) state.budget.reasons.add("malformed-shell");
	return end;
}

function addNestedCommand(state: ReaderState, from: number, to: number): void {
	if (to > from) state.nestedCommands.push(state.text.slice(from, to));
}

interface QuoteStep {
	scan: number;
	done?: boolean;
}

function doubleQuoteBackslash(state: ReaderState, scan: number): number {
	const next = state.text[scan + 1];
	if (next === "\n") return scan + 2;
	state.current += next !== undefined && '$`"\\'.includes(next) ? next : `\\${next ?? ""}`;
	return scan + 2;
}

function doubleQuoteDollar(state: ReaderState, scan: number): number {
	if (state.text.slice(scan, scan + 3) === "$((") {
		state.budget.reasons.add("unexpanded-arithmetic");
		const end = readerBalanced(state, scan + 1, "(", ")");
		state.current += state.text.slice(scan, end);
		collectNestedCommands(state.text, scan + 3, Math.max(scan + 3, end - 2), state.nestedCommands);
		return end;
	}
	if (state.text[scan + 1] === "(") {
		const end = readerBalanced(state, scan + 1, "(", ")");
		state.current += state.text.slice(scan, end);
		addNestedCommand(state, scan + 2, Math.max(scan + 2, end - 1));
		return end;
	}
	if (state.text[scan + 1] === "{") {
		const end = readerBalanced(state, scan + 1, "{", "}", true);
		if (/\$\(|`/.test(state.text.slice(scan, end))) state.budget.reasons.add("unexpanded-parameter");
		state.current += state.text.slice(scan, end);
		return end;
	}
	state.current += "$";
	return scan + 1;
}

function doubleQuoteBacktick(state: ReaderState, scan: number): number {
	state.budget.reasons.add("unexpanded-backtick");
	const close = state.text.indexOf("`", scan + 1);
	if (close === -1) state.budget.reasons.add("malformed-shell");
	const end = close === -1 ? state.text.length : close + 1;
	state.current += state.text.slice(scan, end);
	addNestedCommand(state, scan + 1, close === -1 ? state.text.length : close);
	return end;
}

function doubleQuoteStep(state: ReaderState, scan: number): QuoteStep {
	const char = state.text[scan];
	if (char === "$") inspectDollarReasons(state, scan, true);
	if (dynamicChar(char, state.text[scan + 1])) state.literal = false;
	if (char === '"') return { scan: scan + 1, done: true };
	if (char === "\\") return { scan: doubleQuoteBackslash(state, scan) };
	if (char === "$") return { scan: doubleQuoteDollar(state, scan) };
	if (char === "`") return { scan: doubleQuoteBacktick(state, scan) };
	state.current += char;
	return { scan: scan + 1 };
}

function readDoubleQuote(state: ReaderState): void {
	let scan = state.index + 1;
	while (scan < state.text.length) {
		const step = doubleQuoteStep(state, scan);
		scan = step.scan;
		if (step.done) {
			state.index = scan;
			return;
		}
	}
	state.budget.reasons.add("malformed-shell");
	state.index = state.text.length;
}

function blankAction(state: ReaderState): ReaderAction {
	flushWord(state);
	state.index++;
	return { kind: "continue" };
}

function commentAction(state: ReaderState): ReaderAction {
	const newline = state.text.indexOf("\n", state.index + 1);
	const next = newline === -1 ? state.text.length : newline + 1;
	return {
		kind: "split",
		split: { words: state.words, end: newline === -1 ? "eof" : "statement", ...(newline === -1 ? {} : { separator: "newline" as const }) },
		next: state.heredocs.length > 0 && newline !== -1 ? afterHeredocBodies(state, next) : next,
	};
}

function statementEndAction(state: ReaderState, char: string): ReaderAction {
	flushWord(state);
	const next = char === "\n" && state.heredocs.length > 0 ? afterHeredocBodies(state, state.index + 1) : state.index + 1;
	return { kind: "split", split: { words: state.words, end: "statement", separator: char === "\n" ? "newline" : "semicolon" }, next };
}

function ampersandAction(state: ReaderState): ReaderAction {
	if (state.text[state.index + 1] === ">") {
		flushWord(state);
		state.pendingRedirect = "out";
		state.pendingFd = 1;
		state.index += state.text[state.index + 2] === ">" ? 3 : 2;
		state.started = true;
		while (state.index < state.text.length && isBlank(state.text[state.index])) state.index++;
		return { kind: "continue" };
	}
	flushWord(state);
	return {
		kind: "split",
		split: { words: state.words, end: "statement", control: true },
		next: state.text[state.index + 1] === "&" ? state.index + 2 : state.index + 1,
	};
}

function pipeAction(state: ReaderState): ReaderAction {
	flushWord(state);
	if (state.text[state.index + 1] === "|")
		return { kind: "split", split: { words: state.words, end: "statement", control: true }, next: state.index + 2 };
	return {
		kind: "split",
		split: { words: state.words, end: "pipe" },
		next: state.text[state.index + 1] === "&" ? state.index + 2 : state.index + 1,
	};
}

function redirectAction(state: ReaderState, char: string): ReaderAction {
	if (state.text[state.index + 1] === "(") return processSubstitutionAction(state);
	return redirectOperatorAction(state, char);
}

function processSubstitutionAction(state: ReaderState): ReaderAction {
	state.literal = false;
	const end = readerBalanced(state, state.index + 1, "(", ")");
	state.current += state.text.slice(state.index, end);
	addNestedCommand(state, state.index + 2, Math.max(state.index + 2, end - 1));
	state.started = true;
	state.index = end;
	return { kind: "continue" };
}

function readHeredocOperator(state: ReaderState): void {
	inspectHeredocContinuation(state);
	state.heredocQuoted = false;
	state.pendingHeredoc = state.text[state.index + 2] === "-" ? "<<-" : "<<";
	state.index += state.pendingHeredoc === "<<-" ? 3 : 2;
}

function applyRedirectOperator(state: ReaderState, char: string): void {
	if (char === "<" && state.text.slice(state.index, state.index + 3) === "<<<") {
		state.pendingRedirect = "in";
		state.index += 3;
	} else if (char === "<" && state.text[state.index + 1] === "<") {
		readHeredocOperator(state);
	} else {
		state.pendingRedirect = char === "<" ? "in" : "out";
		if (state.text[state.index + 1] === char || state.text[state.index + 1] === "&" || state.text[state.index + 1] === "|")
			state.index += 2;
		else state.index++;
	}
}

function redirectOperatorAction(state: ReaderState, char: string): ReaderAction {
	let explicitFd: number | null = null;
	if (state.started && /^\d+$/.test(state.current)) {
		explicitFd = Number(state.current);
		state.current = "";
		state.started = false;
	} else {
		flushWord(state);
	}
	state.pendingFd = explicitFd;
	applyRedirectOperator(state, char);
	state.started = true;
	while (state.index < state.text.length && isBlank(state.text[state.index])) state.index++;
	return { kind: "continue" };
}

function singleQuoteAction(state: ReaderState): ReaderAction {
	if (state.pendingHeredoc) state.heredocQuoted = true;
	state.quoted = true;
	const close = state.text.indexOf("'", state.index + 1);
	if (close === -1) state.budget.reasons.add("malformed-shell");
	const end = close === -1 ? state.text.length : close;
	state.current += state.text.slice(state.index + 1, end);
	state.started = true;
	state.index = close === -1 ? state.text.length : end + 1;
	return { kind: "continue" };
}

function doubleQuoteAction(state: ReaderState): ReaderAction {
	if (state.pendingHeredoc) state.heredocQuoted = true;
	state.quoted = true;
	state.started = true;
	readDoubleQuote(state);
	return { kind: "continue" };
}

function backslashAction(state: ReaderState): ReaderAction {
	if (state.text[state.index + 1] === "\n") {
		state.index += 2;
		return { kind: "continue" };
	}
	if (state.pendingHeredoc) state.heredocQuoted = true;
	state.escaped = true;
	if (state.text[state.index + 1] === undefined) state.budget.reasons.add("malformed-shell");
	state.current += state.text[state.index + 1] ?? "";
	state.started = true;
	state.index += 2;
	return { kind: "continue" };
}

function dollarAction(state: ReaderState): ReaderAction {
	inspectDollarReasons(state, state.index, false);
	if (state.text.slice(state.index, state.index + 3) === "$((") {
		state.budget.reasons.add("unexpanded-arithmetic");
		const end = readerBalanced(state, state.index + 1, "(", ")");
		state.current += state.text.slice(state.index, end);
		collectNestedCommands(state.text, state.index + 3, Math.max(state.index + 3, end - 2), state.nestedCommands);
		state.started = true;
		state.index = end;
		return { kind: "continue" };
	}
	if (state.text[state.index + 1] === "(") {
		const end = readerBalanced(state, state.index + 1, "(", ")");
		state.current += state.text.slice(state.index, end);
		addNestedCommand(state, state.index + 2, Math.max(state.index + 2, end - 1));
		state.started = true;
		state.index = end;
		return { kind: "continue" };
	}
	if (state.text[state.index + 1] === "{") {
		const end = readerBalanced(state, state.index + 1, "{", "}");
		if (/\$\(|`/.test(state.text.slice(state.index, end))) state.budget.reasons.add("unexpanded-parameter");
		state.current += state.text.slice(state.index, end);
		state.started = true;
		state.index = end;
		return { kind: "continue" };
	}
	return plainAction(state, "$");
}

function backtickAction(state: ReaderState): ReaderAction {
	state.budget.reasons.add("unexpanded-backtick");
	const close = state.text.indexOf("`", state.index + 1);
	if (close === -1) state.budget.reasons.add("malformed-shell");
	const end = close === -1 ? state.text.length : close + 1;
	state.current += state.text.slice(state.index, end);
	addNestedCommand(state, state.index + 1, close === -1 ? state.text.length : close);
	state.started = true;
	state.index = end;
	return { kind: "continue" };
}

function groupAction(state: ReaderState, char: string): ReaderAction {
	if (char === "(" && state.text[afterContinuations(state.text, state.index + 1)] === "(" &&
		state.frame.lastShift > afterContinuations(state.text, state.index + 1)) state.budget.reasons.add("unexpanded-arithmetic");
	if (state.started) state.budget.reasons.add("unsupported-shell");
	if (char === "(" || char === "{") state.frame.groups.push(char);
	else if (state.frame.groups.pop() !== (char === ")" ? "(" : "{")) state.budget.reasons.add("malformed-shell");
	flushWord(state);
	return { kind: "split", split: { words: state.words, end: "statement", control: true }, next: state.index + 1 };
}

function plainAction(state: ReaderState, char: string): ReaderAction {
	state.current += char;
	state.started = true;
	state.index++;
	return { kind: "continue" };
}

function readerAction(state: ReaderState, char: string): ReaderAction {
	if (isBlank(char)) return blankAction(state);
	switch (char) {
		case "#":
			return state.started ? plainAction(state, char) : commentAction(state);
		case "\n":
		case ";":
			return statementEndAction(state, char);
		case "&":
			return ampersandAction(state);
		case "|":
			return pipeAction(state);
		case "<":
		case ">":
			return redirectAction(state, char);
		case "'":
			return singleQuoteAction(state);
		case '"':
			return doubleQuoteAction(state);
		case "\\":
			return backslashAction(state);
		case "$":
			return dollarAction(state);
		case "`":
			return backtickAction(state);
		case "(":
		case ")":
		case "{":
		case "}":
			return groupAction(state, char);
		default:
			return plainAction(state, char);
	}
}

/** Read one run of words up to the next top-level pipeline or statement separator. */
function readWords(
	text: string,
	start: number,
	heredocs: Heredoc[],
	nestedCommands: string[],
	budget: ParseBudget,
	frame: ParseFrame,
): { split: Split; next: number } {
	const state: ReaderState = {
		text,
		index: start,
		current: "",
		literal: true,
		quoted: false,
		heredocQuoted: false,
		escaped: false,
		started: false,
		pendingRedirect: null,
		pendingHeredoc: null,
		pendingFd: null,
		words: [],
		heredocs,
		nestedCommands,
		budget,
		frame,
	};
	while (state.index < state.text.length) {
		if (state.budget.words > 4096) return { split: { words: state.words, end: "eof" }, next: state.text.length };
		const char = state.text[state.index];
		if (dynamicChar(char, state.text[state.index + 1]) || "*?[~".includes(char)) state.literal = false;
		const action = readerAction(state, char);
		if (action.kind === "split") return { split: action.split, next: action.next };
	}
	flushWord(state);
	return { split: { words: state.words, end: "eof" }, next: state.text.length };
}
function skipOption(words: Word[], index: number, values: Set<string>): number {
	const text = words[index]?.text ?? "";
	if (!text.startsWith("-") || text === "-") return index;
	if (text === "--") return index + 1;
	const [name, attached] = text.replace(/^-+/, "").split("=", 2);
	return values.has(name) && attached === undefined ? index + 2 : index + 1;
}

/** Option names that accept a following value for each value-taking prefix wrapper. */
const PREFIX_VALUE_OPTIONS: Record<string, readonly string[]> = {
	sudo: ["u", "user", "g", "group", "h", "host", "p", "prompt", "C", "close-from"],
	exec: ["a", "argv0"],
	time: ["o", "output", "f", "format"],
	nice: ["n", "adjustment"],
};

function skipSimplePrefix(words: Word[], index: number): number {
	index++;
	while (words[index]?.text.startsWith("-") && words[index]?.text !== "--") index++;
	if (words[index]?.text === "--") index++;
	return index;
}

function skipCommandPrefix(words: Word[], index: number): { next: number; end: boolean } {
	const original = index;
	index++;
	while (words[index]?.text.startsWith("-") && words[index]?.text !== "--") {
		if (/^-[^-]*[vV]/.test(words[index].text)) return { next: original, end: true };
		index++;
	}
	if (words[index]?.text === "--") index++;
	return { next: index, end: false };
}

function skipEnvPrefix(
	words: Word[],
	index: number,
	reasons: string[],
): { next: number; end: boolean } {
	const original = index;
	index++;
	const values = new Set(["a", "argv0", "u", "unset", "C", "chdir", "S", "split-string"]);
	const flags = new Set(["-i", "-0", "-v", "--ignore-environment", "--null", "--debug"]);
	while (index < words.length) {
		const word = words[index].text;
		if (word === "--") {
			index++;
			break;
		}
		if (ASSIGNMENT.test(word)) {
			index++;
			continue;
		}
		if (/^-[auC].+/.test(word)) {
			index++;
			continue;
		}
		const name = word.replace(/^-+/, "").split("=", 1)[0];
		if (
			word.startsWith("-") &&
			!flags.has(word) &&
			!/^-[i0v]+$/.test(word) &&
			(!values.has(name) || name === "S" || name === "split-string")
		) {
			// CLI uncertainty must not replace the separate literal extraction contract.
			reasons.push("unresolved-command");
		}
		const next = skipOption(words, index, values);
		if (next === index) break;
		index = next;
	}
	return index >= words.length ? { next: original, end: true } : { next: index, end: false };
}

function skipValuePrefix(words: Word[], index: number, values: readonly string[]): number {
	const options = new Set(values);
	index++;
	while (index < words.length) {
		const next = skipOption(words, index, options);
		if (next === index) break;
		index = next;
	}
	return index;
}

function nextPrefixIndex(words: Word[], index: number, reasons: string[]): number | null {
	const command = basename(words[index]?.text ?? "");
	if (SHELL_PREFIXES.has(command) || SIMPLE_PREFIXES.has(command)) return skipSimplePrefix(words, index);
	if (command === "command") {
		const selected = skipCommandPrefix(words, index);
		return selected.end ? null : selected.next;
	}
	if (command === "env") {
		const env = skipEnvPrefix(words, index, reasons);
		return env.end ? null : env.next;
	}
	if (Object.hasOwn(PREFIX_VALUE_OPTIONS, command)) return skipValuePrefix(words, index, PREFIX_VALUE_OPTIONS[command]);
	return null;
}

function unwrapPrefix(words: Word[], start: number, reasons: string[]): number {
	let index = start;
	for (;;) {
		const next = nextPrefixIndex(words, index, reasons);
		if (next === null) return index;
		index = next;
	}
}

function toStage(words: Word[], fromPipe: boolean, toPipe: boolean): Stage {
	let operands = words.filter((word) => !word.redirect && !word.heredoc);
	const fromRedirect = words.some((word) => (word.redirect === "in" || word.heredoc) && word.fd === 0);
	const toRedirect = words.some((word) => word.redirect === "out" && word.fd === 1);
	let index = 0;
	const shellReasons: string[] = [];
	while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	index = unwrapPrefix(operands, index, shellReasons);
	while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	const prefix = operands.slice(0, index);
	if (prefix.some((word) => !word.literal)) shellReasons.push("dynamic-prefix");
	if (prefix.some((word) => ["sudo", "env", "time", "nice", "nohup"].includes(basename(word.text))))
		shellReasons.push("unsupported-prefix");
	operands = operands.slice(index);
	const head = operands[0]?.text ?? "";
	return {
		command: basename(head),
		args: operands.slice(1).map((word) => word.text),
		commandLiteral: operands[0]?.literal ?? true,
		argLiterals: operands.slice(1).map((word) => word.literal),
		...(shellReasons.length ? { shellReasons } : {}),
		fromPipe,
		toPipe,
		fromRedirect,
		toRedirect,
	};
}

const TRAP_SIGNAL = /^(?:[0-9]+|(?:SIG)?(?:EXIT|DEBUG|ERR|RETURN|HUP|INT|QUIT|ILL|TRAP|ABRT|EMT|FPE|KILL|BUS|SEGV|SYS|PIPE|ALRM|TERM|URG|STOP|TSTP|CONT|CHLD|TTIN|TTOU|IO|XCPU|XFSZ|VTALRM|PROF|WINCH|INFO|USR1|USR2))$/;

function trapAction(stage: Stage, depth: number, budget: ParseBudget): void {
	let index = 0;
	const literal = (position: number) => stage.argLiterals?.[position] !== false;
	if (!literal(index)) { budget.reasons.add("unresolved-command"); return; }
	if (/^-[lp]+$/.test(stage.args[index] ?? "")) return;
	if (stage.args[index] === "--") index++;
	const action = stage.args[index];
	if (action === undefined) return;
	const signals = stage.args.slice(index + 1);
	if (!literal(index) || signals.some((signal, offset) => !literal(index + 1 + offset) || !TRAP_SIGNAL.test(signal))) {
		budget.reasons.add("unresolved-command");
		return;
	}
	if (action === "-" || action === "" || (!signals.length && TRAP_SIGNAL.test(action))) return;
	if (!signals.length || action.startsWith("-")) { budget.reasons.add("unresolved-command"); return; }
	budget.actions.push({ command: action, depth: depth + 1 });
}

function aliasReasons(stage: Stage, budget: ParseBudget): void {
	let index = 0;
	if (stage.argLiterals?.[index] === false) { budget.reasons.add("unresolved-command"); return; }
	if (/^-p+$/.test(stage.args[index] ?? "")) return;
	if (stage.args[index] === "--") index++;
	if (stage.args.slice(index).some((arg, offset) => stage.argLiterals?.[index + offset] === false || arg.startsWith("-") || arg.includes("=")))
		budget.reasons.add("unresolved-command");
}

function collectActionEvidence(statements: Statement[], depth: number, budget: ParseBudget): void {
	for (const stage of statements.flat()) {
		if (stage.commandLiteral === false) continue;
		if (stage.command === "trap") trapAction(stage, depth, budget);
		if (stage.command === "alias") aliasReasons(stage, budget);
	}
}

/** The original tree spends its budgets before any supplemental action. */
function appendActionEvidence(statements: Statement[], budget: ParseBudget): void {
	for (let index = 0; index < budget.actions.length; index++) {
		const action = budget.actions[index];
		if (action.depth > MAX_NESTED_DEPTH) { budget.reasons.add("nested-depth-limit"); continue; }
		if (budget.words > 4096 || budget.stages >= 256) { budget.reasons.add("parse-limit"); break; }
		const bytes = Buffer.byteLength(action.command, "utf8");
		if (budget.bytes + bytes > 64 * 1024) { budget.reasons.add("command-byte-limit"); continue; }
		budget.bytes += bytes;
		statements.push(...parse(action.command, action.depth, budget));
	}
}

function closeStatement(stages: Word[][], statements: Statement[]): void {
	if (stages.length === 0) return;
	const statement = stages.map((words, position) => toStage(words, position > 0, position < stages.length - 1));
	if (statement.some((stage) => stage.command !== "")) statements.push(statement);
	stages.length = 0;
}

/** Admit one read split; returns true when the parse loop must end. */
function admitSplit(
	split: Split,
	next: number,
	index: number,
	stages: Word[][],
	statements: Statement[],
	budget: ParseBudget,
): boolean {
	if (split.words.length > 0 || split.end === "pipe") {
		stages.push(split.words);
		budget.stages++;
	}
	if (split.end === "eof" && stages.length > 0 && split.words.length === 0) budget.reasons.add("malformed-shell");
	if (split.end === "statement") closeStatement(stages, statements);
	if (split.end === "eof") {
		closeStatement(stages, statements);
		return true;
	}
	return next <= index;
}

function collectParsedNested(
	statements: Statement[],
	nestedCommands: string[],
	depth: number,
	budget: ParseBudget,
): void {
	if (depth >= MAX_NESTED_DEPTH) {
		if (nestedCommands.length) budget.reasons.add("nested-depth-limit");
		return;
	}
	for (const nested of nestedCommands) {
		if (budget.words > 4096 || budget.stages >= 256) {
			budget.reasons.add("parse-limit");
			break;
		}
		statements.push(...parse(nested, depth + 1, budget));
	}
}

const LOOP_CONTROLS = new Set(["for", "select", "case", "function", "if", "then", "elif", "else", "fi", "while", "until", "do", "done", "esac", "!"]);

function keyword(word: Word | undefined, text: string): boolean {
	return word?.keyword === true && word.text === text;
}

function plainForHeader(split: Split, frame: ParseFrame, stages: Word[][]): boolean {
	const words = split.words;
	return stages.length === 0 && frame.groups.length === 0 && split.end === "statement" && !split.control &&
		words[1]?.keyword === true && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[1].text) && keyword(words[2], "in") &&
		!words.some((word) => word.redirect || word.heredoc);
}

function openFor(split: Split, frame: ParseFrame, stages: Word[][], budget: ParseBudget): Split {
	if (keyword(split.words[0], "for")) {
		if (plainForHeader(split, frame, stages)) {
			frame.loop = { phase: "do", body: false };
			return { ...split, words: [] };
		}
		budget.reasons.add("unsupported-for-syntax");
	}
	return split;
}

function startForBody(split: Split, frame: ParseFrame, stages: Word[][], budget: ParseBudget, loop: NonNullable<ParseFrame["loop"]>): Split {
	if (!keyword(split.words[0], "do")) {
		budget.reasons.add("malformed-for-syntax");
		return split;
	}
	loop.phase = "body";
	if (split.words.length === 1 && split.separator !== "newline") budget.reasons.add("malformed-for-syntax");
	return loopSplit({ ...split, words: split.words.slice(1) }, frame, stages, budget);
}

/** Consume only the closed plain-for grammar; all other control remains unavailable. */
function loopSplit(split: Split, frame: ParseFrame, stages: Word[][], budget: ParseBudget): Split {
	const words = split.words;
	const first = words[0];
	if (!frame.loop) return openFor(split, frame, stages, budget);
	if (split.control || frame.groups.length) budget.reasons.add("unsupported-for-syntax");
	if (!first) {
		if (split.separator === "semicolon" || split.end === "pipe" || stages.length > 0)
			budget.reasons.add("malformed-for-syntax");
		return split;
	}
	if (frame.loop.phase === "do") return startForBody(split, frame, stages, budget, frame.loop);
	if (keyword(first, "done")) {
		if (words.length !== 1 || stages.length || split.end === "pipe" || !frame.loop.body)
			budget.reasons.add("malformed-for-syntax");
		delete frame.loop;
		return { ...split, words: words.slice(1) };
	}
	if (first.keyword && LOOP_CONTROLS.has(first.text)) budget.reasons.add("unsupported-for-syntax");
	frame.loop.body = true;
	return split;
}

function countLoopStructure(split: Split, body: Split, budget: ParseBudget): void {
	// Structural words consume the same work budget as ordinary command words.
	if (split.words.length > 0 && body.words.length === 0 && split.end !== "pipe") budget.stages++;
}

function parse(command: string, depth: number, budget: ParseBudget): Statement[] {
	const statements: Statement[] = [];
	const heredocs: Heredoc[] = [];
	const nestedCommands: string[] = [];
	const frame: ParseFrame = { groups: [], lastShift: command.lastIndexOf("<<") };
	const stages: Word[][] = [];
	let index = 0;
	while (index <= command.length) {
		if (budget.words > 4096 || (budget.stages >= 256 && index < command.length)) {
			budget.reasons.add(budget.words > 4096 ? "word-limit" : "stage-limit");
			closeStatement(stages, statements);
			break;
		}
		const { split, next } = readWords(command, index, heredocs, nestedCommands, budget, frame);
		const body = loopSplit(split, frame, stages, budget);
		countLoopStructure(split, body, budget);
		if (admitSplit(body, next, index, stages, statements, budget)) break;
		index = next;
	}
	if (heredocs.length || frame.groups.length) budget.reasons.add("malformed-shell");
	if (frame.loop) budget.reasons.add("malformed-for-syntax");
	collectActionEvidence(statements, depth, budget);
	collectParsedNested(statements, nestedCommands, depth, budget);
	return statements;
}

/** Split command text into top-level and nested statements of pipeline stages. */
export function parseStatements(command: string): Statement[] {
	return parseShellEvidence(command).statements;
}

/** Unexamined input never proves absence. All budgets apply across nested statements. */
export function parseShellEvidence(command: string): ShellEvidence {
	if (Buffer.byteLength(command, "utf8") > 64 * 1024)
		return { statements: [], wordCount: 0, complete: false, reasons: ["command-byte-limit"] };
	const budget: ParseBudget = { words: 0, stages: 0, reasons: new Set(), actions: [], bytes: Buffer.byteLength(command, "utf8") };
	if (command.includes("\0")) budget.reasons.add("malformed-shell");
	const statements = parse(command, 0, budget);
	appendActionEvidence(statements, budget);
	return { statements, wordCount: budget.words, complete: budget.reasons.size === 0, reasons: [...budget.reasons] };
}
