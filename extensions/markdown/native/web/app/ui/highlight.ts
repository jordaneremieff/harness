(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	// Token kinds, by the Catppuccin style guide's roles: c comment, s string, e escape, regex or
	// interpolation mark, n number or constant, k keyword, t type or annotation, f function, p key or
	// property name, m member, r parameter, b builtin, v variable, o operator, d delimiter, ev enum
	// case, x macro, and ins, del and meta for diff lines.
	type Kind = "c" | "s" | "e" | "n" | "k" | "t" | "f" | "p" | "m" | "r" | "b" | "v" | "o" | "d" | "ev" | "x" | "ins" | "del" | "meta";
	type Token = { text: string; kind?: Kind };
	interface Grammar {
		comment?: string;
		string?: string;
		keywords?: Set<string>;
		constants?: Set<string>;
		builtins?: Set<string>;
		primitives?: Set<string>;
		/** Keywords after which a name is a function whose next parenthesis opens its parameters. */
		definers?: Set<string>;
		/** Keywords after which a name is a type. */
		typers?: Set<string>;
		types?: boolean;
		regex?: boolean;
		annotations?: boolean;
		macros?: boolean;
		enumCases?: boolean;
		properties?: "json";
		interpolation?: "js" | "swift" | "python" | "shell";
		shell?: boolean;
		caseless?: boolean;
		/** Operator and delimiter patterns that replace the defaults; shells keep paths whole. */
		operators?: string;
		delimiters?: string;
	}
	const set = (words: string) => new Set(words.split(" "));
	const END = String.raw`(?![\s\S])`;
	const C_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|${END})`;
	const BLOCK_COMMENT = String.raw`\/\*[\s\S]*?(?:\*\/|${END})`;
	const HASH_COMMENT = String.raw`(?:^|(?<=\s))#[^\n]*`;
	const DASH_COMMENT = String.raw`--[^\n]*`;
	const QUOTED = String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
	const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+n?|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[nfFdDlLuU]*)\b`;
	const REGEX = String.raw`(?<=(?:^|[=(,:\[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase)\s*)\/(?![*/])(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[dgimsuyv]*`;
	const VARIABLE = String.raw`\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[\d@#?*!$-]`;
	const FLAG = String.raw`(?<=^|[\s=])--?[A-Za-z][\w-]*`;
	const OPERATOR = String.raw`===|!==|=>|->|\.\.\.|\?\?=?|\?\.|&&=?|\|\|=?|<<=?|>>>?=?|<=|>=|==|!=|::|\+\+|[-+*/%=&|^~!<>?:]=?`;
	const DELIMITER = String.raw`[()[\]{},;.@#$]`;
	const js: Grammar = {
		comment: C_COMMENT,
		string: `${QUOTED}|\`(?:\\\\.|[^\`\\\\])*\`?`,
		keywords: set(
			"abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of override private protected public readonly return satisfies set static switch throw try type typeof var void while with yield",
		),
		constants: set("true false null undefined NaN Infinity"),
		builtins: set("this super console window document globalThis process require module exports Math JSON Object Array Number String Boolean Symbol Reflect Intl"),
		primitives: set("string number boolean any unknown never object bigint symbol"),
		definers: set("function"),
		typers: set("class interface type enum extends implements new namespace"),
		types: true,
		regex: true,
		annotations: true,
		interpolation: "js",
	};
	const cLike: Grammar = {
		comment: C_COMMENT,
		string: QUOTED,
		keywords: set(
			"abstract auto break case catch char class const continue default delete do double else enum extends extern final finally float for fun goto if implements import inline int interface internal long namespace new object override package private protected public return short signed sizeof static struct switch template throw throws try typedef typename union unsigned using val var virtual void volatile when while",
		),
		constants: set("true false null nullptr NULL"),
		builtins: set("this super self std printf println System"),
		definers: set("fun"),
		typers: set("class struct interface enum extends implements new object"),
		types: true,
		annotations: true,
	};
	const grammars: Record<string, Grammar> = {
		js,
		clike: cLike,
		json: { comment: C_COMMENT, string: QUOTED, constants: set("true false null"), properties: "json" },
		swift: {
			comment: C_COMMENT,
			string: String.raw`"""[\s\S]*?(?:"""|${END})|${QUOTED}`,
			keywords: set(
				"actor any as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonisolated open operator override package private protocol public repeat rethrows return some static struct subscript switch throw throws try typealias var weak where while",
			),
			constants: set("true false nil"),
			builtins: set("self Self super print"),
			definers: set("func init subscript"),
			typers: set("class struct enum protocol extension actor typealias"),
			types: true,
			annotations: true,
			enumCases: true,
			interpolation: "swift",
		},
		python: {
			comment: HASH_COMMENT,
			string: String.raw`[rbfuRBFU]{0,2}(?:"""[\s\S]*?(?:"""|${END})|'''[\s\S]*?(?:'''|${END})|${QUOTED})`,
			keywords: set(
				"and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield",
			),
			constants: set("True False None"),
			builtins: set("self cls super print len range open isinstance enumerate zip map filter sorted"),
			primitives: set("int str bool float list dict set tuple bytes object"),
			definers: set("def"),
			typers: set("class"),
			types: true,
			annotations: true,
			interpolation: "python",
		},
		shell: {
			comment: HASH_COMMENT,
			string: QUOTED,
			keywords: set("if then else elif fi for in while until do done case esac function return export local readonly declare set unset select time"),
			builtins: set("cd echo printf source alias exit eval exec read test true false shift trap wait"),
			shell: true,
			operators: String.raw`&&|\|\||>>|<<|[|&;<>!=]`,
			delimiters: String.raw`[()[\]{}]`,
			interpolation: "shell",
		},
		rust: {
			comment: C_COMMENT,
			string: QUOTED,
			keywords: set(
				"as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct trait type unsafe use where while",
			),
			constants: set("true false None"),
			builtins: set("self Self super Some Ok Err"),
			primitives: set("i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str"),
			definers: set("fn"),
			typers: set("struct enum trait impl type"),
			types: true,
			macros: true,
		},
		go: {
			comment: C_COMMENT,
			string: `${QUOTED}|\`[^\`]*\`?`,
			keywords: set(
				"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
			),
			constants: set("true false nil iota"),
			builtins: set("append cap close copy delete len make new panic print println recover"),
			primitives: set("bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr any"),
			definers: set("func"),
			typers: set("type struct"),
			types: true,
		},
		sql: {
			comment: `${DASH_COMMENT}|${BLOCK_COMMENT}`,
			string: String.raw`'(?:''|[^'\n])*'?`,
			keywords: set(
				"select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on as group by order having limit offset distinct union all case when then else end with primary key foreign references default unique is in like between exists returning",
			),
			constants: set("null true false"),
			builtins: set("count sum avg min max coalesce now"),
			primitives: set("int integer text varchar char boolean bigint real date timestamp json jsonb"),
			caseless: true,
		},
		ruby: {
			comment: HASH_COMMENT,
			string: QUOTED,
			keywords: set(
				"alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return then unless until when while yield require",
			),
			constants: set("true false nil"),
			builtins: set("self super puts print"),
			definers: set("def"),
			typers: set("class module"),
			types: true,
		},
		lua: {
			comment: DASH_COMMENT,
			string: QUOTED,
			keywords: set("and break do else elseif end for function goto if in local not or repeat return then until while"),
			constants: set("true false nil"),
			builtins: set("self print pairs ipairs require table string math"),
			definers: set("function"),
		},
	};
	const aliases: Record<string, string> = {
		javascript: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", typescript: "js", tsx: "js", mts: "js", cts: "js",
		jsonc: "json", json5: "json", py: "python", sh: "shell", bash: "shell", zsh: "shell", console: "shell",
		shellscript: "shell", fish: "shell", rs: "rust", golang: "go", rb: "ruby", c: "clike", h: "clike", cpp: "clike",
		hpp: "clike", cc: "clike", java: "clike", kotlin: "clike", kt: "clike", cs: "clike", csharp: "clike",
		scala: "clike", dart: "clike", php: "clike", "objective-c": "clike",
	};
	const special: Record<string, (text: string) => Token[]> = {};
	const name = (language: string) => language.trim().toLowerCase();

	function scan(text: string, pattern: RegExp, kind: (match: RegExpExecArray) => Kind | undefined): Token[] {
		const tokens: Token[] = [];
		let last = 0;
		pattern.lastIndex = 0;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			if (!match[0]) {
				pattern.lastIndex++;
				continue;
			}
			const found = kind(match);
			if (!found) continue;
			if (match.index > last) tokens.push({ text: text.slice(last, match.index) });
			tokens.push({ text: match[0], kind: found });
			last = match.index + match[0].length;
		}
		if (last < text.length) tokens.push({ text: text.slice(last) });
		return tokens;
	}
	/** The kind of the first participating capture group, by group number. */
	function groupOf(match: RegExpExecArray, kinds: (Kind | undefined)[]): Kind | undefined {
		return kinds[match.findIndex((group, index) => index > 0 && group !== undefined)];
	}

	// Strings: escapes and interpolation marks in pink, the code inside an interpolation coloured
	// by its own language, and the rest in green.
	const OPENERS: Record<NonNullable<Grammar["interpolation"]>, RegExp> = {
		js: /\\(?:u\{[\da-fA-F]+\}|.)|\$\{/gsu,
		swift: /\\\(|\\(?:u\{[\da-fA-F]+\}|.)/gsu,
		python: /\\(?:N\{[^}]*\}|.)|\{\{|\}\}|\{/gsu,
		shell: /\\.|\$\(|\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[\d@#?*!$-]/gsu,
	};
	const ESCAPES = /\\(?:u\{[\da-fA-F]+\}|.)/gsu;
	function closing(text: string, from: number, open: string, close: string) {
		let depth = 1;
		for (let index = from; index < text.length; index++) {
			if (text[index] === open) depth++;
			else if (text[index] === close && --depth === 0) return index;
		}
		return -1;
	}
	function interpolates(text: string, grammar: Grammar) {
		if (grammar.interpolation === "js") return text.startsWith("`");
		if (grammar.interpolation === "python") return /^[rbuRBU]*[fF]/u.test(text);
		if (grammar.interpolation === "shell") return text.startsWith('"');
		return grammar.interpolation === "swift";
	}
	function markKind(mark: string): Kind {
		return mark.startsWith("$") && mark !== "$(" && mark !== "${" ? "v" : "e";
	}
	/** Whether a mark opens an interpolation, and where its closing bracket is. */
	function interpolation(text: string, mark: string, start: number) {
		const open = /[({]$/u.test(mark) && !["{{", "}}"].includes(mark) && !/^\\[^(]/u.test(mark);
		if (!open) return { open, end: -1 };
		const round = mark.endsWith("(");
		return { open, end: closing(text, start + mark.length, round ? "(" : "{", round ? ")" : "}") };
	}
	/** The tokens of one mark inside a string, and the offset after it. */
	function markTokens(text: string, mark: string, start: number, grammar: Grammar, depth: number): [Token[], number] {
		const { open, end } = interpolation(text, mark, start);
		if (!open || end < 0 || depth >= 3) return [[{ text: mark, kind: open ? "e" : markKind(mark) }], start + mark.length];
		const inner = code(text.slice(start + mark.length, end), grammar, depth + 1);
		return [[{ text: mark, kind: "e" }, ...inner, { text: text[end], kind: "e" }], end + 1];
	}
	function stringTokens(text: string, grammar: Grammar, depth: number): Token[] {
		const opener = grammar.interpolation && interpolates(text, grammar) ? OPENERS[grammar.interpolation] : ESCAPES;
		const tokens: Token[] = [];
		let last = 0;
		opener.lastIndex = 0;
		for (let match = opener.exec(text); match; match = opener.exec(text)) {
			if (match.index > last) tokens.push({ text: text.slice(last, match.index), kind: "s" });
			const [marks, next] = markTokens(text, match[0], match.index, grammar, depth);
			tokens.push(...marks);
			last = next;
			opener.lastIndex = last;
		}
		if (last < text.length) tokens.push({ text: text.slice(last), kind: "s" });
		return tokens;
	}

	// Code: one pass over comments, strings, regular expressions, variables, flags, numbers,
	// annotations, words, operators and delimiters, with the context that tells a definition, a
	// parameter, a member or a command apart.
	interface State {
		grammar: Grammar;
		text: string;
		previous: string[];
		pending?: "f" | "t";
		parameters: number;
		expectParameters: boolean;
		command: boolean;
		lastKind?: Kind;
	}
	const patterns = new WeakMap<Grammar, RegExp>();
	function patternOf(grammar: Grammar) {
		let pattern = patterns.get(grammar);
		if (pattern) return pattern;
		const never = "(?!)";
		const part = (enabled: unknown, source: string) => (enabled ? source : never);
		pattern = new RegExp(
			[
				part(grammar.comment, grammar.comment ?? ""),
				part(grammar.string, grammar.string ?? ""),
				part(grammar.regex, REGEX),
				part(grammar.shell, VARIABLE),
				part(grammar.shell, FLAG),
				NUMBER,
				part(grammar.annotations, String.raw`@[A-Za-z_][\w.]*`),
				String.raw`[A-Za-z_][\w$]*`,
				grammar.operators ?? OPERATOR,
				grammar.delimiters ?? DELIMITER,
			]
				.map((source) => `(${source})`)
				.join("|"),
			"gmu",
		);
		patterns.set(grammar, pattern);
		return pattern;
	}
	const SEPARATORS = new Set(["|", "||", "&&", ";", "(", "{", "!", "if", "while", "until", "then", "do", "else", "elif"]);
	function memberKind(state: State, rest: string): Kind {
		if (/^\s*\(/u.test(rest)) return "f";
		const before = state.previous.at(-2) ?? "";
		const receiver = /^[\w$)\]"'`]/u.test(before.slice(-1));
		return state.grammar.enumCases && !receiver ? "ev" : "m";
	}
	function namedKind(word: string, grammar: Grammar): Kind | undefined {
		const key = grammar.caseless ? word.toLowerCase() : word;
		if (grammar.keywords?.has(key)) return "k";
		if (grammar.constants?.has(key)) return "n";
		if (grammar.builtins?.has(key)) return "b";
		return grammar.primitives?.has(key) ? "t" : undefined;
	}
	function parameterKind(state: State, rest: string): Kind | undefined {
		const previous = state.previous.at(-1);
		if (state.parameters === 1 && (previous === "(" || previous === "," || state.lastKind === "r")) return "r";
		return /^\s*=>/u.test(rest) ? "r" : undefined;
	}
	function shellKind(state: State, rest: string): Kind | undefined {
		if (/^=/u.test(rest)) return "v";
		return state.command ? "f" : undefined;
	}
	/** A call: a capitalised name constructs a type, any other name calls a function. */
	function callKind(word: string, state: State, rest: string): Kind | undefined {
		if (!/^\s*\(/u.test(rest) || state.expectParameters) return undefined;
		return state.grammar.types && /^[A-Z]/u.test(word) && /[a-z]/u.test(word) ? "t" : "f";
	}
	function contextKind(word: string, state: State, rest: string): Kind | undefined {
		const previous = state.previous.at(-1);
		if (previous === "." || previous === "?.") return memberKind(state, rest);
		if (state.grammar.shell) return shellKind(state, rest);
		if (state.grammar.macros && /^!(?!=)/u.test(rest)) return "x";
		return callKind(word, state, rest) ?? parameterKind(state, rest);
	}
	function wordKind(word: string, state: State, rest: string): Kind | undefined {
		if (state.pending) return state.pending;
		const named = namedKind(word, state.grammar);
		if (named === "k" || (named && state.previous.at(-1) !== ".")) return named;
		const contextual = contextKind(word, state, rest);
		if (contextual) return contextual;
		if (!state.grammar.types || !/^[A-Z]/u.test(word)) return undefined;
		return /[a-z]/u.test(word) ? "t" : "n";
	}
	function arrowAhead(text: string, from: number) {
		const end = closing(text, from, "(", ")");
		return end > 0 && end - from < 400 && /^\s*(?::[^=;{}()]*)?=>/u.test(text.slice(end + 1, end + 120));
	}
	function delimiterUpdate(token: string, state: State, index: number) {
		if (token === "(") {
			if (state.expectParameters) state.parameters = 1;
			else if (state.parameters > 0) state.parameters++;
			else if (state.grammar.regex && arrowAhead(state.text, index + 1)) state.parameters = 1;
			state.expectParameters = false;
		} else if (token === ")" && state.parameters > 0) state.parameters--;
	}
	function groupKind(match: RegExpExecArray): Kind | undefined {
		const kinds: (Kind | undefined)[] = [undefined, "c", "s", "e", "v", "r", "n", "t", undefined, "o", "d"];
		return groupOf(match, kinds);
	}
	function after(token: string, kind: Kind | undefined, state: State) {
		state.previous.push(token);
		if (state.previous.length > 3) state.previous.shift();
		state.lastKind = kind;
		if (kind === "k" && state.grammar.definers?.has(token)) {
			state.pending = "f";
			state.expectParameters = true;
		} else if (kind === "k" && state.grammar.typers?.has(token)) state.pending = "t";
		else if (state.pending && kind !== "k") state.pending = undefined;
		if (state.grammar.shell) state.command = SEPARATORS.has(token);
	}
	/** The tokens of one match, after which the state knows it. */
	function matchTokens(match: RegExpExecArray, state: State, rest: string, depth: number): Token[] {
		const token = match[0],
			kind = match[8] === undefined ? groupKind(match) : wordKind(token, state, rest);
		if (kind === "d" || kind === "o") delimiterUpdate(token, state, match.index);
		if (kind !== "c") after(token, kind, state);
		return kind === "s" ? propertyOrString(token, state.grammar, rest, depth) : [{ text: token, kind }];
	}
	function code(text: string, grammar: Grammar, depth = 0): Token[] {
		const state: State = { grammar, text, previous: [], parameters: 0, expectParameters: false, command: true };
		const pattern = new RegExp(patternOf(grammar).source, "gmu"),
			tokens: Token[] = [];
		let last = 0;
		for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
			const gap = text.slice(last, match.index);
			if (gap) tokens.push({ text: gap });
			if (grammar.shell && gap.includes("\n")) state.command = true;
			tokens.push(...matchTokens(match, state, text.slice(pattern.lastIndex, pattern.lastIndex + 120), depth));
			last = pattern.lastIndex;
		}
		if (last < text.length) tokens.push({ text: text.slice(last) });
		return tokens;
	}
	function propertyOrString(token: string, grammar: Grammar, rest: string, depth: number): Token[] {
		if (grammar.properties === "json" && /^\s*:/u.test(rest)) return [{ text: token, kind: "p" }];
		return stringTokens(token, grammar, depth);
	}

	// Languages with their own small scanners.
	special.diff = (text) =>
		scan(text, /^(?:\+\+\+|---|@@|diff |index |\+|-)[^\n]*/gmu, (match) =>
			/^(?:\+\+\+|---|@@|diff |index )/u.test(match[0]) ? "meta" : match[0].startsWith("+") ? "ins" : "del",
		);
	special.markdown = (text) =>
		scan(text, /^(#{1,6} [^\n]*)|^([ \t]*(?:[-*+]|\d+\.)[ \t])|(`[^`\n]+`)|(\[[^\]\n]*\]\([^)\n]*\))|(\*\*[^*\n]+\*\*)/gmu, (match) =>
			groupOf(match, [undefined, "k", "d", "s", "f", "t"]),
		);
	special.markup = (text) =>
		scan(
			text,
			/(<!--[\s\S]*?(?:-->|$))|(<\/?|\/?>)|(?<=<\/?)([\w:.-]+)|([\w:.-]+)(?=\s*=)|("[^"\n]*"?|'[^'\n]*'?)|(&[#\w]+;)|(=)/gu,
			(match) => groupOf(match, [undefined, "c", "d", "f", "t", "s", "e", "o"]),
		);
	special.yaml = (text) =>
		scan(
			text,
			/((?:^|(?<=\s))#[^\n]*)|^(\s*-(?=\s))|(?<=^\s*(?:-\s+)?)([^\s:#"'][^:#\n]*?)(?=\s*:(?:\s|$))|("(?:\\.|[^"\\\n])*"?|'[^'\n]*'?)|(?<=:\s+)(true|false|null|yes|no|on|off|~|-?\d[\d_.]*)(?=\s*(?:#|$))|(?<=:\s+)([^\s#"'|>&*!{[][^#\n]*?)(?=\s*(?:#|$))/gmu,
			(match) => groupOf(match, [undefined, "c", "d", "p", "s", "n", "s"]),
		);
	special.css = (text) =>
		scan(
			text,
			/(\/\*[\s\S]*?(?:\*\/|$))|("(?:\\.|[^"\\\n])*"?|'[^'\n]*'?)|(@[\w-]+|!important)|(--[\w-]+)|([\w-]+)(?=\s*:[^:{};]*[;}])|((?<![\w-])(?:#[\da-fA-F]{3,8}\b|-?\d*\.?\d+(?:%|[a-z]+)?))|([\w-]+)(?=\()|(\.[\w-]+|#[\w-]+)|([{}();,:])/gu,
			(match) => groupOf(match, [undefined, "c", "s", "k", "v", "p", "n", "f", "t", "d"]),
		);
	const SPECIAL: Record<string, string> = {
		diff: "diff", patch: "diff", md: "markdown", markdown: "markdown", html: "markup", xml: "markup", svg: "markup",
		xhtml: "markup", plist: "markup", vue: "markup", yaml: "yaml", yml: "yaml", toml: "yaml", ini: "yaml",
		"front matter": "yaml", css: "css", scss: "css", less: "css",
	};
	/** A language for an unlabelled block whose text identifies it: JSON or a shell transcript. */
	function detect(text: string) {
		const trimmed = text.trim();
		if (/^[[{]/u.test(trimmed) && /[\]}]$/u.test(trimmed)) {
			try {
				JSON.parse(trimmed);
				return "json";
			} catch {}
		}
		return /^\$ \S/mu.test(text) ? "shell" : "";
	}

	/** The key of the scanner or grammar that colours a language label, or "" when none does. */
	function canonical(language: string) {
		const key = name(language);
		if (Object.hasOwn(SPECIAL, key)) return SPECIAL[key];
		if (Object.hasOwn(special, key)) return key;
		const grammar = Object.hasOwn(aliases, key) ? aliases[key] : key;
		return Object.hasOwn(grammars, grammar) ? grammar : "";
	}
	// One choice for each scanner and grammar, by the name a person knows it by.
	const choices = [
		{ id: "clike", label: "C family" },
		{ id: "css", label: "CSS" },
		{ id: "diff", label: "Diff" },
		{ id: "go", label: "Go" },
		{ id: "markup", label: "HTML / XML" },
		{ id: "json", label: "JSON" },
		{ id: "lua", label: "Lua" },
		{ id: "markdown", label: "Markdown" },
		{ id: "python", label: "Python" },
		{ id: "ruby", label: "Ruby" },
		{ id: "rust", label: "Rust" },
		{ id: "shell", label: "Shell" },
		{ id: "sql", label: "SQL" },
		{ id: "swift", label: "Swift" },
		{ id: "js", label: "TypeScript / JavaScript" },
		{ id: "yaml", label: "YAML / TOML" },
	] as const;

	api.syntax = {
		supports: (language) => !!canonical(language),
		tokens(text, language) {
			const key = canonical(language);
			if (special[key]) return special[key](text);
			return key ? code(text, grammars[key]) : [{ text }];
		},
		detect,
		canonical,
		choices,
	};

	// Colours the code of rendered code figures by a chosen syntax, else by their language label or
	// by the text of an unlabelled block. Only spans are added around existing text, so the visible
	// text and its source offsets stay unchanged; a new choice unwraps them first.
	const LIMIT = 200_000;
	function colourText(node: Text, language: string) {
		if (node.data.length > LIMIT) return;
		const tokens = api.syntax.tokens(node.data, language);
		if (!tokens.some((token) => token.kind)) return;
		const owner = node.ownerDocument,
			fragment = owner.createDocumentFragment();
		for (const token of tokens) {
			if (!token.kind) {
				fragment.append(token.text);
				continue;
			}
			const span = owner.createElement("span");
			span.className = `syn-${token.kind}`;
			span.textContent = token.text;
			fragment.append(span);
		}
		node.replaceWith(fragment);
	}
	function automatic(figure: HTMLElement, block: HTMLElement) {
		return canonical(figure.querySelector(":scope > figcaption .lang")?.textContent ?? "") || detect(block.textContent ?? "");
	}
	function uncolour(block: HTMLElement) {
		for (const span of block.querySelectorAll("span[class^='syn-']")) span.replaceWith(span.textContent ?? "");
		block.normalize();
		delete block.dataset.highlighted;
	}
	function colour(block: HTMLElement, key: string) {
		block.dataset.highlighted = key;
		const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT),
			nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
		for (const node of nodes) colourText(node, key);
	}
	function colourFigure(figure: HTMLElement, language?: string) {
		const block = figure.querySelector<HTMLElement>(":scope > pre > code");
		if (!block) return "";
		const key = language === undefined ? automatic(figure, block) : canonical(language);
		if ((block.dataset.highlighted ?? "") === key) return key;
		if (block.dataset.highlighted !== undefined) uncolour(block);
		if (key) colour(block, key);
		return key;
	}
	api.highlightCode = (root) => {
		for (const figure of root.querySelectorAll<HTMLElement>("figure.code")) colourFigure(figure);
	};
	api.colourCode = colourFigure;
})();
