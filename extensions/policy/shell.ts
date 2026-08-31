/**
 * Minimal POSIX-shell reader used to classify command text.
 *
 * It resolves quoting, escapes, heredocs, and substitution bodies well enough
 * to split a command line into statements and pipeline stages, and to read each
 * stage's command word and operands. It is not a shell: it expands no
 * variables, globs, or aliases, and it treats a substitution body as one opaque
 * word. Classification therefore reads command shape, never command effect.
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
	/** A file redirect or heredoc feeds this stage's standard input. */
	fromRedirect: boolean;
}

/** One statement: pipeline stages separated by `|`. */
export type Statement = Stage[];

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

function isBlank(char: string): boolean {
	return char === " " || char === "\t";
}

/** Consume a bracketed body, honoring nesting, and return the index after it. */
function skipBalanced(text: string, start: number, open: string, close: string): number {
	let depth = 0;
	let index = start;
	while (index < text.length) {
		const char = text[index];
		if (char === "\\") {
			index += 2;
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

interface Word {
	text: string;
	/** The word carries a redirect operator rather than an operand. */
	redirect?: "in" | "out";
	/** The word opened a heredoc; its text is the delimiter. */
	heredoc?: boolean;
}

interface Split {
	words: Word[];
	/** Separator that ended this run of words. */
	end: "pipe" | "statement" | "eof";
}

/**
 * Read one run of words up to the next pipeline or statement separator.
 * Heredoc bodies are consumed whole so their content never parses as commands.
 */
function readWords(text: string, start: number, heredocs: string[]): { split: Split; next: number } {
	const words: Word[] = [];
	let current = "";
	let started = false;
	let pendingRedirect: "in" | "out" | null = null;
	let pendingHeredoc = false;
	let index = start;

	const flush = (): void => {
		if (!started) return;
		const word: Word = { text: current };
		if (pendingHeredoc) {
			word.heredoc = true;
			heredocs.push(current.replace(/['"\\]/g, ""));
		} else if (pendingRedirect) {
			word.redirect = pendingRedirect;
		}
		words.push(word);
		current = "";
		started = false;
		pendingRedirect = null;
		pendingHeredoc = false;
	};

	/**
	 * Skip every queued heredoc body. Bodies start on the line after the
	 * operator, so they are consumed at the newline, not at the operator, and
	 * each ends at its delimiter on its own line.
	 */
	const afterHeredocBodies = (from: number): number => {
		let position = from;
		for (const delimiter of heredocs) {
			const pattern = new RegExp(`^[ \\t]*${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*$`, "m");
			const match = pattern.exec(text.slice(position));
			position = match ? position + match.index + match[0].length : text.length;
		}
		heredocs.length = 0;
		return position;
	};

	while (index < text.length) {
		const char = text[index];

		if (isBlank(char)) {
			flush();
			index++;
			continue;
		}

		if (char === "\n" || char === ";") {
			flush();
			const next = char === "\n" && heredocs.length > 0 ? afterHeredocBodies(index + 1) : index + 1;
			return { split: { words, end: "statement" }, next };
		}

		if (char === "&") {
			flush();
			return { split: { words, end: "statement" }, next: text[index + 1] === "&" ? index + 2 : index + 1 };
		}

		if (char === "|") {
			flush();
			if (text[index + 1] === "|") return { split: { words, end: "statement" }, next: index + 2 };
			return { split: { words, end: "pipe" }, next: index + 1 };
		}

		if (char === "<" || char === ">") {
			flush();
			if (char === "<" && text[index + 1] === "<") {
				pendingHeredoc = true;
				index += text[index + 2] === "-" ? 3 : 2;
			} else {
				pendingRedirect = char === "<" ? "in" : "out";
				index += text[index + 1] === ">" || text[index + 1] === "&" ? 2 : 1;
			}
			started = true;
			current = "";
			// A redirect target is the next word; keep reading into it.
			while (index < text.length && isBlank(text[index])) index++;
			continue;
		}

		if (char === "'") {
			const close = text.indexOf("'", index + 1);
			const end = close === -1 ? text.length : close;
			current += text.slice(index + 1, end);
			started = true;
			index = end + 1;
			continue;
		}

		if (char === '"') {
			let scan = index + 1;
			while (scan < text.length && text[scan] !== '"') {
				if (text[scan] === "\\") {
					current += text[scan + 1] ?? "";
					scan += 2;
					continue;
				}
				current += text[scan];
				scan++;
			}
			started = true;
			index = scan + 1;
			continue;
		}

		if (char === "\\") {
			// A line continuation joins words; any other escape is literal.
			if (text[index + 1] === "\n") {
				index += 2;
				continue;
			}
			current += text[index + 1] ?? "";
			started = true;
			index += 2;
			continue;
		}

		if (char === "$" && text[index + 1] === "(") {
			const end = skipBalanced(text, index + 1, "(", ")");
			current += text.slice(index, end);
			started = true;
			index = end;
			continue;
		}

		if (char === "`") {
			const close = text.indexOf("`", index + 1);
			const end = close === -1 ? text.length : close + 1;
			current += text.slice(index, end);
			started = true;
			index = end;
			continue;
		}

		if (char === "(" || char === ")" || char === "{" || char === "}") {
			// Grouping punctuation is not part of a command word.
			flush();
			index++;
			continue;
		}

		current += char;
		started = true;
		index++;
	}

	flush();
	return { split: { words, end: "eof" }, next: text.length };
}

function toStage(words: Word[], fromPipe: boolean, toPipe: boolean): Stage {
	let operands = words.filter((word) => !word.redirect && !word.heredoc);
	const fromRedirect = words.some((word) => word.redirect === "in" || word.heredoc);
	// Leading `VAR=value` assignments and an `env` prefix hide the real command.
	let index = 0;
	while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	if (
		index < operands.length &&
		operands[index].text.replace(/^.*\//, "") === "env" &&
		operands.slice(index + 1).some((word) => !word.text.startsWith("-") && !ASSIGNMENT.test(word.text))
	) {
		index++;
		while (index < operands.length && ASSIGNMENT.test(operands[index].text)) index++;
	}
	operands = operands.slice(index);
	const head = operands[0]?.text ?? "";
	return {
		command: head.replace(/^.*\//, ""),
		args: operands.slice(1).map((word) => word.text),
		fromPipe,
		toPipe,
		fromRedirect,
	};
}

/** Split command text into statements of pipeline stages. */
export function parseStatements(command: string): Statement[] {
	const statements: Statement[] = [];
	const heredocs: string[] = [];
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
		const { split, next } = readWords(command, index, heredocs);
		if (split.words.length > 0 || split.end === "pipe") stages.push(split.words);
		if (split.end === "statement") close();
		if (split.end === "eof") {
			close();
			break;
		}
		if (next <= index) break;
		index = next;
	}
	return statements;
}
