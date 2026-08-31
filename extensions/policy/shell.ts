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

/** Consume a balanced shell body and return the index after its close. */
function skipBalanced(text: string, start: number, open: string, close: string): number {
	let depth = 0;
	let quote: "single" | "double" | null = null;
	let index = start;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (quote === "single") {
			if (char === "'") quote = null;
			index++;
			continue;
		}
		if (quote === "double") {
			if (char === '"') {
				quote = null;
				index++;
				continue;
			}
			if (char === "$" && text[index + 1] === "(") {
				index = skipBalanced(text, index + 1, "(", ")");
				continue;
			}
			index++;
			continue;
		}
		if (char === "'") {
			quote = "single";
			index++;
			continue;
		}
		if (char === '"') {
			quote = "double";
			index++;
			continue;
		}
		if (char === "`") {
			const end = text.indexOf("`", index + 1);
			index = end === -1 ? text.length : end + 1;
			continue;
		}
		if (char === "$" && text[index + 1] === "{") {
			index = skipBalanced(text, index + 1, "{", "}");
			continue;
		}
		if (char === open) depth++;
		else if (char === close) {
			depth--;
			if (depth === 0) return index + 1;
		}
		index++;
	}
	return text.length;
}

/** Find real command substitutions inside an otherwise opaque shell body. */
function collectNestedCommands(text: string, start: number, end: number, nestedCommands: string[]): void {
	let index = start;
	while (index < end) {
		if (text[index] === "\\") {
			index += 2;
			continue;
		}
		if (text[index] === "'") {
			const close = text.indexOf("'", index + 1);
			index = close === -1 ? end : close + 1;
			continue;
		}
		if (text[index] === "$" && text[index + 1] === "{") {
			index = skipBalanced(text, index + 1, "{", "}");
			continue;
		}
		if (text[index] === "$" && text.slice(index, index + 3) === "$((") {
			const close = skipBalanced(text, index + 1, "(", ")");
			collectNestedCommands(text, index + 3, Math.max(index + 3, close - 2), nestedCommands);
			index = close;
			continue;
		}
		if (text[index] === "$" && text[index + 1] === "(") {
			const close = skipBalanced(text, index + 1, "(", ")");
			nestedCommands.push(text.slice(index + 2, Math.max(index + 2, close - 1)));
			index = close;
			continue;
		}
		if (text[index] === "`") {
			const close = text.indexOf("`", index + 1);
			nestedCommands.push(text.slice(index + 1, close === -1 ? end : close));
			index = close === -1 ? end : close + 1;
			continue;
		}
		index++;
	}
}

interface Word {
	text: string;
	/** The word carries a redirect operator rather than an operand. */
	redirect?: "in" | "out";
	/** The word opened a heredoc; its text is the delimiter. */
	heredoc?: boolean;
	/** Explicit or default descriptor affected by a redirect. */
	fd?: number;
}

interface Split {
	words: Word[];
	/** Separator that ended this run of words. */
	end: "pipe" | "statement" | "eof";
}

function escapedRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read one run of words up to the next top-level pipeline or statement separator. */
function readWords(
	text: string,
	start: number,
	heredocs: string[],
	nestedCommands: string[],
): { split: Split; next: number } {
	const words: Word[] = [];
	let current = "";
	let started = false;
	let pendingRedirect: "in" | "out" | null = null;
	let pendingHeredoc = false;
	let pendingFd: number | null = null;
	let index = start;

	const flush = (): void => {
		if (!started) return;
		const word: Word = { text: current };
		if (pendingHeredoc) {
			if (current !== "") {
				word.heredoc = true;
				word.fd = pendingFd ?? 0;
				heredocs.push(current.replace(/['"\\]/g, ""));
			}
		} else if (pendingRedirect) {
			word.redirect = pendingRedirect;
			word.fd = pendingFd ?? (pendingRedirect === "in" ? 0 : 1);
		}
		words.push(word);
		current = "";
		started = false;
		pendingRedirect = null;
		pendingHeredoc = false;
		pendingFd = null;
	};

	const afterHeredocBodies = (from: number): number => {
		let position = from;
		for (const delimiter of heredocs) {
			const pattern = new RegExp(`^[ \\t]*${escapedRegex(delimiter)}[ \\t]*(?:\\n|$)`, "m");
			const match = pattern.exec(text.slice(position));
			position = match ? position + match.index + match[0].length : text.length;
		}
		heredocs.length = 0;
		return position;
	};

	const addNested = (from: number, to: number): void => {
		if (to > from) nestedCommands.push(text.slice(from, to));
	};

	const readDoubleQuote = (): void => {
		let scan = index + 1;
		while (scan < text.length) {
			const char = text[scan];
			if (char === '"') {
				index = scan + 1;
				return;
			}
			if (char === "\\") {
				current += text[scan + 1] ?? "";
				scan += 2;
				continue;
			}
			if (char === "$" && text.slice(scan, scan + 3) === "$((") {
				const end = skipBalanced(text, scan + 1, "(", ")");
				current += text.slice(scan, end);
				collectNestedCommands(text, scan + 3, Math.max(scan + 3, end - 2), nestedCommands);
				scan = end;
				continue;
			}
			if (char === "$" && text[scan + 1] === "(") {
				const end = skipBalanced(text, scan + 1, "(", ")");
				current += text.slice(scan, end);
				addNested(scan + 2, Math.max(scan + 2, end - 1));
				scan = end;
				continue;
			}
			if (char === "$" && text[scan + 1] === "{") {
				const end = skipBalanced(text, scan + 1, "{", "}");
				current += text.slice(scan, end);
				scan = end;
				continue;
			}
			if (char === "`") {
				const close = text.indexOf("`", scan + 1);
				const end = close === -1 ? text.length : close + 1;
				current += text.slice(scan, end);
				addNested(scan + 1, close === -1 ? text.length : close);
				scan = end;
				continue;
			}
			current += char;
			scan++;
		}
		index = text.length;
	};

	while (index < text.length) {
		const char = text[index];

		if (isBlank(char)) {
			flush();
			index++;
			continue;
		}

		if (char === "#" && !started) {
			const newline = text.indexOf("\n", index + 1);
			const next = newline === -1 ? text.length : newline + 1;
			return {
				split: { words, end: newline === -1 ? "eof" : "statement" },
				next: heredocs.length > 0 && newline !== -1 ? afterHeredocBodies(next) : next,
			};
		}

		if (char === "\n" || char === ";") {
			flush();
			const next = char === "\n" && heredocs.length > 0 ? afterHeredocBodies(index + 1) : index + 1;
			return { split: { words, end: "statement" }, next };
		}

		if (char === "&" && text[index + 1] === ">") {
			flush();
			pendingRedirect = "out";
			pendingFd = 1;
			index += text[index + 2] === ">" ? 3 : 2;
			started = true;
			while (index < text.length && isBlank(text[index])) index++;
			continue;
		}

		if (char === "&") {
			flush();
			return { split: { words, end: "statement" }, next: text[index + 1] === "&" ? index + 2 : index + 1 };
		}

		if (char === "|") {
			flush();
			if (text[index + 1] === "|") return { split: { words, end: "statement" }, next: index + 2 };
			return { split: { words, end: "pipe" }, next: text[index + 1] === "&" ? index + 2 : index + 1 };
		}

		if ((char === "<" || char === ">") && text[index + 1] === "(") {
			const end = skipBalanced(text, index + 1, "(", ")");
			current += text.slice(index, end);
			addNested(index + 2, Math.max(index + 2, end - 1));
			started = true;
			index = end;
			continue;
		}

		if (char === "<" || char === ">") {
			let explicitFd: number | null = null;
			if (started && /^\d+$/.test(current)) {
				explicitFd = Number(current);
				current = "";
				started = false;
			} else {
				flush();
			}
			pendingFd = explicitFd;
			if (char === "<" && text.slice(index, index + 3) === "<<<") {
				pendingRedirect = "in";
				index += 3;
			} else if (char === "<" && text[index + 1] === "<") {
				pendingHeredoc = true;
				index += text[index + 2] === "-" ? 3 : 2;
			} else {
				pendingRedirect = char === "<" ? "in" : "out";
				if (text[index + 1] === char || text[index + 1] === "&" || text[index + 1] === "|") index += 2;
				else index++;
			}
			started = true;
			while (index < text.length && isBlank(text[index])) index++;
			continue;
		}

		if (char === "'") {
			const close = text.indexOf("'", index + 1);
			const end = close === -1 ? text.length : close;
			current += text.slice(index + 1, end);
			started = true;
			index = close === -1 ? text.length : end + 1;
			continue;
		}

		if (char === '"') {
			started = true;
			readDoubleQuote();
			continue;
		}

		if (char === "\\") {
			if (text[index + 1] === "\n") {
				index += 2;
				continue;
			}
			current += text[index + 1] ?? "";
			started = true;
			index += 2;
			continue;
		}

		if (char === "$" && text.slice(index, index + 3) === "$((") {
			const end = skipBalanced(text, index + 1, "(", ")");
			current += text.slice(index, end);
			collectNestedCommands(text, index + 3, Math.max(index + 3, end - 2), nestedCommands);
			started = true;
			index = end;
			continue;
		}

		if (char === "$" && text[index + 1] === "(") {
			const end = skipBalanced(text, index + 1, "(", ")");
			current += text.slice(index, end);
			addNested(index + 2, Math.max(index + 2, end - 1));
			started = true;
			index = end;
			continue;
		}

		if (char === "$" && text[index + 1] === "{") {
			const end = skipBalanced(text, index + 1, "{", "}");
			current += text.slice(index, end);
			started = true;
			index = end;
			continue;
		}

		if (char === "`") {
			const close = text.indexOf("`", index + 1);
			const end = close === -1 ? text.length : close + 1;
			current += text.slice(index, end);
			addNested(index + 1, close === -1 ? text.length : close);
			started = true;
			index = end;
			continue;
		}

		if (char === "(" || char === ")" || char === "{" || char === "}") {
			flush();
			return { split: { words, end: "statement" }, next: index + 1 };
		}

		current += char;
		started = true;
		index++;
	}

	flush();
	return { split: { words, end: "eof" }, next: text.length };
}

function skipOption(words: Word[], index: number, values: Set<string>): number {
	const text = words[index]?.text ?? "";
	if (!text.startsWith("-") || text === "-") return index;
	if (text === "--") return index + 1;
	const [name, attached] = text.replace(/^-+/, "").split("=", 2);
	return values.has(name) && attached === undefined ? index + 2 : index + 1;
}

function unwrapPrefix(words: Word[], start: number): number {
	let index = start;
	for (;;) {
		const command = basename(words[index]?.text ?? "");
		if (SHELL_PREFIXES.has(command) || SIMPLE_PREFIXES.has(command)) {
			index++;
			while (words[index]?.text.startsWith("-") && words[index]?.text !== "--") index++;
			if (words[index]?.text === "--") index++;
			continue;
		}
		if (command === "command") {
			if (words.slice(index + 1).some((word) => /^-[^-]*[vV]/.test(word.text))) return index;
			index++;
			while (words[index]?.text.startsWith("-") && words[index]?.text !== "--") index++;
			if (words[index]?.text === "--") index++;
			continue;
		}
		if (command === "env") {
			const original = index;
			index++;
			const values = new Set(["a", "argv0", "u", "unset", "C", "chdir", "S", "split-string"]);
			while (index < words.length) {
				if (ASSIGNMENT.test(words[index].text)) {
					index++;
					continue;
				}
				const next = skipOption(words, index, values);
				if (next === index) break;
				index = next;
			}
			if (index >= words.length) return original;
			continue;
		}
		if (command === "sudo") {
			index++;
			const values = new Set(["u", "user", "g", "group", "h", "host", "p", "prompt", "C", "close-from"]);
			while (index < words.length) {
				const next = skipOption(words, index, values);
				if (next === index) break;
				index = next;
			}
			continue;
		}
		if (command === "exec") {
			index++;
			const values = new Set(["a", "argv0"]);
			while (index < words.length) {
				const next = skipOption(words, index, values);
				if (next === index) break;
				index = next;
			}
			continue;
		}
		if (command === "time") {
			index++;
			const values = new Set(["o", "output", "f", "format"]);
			while (index < words.length) {
				const next = skipOption(words, index, values);
				if (next === index) break;
				index = next;
			}
			continue;
		}
		if (command === "nice") {
			index++;
			const values = new Set(["n", "adjustment"]);
			while (index < words.length) {
				const next = skipOption(words, index, values);
				if (next === index) break;
				index = next;
			}
			continue;
		}
		return index;
	}
}

function toStage(words: Word[], fromPipe: boolean, toPipe: boolean): Stage {
	let operands = words.filter((word) => !word.redirect && !word.heredoc);
	const fromRedirect = words.some((word) => (word.redirect === "in" || word.heredoc) && word.fd === 0);
	const toRedirect = words.some((word) => word.redirect === "out" && word.fd === 1);
	let index = 0;
	while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	index = unwrapPrefix(operands, index);
	while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	operands = operands.slice(index);
	const head = operands[0]?.text ?? "";
	return {
		command: basename(head),
		args: operands.slice(1).map((word) => word.text),
		fromPipe,
		toPipe,
		fromRedirect,
		toRedirect,
	};
}

function parse(command: string, depth: number): Statement[] {
	const statements: Statement[] = [];
	const heredocs: string[] = [];
	const nestedCommands: string[] = [];
	let stages: Word[][] = [];
	let index = 0;

	const close = (): void => {
		if (stages.length === 0) return;
		const statement = stages.map((words, position) =>
			toStage(words, position > 0, position < stages.length - 1),
		);
		if (statement.some((stage) => stage.command !== "")) statements.push(statement);
		stages = [];
	};

	while (index <= command.length) {
		const { split, next } = readWords(command, index, heredocs, nestedCommands);
		if (split.words.length > 0 || split.end === "pipe") stages.push(split.words);
		if (split.end === "statement") close();
		if (split.end === "eof") {
			close();
			break;
		}
		if (next <= index) break;
		index = next;
	}
	if (depth < MAX_NESTED_DEPTH) {
		for (const nested of nestedCommands) statements.push(...parse(nested, depth + 1));
	}
	return statements;
}

/** Split command text into top-level and nested statements of pipeline stages. */
export function parseStatements(command: string): Statement[] {
	return parse(command, 0);
}
