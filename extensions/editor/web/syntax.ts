const code =
	"break case catch class const continue default delete do else export extends false finally for function if import in instanceof let new null return super switch this throw true try typeof var void while with yield async await of";
const typed =
	"abstract any as asserts bigint boolean declare enum implements infer interface is keyof module namespace never number object override private protected public readonly satisfies string symbol type undefined unique unknown";
type Grammar = readonly [comment: string | null, block: string | null, keywords: string, literals: string];

const grammars = {
	JavaScript: ["//", "/*", code, "true false null undefined NaN Infinity"],
	TypeScript: ["//", "/*", `${code} ${typed}`, "true false null undefined NaN Infinity"],
	JSON: [null, null, "", "true false null"],
	Python: [
		"#",
		null,
		"and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield",
		"True False None",
	],
	Shell: [
		"#",
		null,
		"if then else elif fi for in do done while until case esac function local export return exit set source trap readonly unset",
		"true false",
	],
	CSS: [null, "/*", "important inherit initial unset revert auto none transparent", "true false"],
	HTML: [null, "<!--", "", ""],
	Markdown: [null, "<!--", "", ""],
	YAML: ["#", null, "", "true false null yes no on off"],
	TOML: ["#", null, "", "true false"],
	Ruby: [
		"#",
		null,
		"alias and begin break case class def do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield",
		"true false nil",
	],
	Rust: [
		"//",
		"/*",
		"as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self static struct super trait type unsafe use where while yield",
		"true false None Some Ok Err",
	],
	Go: [
		"//",
		"/*",
		"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
		"true false nil iota",
	],
	Swift: [
		"//",
		"/*",
		"actor as async await break case catch class conformance continue defer deinit do else enum extension fallthrough fileprivate for func guard if import in init internal is let mutating nonmutating open operator private protocol public repeat return self static struct super switch throws throw try typealias var where while",
		"true false nil",
	],
	C: [
		"//",
		"/*",
		"auto bool break case char class const constexpr continue default do double else enum explicit export extern float for if inline int long namespace nullptr private protected public return short signed sizeof static struct switch template typedef typename union unsigned using void volatile while",
		"true false nullptr NULL",
	],
	Java: [
		"//",
		"/*",
		"abstract boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while",
		"true false null",
	],
	SQL: [
		"--",
		"/*",
		"alter and as asc begin between by case create cross delete desc distinct drop else end exists from group having in index inner insert into is join left limit not offset on or order outer primary references right select set table then union unique update values view when where with",
		"true false null",
	],
} satisfies Record<string, Grammar>;

export type Language = keyof typeof grammars | "Plain text";

const extensions: Readonly<Record<string, Language>> = {
	js: "JavaScript",
	jsx: "JavaScript",
	mjs: "JavaScript",
	cjs: "JavaScript",
	ts: "TypeScript",
	tsx: "TypeScript",
	mts: "TypeScript",
	cts: "TypeScript",
	json: "JSON",
	jsonl: "JSON",
	py: "Python",
	pyi: "Python",
	rb: "Ruby",
	rs: "Rust",
	go: "Go",
	swift: "Swift",
	c: "C",
	h: "C",
	cc: "C",
	cpp: "C",
	hpp: "C",
	m: "C",
	mm: "C",
	java: "Java",
	kt: "Java",
	cs: "Java",
	sh: "Shell",
	bash: "Shell",
	zsh: "Shell",
	fish: "Shell",
	css: "CSS",
	scss: "CSS",
	less: "CSS",
	html: "HTML",
	htm: "HTML",
	svg: "HTML",
	xml: "HTML",
	md: "Markdown",
	markdown: "Markdown",
	yaml: "YAML",
	yml: "YAML",
	toml: "TOML",
	sql: "SQL",
	ini: "TOML",
	conf: "TOML",
};

export function languageFor(path: string, text: string): Language {
	const name = (path.split("/").at(-1) ?? "").toLowerCase();
	const extension = name.includes(".") ? (name.split(".").at(-1) ?? "") : "";
	if (Object.hasOwn(extensions, extension)) return extensions[extension];
	if (/^#![^\n]*\bpython[\d.]*/.test(text)) return "Python";
	if (/^#![^\n]*\b(?:ba|z|fi|da)?sh\b/.test(text) || /^\.(?:bash|zsh)(?:rc|profile)$/.test(name)) return "Shell";
	return "Plain text";
}

type Highlight =
	| "type"
	| "string"
	| "heading"
	| "comment"
	| "tag"
	| "property"
	| "literal"
	| "keyword"
	| "call"
	| "number"
	| "operator";
export type Token = readonly [start: number, end: number, kind: Highlight];
export type LexState = { kind: "fence" | "comment" | "string"; delimiter: string } | { kind: "tag" } | null;
type LexResult = [tokens: Token[], state: LexState];

interface Scanner {
	advance(columns: number): LexResult | undefined;
}

export interface Lexer {
	(line: string, initial: LexState, output?: boolean): LexResult;
	scan(line: string, initial: LexState, output?: boolean): Scanner;
}

export function sameLexState(left: LexState, right: LexState): boolean {
	if (left === right) return true;
	return (
		left?.kind === right?.kind &&
		left !== null &&
		right !== null &&
		(left.kind === "tag" || (right.kind !== "tag" && left.delimiter === right.delimiter))
	);
}

const word = /[\p{L}_$][\p{L}\p{N}_$-]*/uy;
const numeric = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?[\d_]+)?)(?:n)?/y;
const operator = /[{}()[\],:.;=<>+*%&|^~!?/\\-]{1,256}/y;
const htmlTag = /<\/?[!\w:-]+/y;
const property = /\s*:/y;
const lineFlags = /^\s*(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d+\.\s)/;

function quotedEnd(line: string, start: number, delimiter: string, escaped: boolean): number {
	let at = line.indexOf(delimiter, start);
	while (at !== -1) {
		if (!escaped || !escapedAt(line, at, start)) return at + delimiter.length;
		at = line.indexOf(delimiter, at + 1);
	}
	return -1;
}

function escapedAt(line: string, at: number, start: number): boolean {
	let before = at;
	while (before > start && line[before - 1] === "\\") before--;
	return (at - before) % 2 === 1;
}

function markdownLine(line: string, state: LexState): readonly [Highlight, LexState] | undefined {
	const fence = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
	if (state?.kind === "fence") {
		return [fence ? "type" : "string", fence?.startsWith(state.delimiter) ? null : state];
	}
	if (!state && fence) return ["type", { kind: "fence", delimiter: fence }];
	if (!state && lineFlags.test(line)) return ["heading", null];
}

function grammarFor(language: keyof typeof grammars) {
	const [comment, block, words, values] = grammars[language];
	return {
		language,
		comment,
		block,
		endBlock: block === "<!--" ? "-->" : "*/",
		keywords: new Set(words.split(" ")),
		literals: new Set(values.split(" ")),
		html: language === "HTML",
		markdown: language === "Markdown",
		yaml: language === "YAML",
		flexible: ["JavaScript", "TypeScript", "Shell"].includes(language),
		triple: ["Python", "TOML", "Swift"].includes(language),
	};
}

type LexGrammar = ReturnType<typeof grammarFor>;

class LineScanner implements Scanner {
	#at = 0;
	#tokens: Token[] = [];
	#state: LexState;
	#line: string;
	#grammar: LexGrammar;
	#output: boolean;

	constructor(grammar: LexGrammar, line: string, state: LexState, output: boolean) {
		this.#grammar = grammar;
		this.#line = line;
		this.#state = state;
		this.#output = output;
		this.#leadingMarkup();
	}

	advance(columns: number): LexResult | undefined {
		const stop = this.#at + columns;
		while (this.#at < this.#line.length && this.#at < stop) this.#scan();
		if (this.#at === this.#line.length) return [this.#tokens, this.#state];
	}

	#add(end: number, kind?: Highlight): void {
		if (kind && this.#output && this.#at < end) this.#tokens.push([this.#at, end, kind]);
		this.#at = end;
	}

	#leadingMarkup(): void {
		if (!this.#grammar.markdown) return;
		const markup = markdownLine(this.#line, this.#state);
		if (!markup) return;
		const [role, state] = markup;
		this.#add(this.#line.length, role);
		this.#state = state;
	}

	#continued(state: Exclude<LexState, null | { kind: "tag" }>): void {
		const line = this.#line;
		const end =
			state.kind === "comment"
				? line.indexOf(state.delimiter, this.#at) + state.delimiter.length
				: quotedEnd(line, this.#at, state.delimiter, !this.#grammar.html);
		const kind = state.kind === "fence" ? "string" : state.kind;
		if (end < state.delimiter.length) {
			this.#add(line.length, kind);
			return;
		}
		this.#add(end, kind);
		this.#state = null;
	}

	#comment(): boolean {
		const { block, endBlock, comment, yaml } = this.#grammar;
		const line = this.#line;
		const at = this.#at;
		if (block && line.startsWith(block, at)) {
			this.#add(at + block.length, "comment");
			this.#state = { kind: "comment", delimiter: endBlock };
			return true;
		}
		if (comment && line.startsWith(comment, at) && (!yaml || at === 0 || /\s/.test(line[at - 1]))) {
			this.#add(line.length, "comment");
			return true;
		}
		return false;
	}

	#tag(): boolean {
		if (!this.#grammar.html) return false;
		const at = this.#at;
		const line = this.#line;
		if (!this.#state) {
			htmlTag.lastIndex = at;
			if (htmlTag.test(line)) {
				this.#add(htmlTag.lastIndex, "tag");
				this.#state = { kind: "tag" };
			} else this.#add(at + 1);
			return true;
		}
		if (line[at] !== ">") return false;
		this.#add(at + 1, "tag");
		this.#state = null;
		return true;
	}

	#quote(ch: string): void {
		const { flexible, html, language } = this.#grammar;
		const line = this.#line;
		const at = this.#at;
		const triple = this.#grammar.triple && line.startsWith(ch.repeat(3), at);
		const delimiter = triple ? ch.repeat(3) : ch;
		const end = quotedEnd(line, at + delimiter.length, delimiter, !html);
		if (end < 0) {
			this.#add(line.length, "string");
			if (triple || (ch === "`" && flexible)) this.#state = { kind: "string", delimiter };
			return;
		}
		property.lastIndex = end;
		this.#add(end, language === "JSON" && property.test(line) ? "property" : "string");
	}

	#wordRole(value: string, end: number): Highlight | undefined {
		if (!this.#output) return;
		const { language, literals, keywords, html, yaml } = this.#grammar;
		const key = language === "SQL" ? value.toLowerCase() : value;
		if (literals.has(key)) return "literal";
		if (keywords.has(key)) return "keyword";
		const suffix = this.#line.slice(end, end + 24).trimStart();
		if (html || (suffix.startsWith(":") && (language === "CSS" || yaml || !suffix.startsWith("::")))) return "property";
		if (/^[A-Z]/.test(value)) return "type";
		if (suffix.startsWith("(")) return "call";
	}

	#operator(end: number): void {
		const { comment, block, html } = this.#grammar;
		// A punctuation run must not absorb `/*` in `);/*` or `>` in an HTML tag.
		const ahead = this.#line.slice(this.#at + 1, end + (block?.length ?? 1) - 1);
		for (const opener of [comment, block, html ? ">" : null]) {
			const pos = opener ? ahead.indexOf(opener) : -1;
			if (pos !== -1) end = Math.min(end, this.#at + 1 + pos);
		}
		this.#add(end, "operator");
	}

	#scan(): void {
		const at = this.#at;
		const line = this.#line;
		const state = this.#state;
		if (state && state.kind !== "tag") {
			this.#continued(state);
			return;
		}
		const ch = line[at];
		if (ch === " " || ch === "\t") {
			this.#add(at + 1);
			return;
		}
		if (this.#comment() || this.#tag()) return;
		if (ch === '"' || ch === "'" || (ch === "`" && (this.#grammar.flexible || this.#grammar.markdown))) this.#quote(ch);
		else if (this.#grammar.markdown) this.#add(at + 1);
		else this.#code();
	}

	#code(): void {
		const at = this.#at;
		const line = this.#line;
		word.lastIndex = numeric.lastIndex = operator.lastIndex = at;
		const match = word.exec(line);
		if (match) this.#add(word.lastIndex, this.#wordRole(match[0], word.lastIndex));
		else if (numeric.test(line)) this.#add(numeric.lastIndex, "number");
		else if (operator.test(line)) this.#operator(operator.lastIndex);
		else this.#add(at + 1);
	}
}

function grammarName(language: string): language is keyof typeof grammars {
	return Object.hasOwn(grammars, language);
}

export function lexerFor(language: string): Lexer {
	const grammar = grammarName(language) ? grammarFor(language) : null;
	const scan = (line: string, initial: LexState, output = true): Scanner =>
		grammar ? new LineScanner(grammar, line, initial, output) : { advance: () => [[], null] };
	const lex = (line: string, initial: LexState, output = true): LexResult =>
		scan(line, initial, output).advance(Number.POSITIVE_INFINITY) ?? [[], null];
	return Object.assign(lex, { scan });
}
