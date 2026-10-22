// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { blank } from "./views.mts";

const PRAGMA =
	/^\s*(?:@ts-|eslint|biome-ignore|prettier-ignore|istanbul|c8\b|v8\b|#region|#endregion|@vitest|@jsx|<reference|!|@license|@preserve|@__PURE__)/;
const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "delete", "void", "throw", "in", "of", "instanceof", "new", "else", "do", "yield", "await"]);

/** Walks source text once and copies comment characters into a same-length buffer. */
class CommentScanner {
	readonly text: string;
	readonly out: string[];
	private i = 0;
	private prevSig = "";
	private prevWord = "";
	private braceDepth = 0;
	private readonly templateStack: number[] = [];

	constructor(text: string) {
		this.text = text;
		this.out = text.split("").map((ch) => (ch === "\n" ? "\n" : " "));
	}

	run(): string {
		if (this.text.startsWith("#!")) {
			const nl = this.text.indexOf("\n");
			this.i = nl === -1 ? this.text.length : nl;
		}
		while (this.i < this.text.length) this.step();
		return this.out.join("");
	}

	private keep(from: number, to: number): void {
		for (let k = from; k < to; k++) this.out[k] = this.text[k] ?? " ";
	}

	private step(): void {
		const ch = this.text[this.i] ?? "";
		const next = this.text[this.i + 1];
		if (ch === "/" && next === "/") this.lineComment();
		else if (ch === "/" && next === "*") this.blockComment();
		else if (ch === '"' || ch === "'") this.quoted(ch);
		else if (ch === "`") this.template(1);
		else if (ch === "{" || ch === "}") this.brace(ch);
		else if (ch === "/") this.slash();
		else if (/\s/.test(ch)) this.i += 1;
		else if (/[\w$]/.test(ch)) this.word();
		else this.punctuation(ch);
	}

	private lineComment(): void {
		const nl = this.text.indexOf("\n", this.i);
		const end = nl === -1 ? this.text.length : nl;
		if (!PRAGMA.test(this.text.slice(this.i + 2, end))) this.keep(this.i + 2, end);
		this.i = end;
	}

	private blockComment(): void {
		const close = this.text.indexOf("*/", this.i + 2);
		const end = close === -1 ? this.text.length : close;
		const body = this.text.slice(this.i + 2, end);
		if (!PRAGMA.test(body.replace(/^\*+/, ""))) {
			this.keep(this.i + 2, end);
			this.blankLeadingStars(this.i + 2, end);
			if (this.text[this.i + 2] === "*") this.out[this.i + 2] = " ";
		}
		this.i = close === -1 ? this.text.length : close + 2;
	}

	private blankLeadingStars(from: number, end: number): void {
		let k = from;
		while (k < end) {
			const nl = this.text.indexOf("\n", k);
			const lineEnd = nl === -1 || nl > end ? end : nl;
			let p = k;
			while (p < lineEnd && /[ \t]/.test(this.text[p] ?? "")) p += 1;
			if (this.text[p] === "*") this.out[p] = " ";
			k = lineEnd + 1;
		}
	}

	private quoted(quote: string): void {
		this.i += 1;
		while (this.i < this.text.length && this.text[this.i] !== quote && this.text[this.i] !== "\n") {
			this.i += this.text[this.i] === "\\" ? 2 : 1;
		}
		this.i += 1;
		this.prevSig = quote;
		this.prevWord = "";
	}

	/** Scan template text from the current offset plus `skip`, stopping at its end or at an expression start. */
	private template(skip: number): void {
		this.i += skip;
		while (this.i < this.text.length) {
			if (this.templateStep()) return;
		}
	}

	/** Advance one template character. Returns true when the template text ends here. */
	private templateStep(): boolean {
		const ch = this.text[this.i];
		if (ch === "\\") {
			this.i += 2;
			return false;
		}
		if (ch === "`") {
			this.i += 1;
			this.prevSig = "`";
			return true;
		}
		if (ch === "$" && this.text[this.i + 1] === "{") {
			this.templateStack.push(this.braceDepth);
			this.braceDepth += 1;
			this.i += 2;
			this.prevSig = "{";
			return true;
		}
		this.i += 1;
		return false;
	}

	private brace(ch: string): void {
		this.i += 1;
		if (ch === "{") {
			this.braceDepth += 1;
			this.prevSig = "{";
			return;
		}
		this.braceDepth -= 1;
		if (this.templateStack[this.templateStack.length - 1] === this.braceDepth) {
			this.templateStack.pop();
			this.template(0);
		} else {
			this.prevSig = "}";
		}
	}

	private slash(): void {
		const regexAllowed = REGEX_PRECEDERS.has(this.prevSig) || (/\w/.test(this.prevSig) && REGEX_KEYWORDS.has(this.prevWord));
		this.i += 1;
		this.prevSig = "/";
		if (regexAllowed) this.regexLiteral();
	}

	/** Skip a regular expression literal body and its flags. */
	private regexLiteral(): void {
		let inClass = false;
		while (this.i < this.text.length && this.text[this.i] !== "\n") {
			const c = this.text[this.i];
			if (c === "/" && !inClass) break;
			if (c === "[") inClass = true;
			if (c === "]") inClass = false;
			this.i += c === "\\" ? 2 : 1;
		}
		this.i += 1;
		while (this.i < this.text.length && /[a-z]/i.test(this.text[this.i] ?? "")) this.i += 1;
		this.prevWord = "";
	}

	private word(): void {
		let k = this.i;
		while (k < this.text.length && /[\w$]/.test(this.text[k] ?? "")) k += 1;
		this.prevWord = this.text.slice(this.i, k);
		this.prevSig = "a";
		this.i = k;
	}

	private punctuation(ch: string): void {
		this.prevSig = ch;
		this.prevWord = "";
		this.i += 1;
	}
}

/** Collect comment text from TypeScript or JavaScript source with all other characters blank. */
export function sourceComments(text: string): string {
	return new CommentScanner(text).run();
}

const TAGGED = /\{@\w+[^}\n]*\}|@\w+|\{[^{}\n]*\}/g;
const PARAM = /^\s*@(?:param|property|prop|arg|argument|template|typedef)\b\s*(?:\{[^}]*\}\s*)?(\[?[\w.$]+\]?)/;

/** Blank JSDoc tags, type braces, parameter names and example blocks inside comment text. */
export function cleanSourceComments(comments: string): string {
	const view = comments.split("");
	let offset = 0;
	let inExample = false;
	for (const line of comments.split("\n")) {
		if (line.trim().startsWith("@")) inExample = /^@example\b/.test(line.trim());
		if (inExample) {
			blank(view, offset, offset + line.length);
		} else {
			blankTags(view, line, offset);
		}
		offset += line.length + 1;
	}
	return view.join("");
}

function blankTags(view: string[], line: string, offset: number): void {
	for (const match of line.matchAll(TAGGED)) blank(view, offset + match.index, offset + match.index + match[0].length);
	const name = PARAM.exec(line)?.[1];
	if (name === undefined) return;
	const at = line.indexOf(name);
	if (at !== -1) blank(view, offset + at, offset + at + name.length);
}
