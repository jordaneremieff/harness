(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	type Kind = "c" | "s" | "n" | "k" | "t" | "f" | "p" | "v" | "a" | "ins" | "del" | "meta";
	type Token = { text: string; kind?: Kind };
	interface Grammar {
		/** Regular expression sources; each match keeps its exact text. */
		comment?: string;
		string?: string;
		keywords?: Set<string>;
		constants?: Set<string>;
		/** Capitalised identifiers are types. */
		types?: boolean;
		/** Names before a colon are properties: quoted keys, line-leading keys or declarations. */
		properties?: "json" | "yaml" | "css";
		variables?: boolean;
		caseless?: boolean;
	}
	const set = (words: string) => new Set(words.split(" "));
	const C_COMMENT = String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`;
	const BLOCK_COMMENT = String.raw`\/\*[\s\S]*?(?:\*\/|$)`;
	const HASH_COMMENT = String.raw`(?:^|(?<=\s))#[^\n]*`;
	const DASH_COMMENT = String.raw`--[^\n]*`;
	const QUOTED = String.raw`"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?`;
	const NUMBER = String.raw`\b(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)\b`;
	const WORD = String.raw`[A-Za-z_@][\w$]*`;
	const VARIABLE = String.raw`\$\{[^}\n]*\}?|\$[A-Za-z_]\w*|\$[\d@#?*!$-]`;
	const js: Grammar = {
		comment: C_COMMENT,
		string: `${QUOTED}|\`(?:\\\\.|[^\`\\\\])*\`?`,
		keywords: set(
			"abstract as async await break case catch class const continue debugger declare default delete do else enum export extends finally for from function get if implements import in infer instanceof interface keyof let namespace new of override private protected public readonly return satisfies set static super switch this throw try type typeof var void while with yield",
		),
		constants: set("true false null undefined NaN Infinity"),
		types: true,
	};
	const cLike: Grammar = {
		comment: C_COMMENT,
		string: QUOTED,
		keywords: set(
			"abstract auto break case catch char class const continue default delete do double else enum extends extern final finally float for fun goto if implements import inline int interface internal long namespace new object override package private protected public return short signed sizeof static struct super switch template this throw throws try typedef typename union unsigned using val var virtual void volatile when while",
		),
		constants: set("true false null nullptr NULL"),
		types: true,
	};
	const grammars: Record<string, Grammar> = {
		js,
		json: { comment: C_COMMENT, string: QUOTED, constants: set("true false null"), properties: "json" },
		swift: {
			comment: C_COMMENT,
			string: String.raw`"""[\s\S]*?(?:"""|$)|${QUOTED}`,
			keywords: set(
				"actor any as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonisolated open operator override package private protocol public repeat rethrows return self Self some static struct subscript super switch throw throws try typealias var weak where while",
			),
			constants: set("true false nil"),
			types: true,
		},
		python: {
			comment: HASH_COMMENT,
			string: String.raw`[rbfuRBFU]{0,2}(?:"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${QUOTED})`,
			keywords: set(
				"and as assert async await break class continue def del elif else except finally for from global if import in is lambda match case nonlocal not or pass raise return try while with yield self",
			),
			constants: set("True False None"),
			types: true,
		},
		shell: {
			comment: HASH_COMMENT,
			string: QUOTED,
			keywords: set(
				"if then else elif fi for in while until do done case esac function return export local readonly declare set unset source alias exit select time",
			),
			variables: true,
		},
		css: {
			comment: BLOCK_COMMENT,
			string: QUOTED,
			keywords: set("@media @import @supports @keyframes @layer @container @font-face @page @property !important"),
			properties: "css",
		},
		yaml: { comment: HASH_COMMENT, string: QUOTED, constants: set("true false null yes no on off"), properties: "yaml" },
		rust: {
			comment: C_COMMENT,
			string: QUOTED,
			keywords: set(
				"as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while",
			),
			constants: set("true false None Some Ok Err"),
			types: true,
		},
		go: {
			comment: C_COMMENT,
			string: `${QUOTED}|\`[^\`]*\`?`,
			keywords: set(
				"break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
			),
			constants: set("true false nil iota"),
			types: true,
		},
		sql: {
			comment: `${DASH_COMMENT}|${BLOCK_COMMENT}`,
			string: String.raw`'(?:''|[^'\n])*'?`,
			keywords: set(
				"select from where and or not insert into values update set delete create table index view drop alter add join left right inner outer on as group by order having limit offset distinct union all case when then else end with primary key foreign references default unique",
			),
			constants: set("null true false"),
			caseless: true,
		},
		ruby: {
			comment: HASH_COMMENT,
			string: QUOTED,
			keywords: set(
				"alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then unless until when while yield require",
			),
			constants: set("true false nil"),
			types: true,
		},
		lua: {
			comment: DASH_COMMENT,
			string: QUOTED,
			keywords: set("and break do else elseif end for function goto if in local not or repeat return then until while"),
			constants: set("true false nil"),
		},
		clike: cLike,
	};
	const aliases: Record<string, string> = {
		javascript: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", typescript: "js", tsx: "js", mts: "js", cts: "js",
		jsonc: "json", json5: "json",
		py: "python", sh: "shell", bash: "shell", zsh: "shell", console: "shell", shellscript: "shell", fish: "shell",
		scss: "css", less: "css", yml: "yaml", toml: "yaml", ini: "yaml", "front matter": "yaml", rs: "rust", golang: "go",
		rb: "ruby", c: "clike", h: "clike", cpp: "clike", hpp: "clike", cc: "clike", java: "clike", kotlin: "clike",
		kt: "clike", cs: "clike", csharp: "clike", scala: "clike", dart: "clike", php: "clike", "objective-c": "clike",
	};
	const MARKUP = new Set(["html", "xml", "svg", "xhtml", "plist", "vue"]);
	const DIFF = new Set(["diff", "patch"]);
	const MARKDOWN = new Set(["md", "markdown"]);
	const name = (language: string) => language.trim().toLowerCase();
	const grammarOf = (language: string) => grammars[aliases[name(language)] ?? name(language)];

	function namedKind(word: string, grammar: Grammar): Kind | undefined {
		const key = grammar.caseless ? word.toLowerCase() : word;
		if (grammar.keywords?.has(key)) return "k";
		return grammar.constants?.has(key) ? "n" : undefined;
	}
	function wordKind(word: string, grammar: Grammar, rest: string): Kind | undefined {
		const named = namedKind(word, grammar);
		if (named) return named;
		if (/^\s*\(/u.test(rest)) return "f";
		if (grammar.properties === "css" && /^\s*:/u.test(rest)) return "p";
		if (!grammar.types || !/^[A-Z]/u.test(word)) return undefined;
		return /[a-z]/u.test(word) ? "t" : "n";
	}
	/** The kind of the first participating capture group, by group number. */
	function groupOf(match: RegExpExecArray, kinds: (Kind | undefined)[]): Kind | undefined {
		return kinds[match.findIndex((group, index) => index > 0 && group !== undefined)];
	}
	function lineStart(text: string, index: number) {
		return /^[ \t]*(?:- )?$/u.test(text.slice(text.lastIndexOf("\n", index - 1) + 1, index));
	}
	// Groups in order: comment, string, variable, number; a match without a group is a word.
	function groupKind(match: RegExpExecArray, grammar: Grammar, rest: string): Kind | undefined {
		if (match[1] !== undefined) return "c";
		if (match[2] !== undefined) return grammar.properties === "json" && /^\s*:/u.test(rest) ? "p" : "s";
		if (match[3] !== undefined) return "v";
		return match[4] !== undefined ? "n" : undefined;
	}
	function matchKind(text: string, match: RegExpExecArray, grammar: Grammar): Kind | undefined {
		const end = match.index + match[0].length,
			rest = text.slice(end, end + 64);
		const grouped = groupKind(match, grammar, rest);
		if (grouped) return grouped;
		if (grammar.properties === "yaml" && /^\s*[:=]/u.test(rest) && lineStart(text, match.index)) return "p";
		return wordKind(match[0], grammar, rest);
	}
	function scan(text: string, pattern: RegExp, kind: (match: RegExpExecArray) => Kind | undefined): Token[] {
		const tokens: Token[] = [];
		let last = 0;
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
	function code(text: string, grammar: Grammar): Token[] {
		const never = "(?!)";
		const pattern = new RegExp(
			`(${grammar.comment ?? never})|(${grammar.string ?? never})|(${grammar.variables ? VARIABLE : never})|(${NUMBER})|${WORD}`,
			"gm",
		);
		return scan(text, pattern, (match) => matchKind(text, match, grammar));
	}
	function markup(text: string): Token[] {
		const pattern = /(<!--[\s\S]*?(?:-->|$))|(?<=<\/?)([\w:.-]+)|([\w:.-]+)(?=\s*=)|("[^"\n]*"?|'[^'\n]*'?)/gu;
		return scan(text, pattern, (match) => groupOf(match, [undefined, "c", "k", "a", "s"]));
	}
	function diff(text: string): Token[] {
		const pattern = /^(?:\+\+\+|---|@@|diff |index |\+|-)[^\n]*/gmu;
		return scan(text, pattern, (match) =>
			/^(?:\+\+\+|---|@@|diff |index )/u.test(match[0]) ? "meta" : match[0].startsWith("+") ? "ins" : "del",
		);
	}
	function markdown(text: string): Token[] {
		const pattern = /^(#{1,6} [^\n]*)|(`[^`\n]+`)|(\[[^\]\n]*\]\([^)\n]*\))/gmu;
		return scan(text, pattern, (match) => groupOf(match, [undefined, "k", "s", "f"]));
	}

	api.syntax = {
		supports: (language) =>
			!!grammarOf(language) || MARKUP.has(name(language)) || DIFF.has(name(language)) || MARKDOWN.has(name(language)),
		tokens(text, language) {
			const key = name(language);
			if (MARKUP.has(key)) return markup(text);
			if (DIFF.has(key)) return diff(text);
			if (MARKDOWN.has(key)) return markdown(text);
			const grammar = grammarOf(language);
			return grammar ? code(text, grammar) : [{ text }];
		},
	};

	// Colours the code of rendered code figures by their language label. Only spans are added
	// around existing text, so the visible text and its source offsets stay unchanged.
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
	function colourFigure(figure: HTMLElement) {
		const block = figure.querySelector<HTMLElement>("pre > code"),
			language = figure.querySelector(".lang")?.textContent ?? "";
		if (!block || block.dataset.highlighted !== undefined || !api.syntax.supports(language)) return;
		block.dataset.highlighted = "";
		const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT),
			nodes: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
		for (const node of nodes) colourText(node, language);
	}
	api.highlightCode = (root) => {
		for (const figure of root.querySelectorAll<HTMLElement>("figure.code")) colourFigure(figure);
	};
})();
