(() => {
	const common = "as break case const continue default else false for if import in new null return true while";
	const cWords =
		"auto bool char do double enum extern float goto inline int long register restrict short signed sizeof static struct switch typedef union unsigned void volatile";
	const languages: Record<string, string> = {
		typescript:
			"abstract async await catch class declare delete export extends finally from function get implements infer instanceof interface is keyof let namespace of override private protected public readonly satisfies set static super switch throw try type typeof undefined using var void yield",
		javascript:
			"async await catch class debugger delete export extends finally from function get instanceof let of set static super switch throw try typeof undefined var void yield",
		swift:
			"actor any associatedtype async await catch class defer deinit do enum extension fallthrough fileprivate final func guard indirect init inout internal isolated lazy let mutating nil nonisolated open operator override private protocol public repeat required rethrows some static struct subscript super switch throw throws try typealias var where",
		python:
			"and assert async await class def del elif except False finally from global is lambda None nonlocal not or pass raise True try with yield",
		rust: "async await crate dyn enum extern fn impl let loop match mod move mut pub ref self Self static struct super trait type unsafe use where",
		go: "chan defer fallthrough func go goto interface map nil package range select struct switch type var",
		bash: "do done elif esac export fi function local readonly select set then trap unset until",
		yaml: "False TRUE True FALSE Null NULL null true false",
		json: "",
		css: "important inherit initial revert transparent unset",
		html: "",
		sql: "alter and asc between by create cross delete desc distinct drop exists from full group having inner insert into is join left like limit not offset on or order outer primary references right select set table truncate union unique update values view where with",
		toml: "inf nan",
		ini: "",
		c: cWords,
		ruby: "alias and begin break case class def do else elsif end ensure for module next nil not or redo require require_relative rescue retry return self super then undef unless until when while yield attr_accessor attr_reader attr_writer",
		php: "abstract and array as break callable catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield",
		lua: "and break do else elseif end false for function goto if in local nil not or repeat return then true until while",
		dockerfile:
			"from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell",
		"make-words":
			"include sinclude ifeq ifneq ifdef ifndef else endif define endef export unexport override undefine vpath",
		gomod: "module go require replace exclude retract toolchain godebug tool",
		hcl: "for in if else endif endfor",
		graphql:
			"query mutation subscription fragment on type interface union enum input scalar schema extend directive implements repeatable",
		protobuf:
			"syntax edition package import option message enum service rpc returns stream repeated optional required map oneof reserved extend extensions to max public weak group",
		dbml: "table ref enum project tablegroup tablepartial note indexes as",
		gettext: "msgid msgid_plural msgstr msgctxt",
		plantuml:
			"participant actor class interface enum package node component usecase note end alt else opt loop group activate deactivate start stop if then endif while endwhile title skinparam as autonumber entity database boundary control collections queue rectangle state fork endfork endsplit split legend header footer hide show return create destroy abstract namespace object",
		handlebars: "else",
		gotemplate: "if else end range with define template block break continue",
	};
	const builtins = new Set(
		"Array Boolean console Date document Error JSON Map Math Number Object Promise RegExp Set String Symbol self this window globalThis print len range fmt panic".split(
			" ",
		),
	);
	const legacyLanguages = new Set([
		"typescript",
		"javascript",
		"swift",
		"python",
		"rust",
		"go",
		"bash",
		"yaml",
		"json",
		"css",
		"html",
		"sql",
		"markdown",
		"diff",
	]);
	const commonLanguages = new Set([
		"typescript",
		"javascript",
		"swift",
		"python",
		"rust",
		"go",
		"bash",
		"yaml",
		"json",
		"css",
		"html",
		"sql",
		"c",
		"ruby",
		"php",
		"lua",
	]);
	const keywords = Object.fromEntries(
		Object.entries(languages).map(([id, text]) => [
			id,
			new Set((commonLanguages.has(id) ? `${common} ${text}` : text).split(" ")),
		]),
	);
	const hashLanguages = new Set(["bash", "python", "yaml", "toml", "ruby", "make-words", "graphql", "gettext"]);
	const slashLanguages = new Set(["typescript", "javascript", "swift", "rust", "go", "json", "c", "protobuf", "dbml"]);
	const quotes = /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)/.source;
	const boundedStrings = /"(?:\\.|[^"\\])*(?:"|\\?$)|'(?:\\.|[^'\\])*(?:'|\\?$)/.source;
	const boundedBacktick = /`(?:\\.|[^`\\])*(?:`|\\?$)/.source;
	const boundedQuotes = `${boundedStrings}|${boundedBacktick}`;
	const number = /\b(?:0[xob][a-f0-9_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)(?:n\b|\b)/i.source;
	const identifier = /[$\p{L}_][$\p{L}\p{N}_-]*/u.source;
	const punct = /[{}()[\],.;:]/.source;
	const operators = /[=+!*%&|~^<>/?-]+/.source;

	const assignments = new Set(["toml", "ini", "hcl"]);
	const assignment = /\s*=(?!=)/y;
	const hclBlocks = new Set(
		"resource data variable output locals module provider terraform backend required_providers dynamic content lifecycle moved import check".split(
			" ",
		),
	);
	const scalarTypes = new Set(
		"double float int32 int64 uint32 uint64 sint32 sint64 fixed32 fixed64 sfixed32 sfixed64 bool string bytes".split(
			" ",
		),
	);
	const dbmlSettings = new Set(
		"pk primary key increment unique not null default note ref delete update cascade restrict".split(" "),
	);
	const names: Record<string, string> = {
		graphql: /[@$\p{L}_][\p{L}\p{N}_]*/u.source,
		plantuml: /[\p{L}_][\p{L}\p{N}_]*/u.source,
		handlebars: /(?:\.\.?\/|@)?[\p{L}_][\p{L}\p{N}_./-]*/u.source,
		gotemplate: /[.$]?[\p{L}_][\p{L}\p{N}_.]*/u.source,
	};
	const slashComment = /\/\/.*$|\/\*.*?(?:\*\/|$)/.source;
	const hashAndSlash = /\/\/.*$|\/\*.*?(?:\*\/|$)|#.*$/.source;
	const commentMarkers: Record<string, string> = {
		css: /\/\*.*?(?:\*\/|$)/.source,
		sql: /--.*$|\/\*.*?(?:\*\/|$)/.source,
		php: hashAndSlash,
		hcl: hashAndSlash,
		gomod: /\/\/.*$/.source,
		ini: /[;#].*$/.source,
		lua: /--.*$/.source,
		plantuml: /\/'.*?(?:'\/|$)|'.*$/.source,
	};
	function markers(id: string) {
		if (hashLanguages.has(id)) return /#.*$/.source;
		if (slashLanguages.has(id)) return slashComment;
		return commentMarkers[id] ?? "(?!)";
	}
	function quotedTokens(id: string) {
		return legacyLanguages.has(id) ? quotes : boundedQuotes;
	}
	const tokens = new Map(
		Object.keys(keywords).map((id) => [
			id,
			new RegExp(
				`(${markers(id)})|(${quotedTokens(id)})|(${number})|(${names[id] ?? identifier})|(${punct})|(${operators})`,
				"giu",
			),
		]),
	);

	// Assigns the first matching class to each tag-innard token of an HTML fragment.
	function tagRole(token: string): string {
		if (token.startsWith("<")) return "fn";
		return /^["']/.test(token) ? "str" : /^[\w-]/.test(token) ? "member" : "punct";
	}

	// Classifies one whole line of a diff: marker, addition, deletion or plain.
	function diffMarker(line: string): string {
		if (/^(?:@@|diff |index |---|\+\+\+)/.test(line)) return "meta";
		if (line.startsWith("+")) return "str";
		if (line.startsWith("-")) return "builtin";
		return "";
	}

	const legacyTagTokens = /<\/?[\w:-]+|"[^"]*"|'[^']*'|[\w:-]+(?=\s*=)|[=/>]/g;
	const hostTagTokens = /<\/?[\w:-]+|"[^"]*"|'[^']*'|[\w:-]+|[=/>]/g;
	const attributeEnd = /\s*=/y;
	function hostWord(text: string, token: string, end: number) {
		attributeEnd.lastIndex = end;
		return !/^[\w-]/.test(token) || attributeEnd.test(text);
	}

	function html(text: string, bounded = false): ExplorerSpan[] {
		const tags = bounded
			? /<!--.*?(?:-->|$)|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'"<>])*(?:>|"[^"]*$|'[^']*$|(?=<)|$)|&[#\w]+;/g
			: /<!--.*?(?:-->|$)|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)|&[#\w]+;/g;
		const output: ExplorerSpan[] = [];
		for (const match of text.matchAll(tags)) {
			if (!match[0].startsWith("<") || match[0].startsWith("<!--")) {
				output.push({
					start: match.index,
					end: match.index + match[0].length,
					role: match[0].startsWith("<") ? "com" : "escape",
				});
				continue;
			}
			paintTag(match[0], match.index, bounded, output);
		}
		return output;
	}
	function paintTag(text: string, offset: number, bounded: boolean, output: ExplorerSpan[]) {
		for (const token of text.matchAll(bounded ? hostTagTokens : legacyTagTokens)) {
			const end = token.index + token[0].length;
			if (bounded && !hostWord(text, token[0], end)) continue;
			add(output, offset + token.index, offset + end, tagRole(token[0]));
		}
	}
	function markdown(text: string): ExplorerSpan[] {
		const output: ExplorerSpan[] = [];
		if (/^\s*#{1,6}\s|^\s*(```|~~~)/.test(text)) return [{ start: 0, end: text.length, role: "meta" }];
		for (const match of text.matchAll(/`+[^`]+`+|\[[^\]]*\]\([^)]*\)|\*\*[^*]+\*\*|^\s*(?:>|[-+*]|\d+\.)\s/g)) {
			output.push({
				start: match.index,
				end: match.index + match[0].length,
				role: match[0][0] === "`" ? "str" : match[0][0] === "[" ? "fn" : "key",
			});
		}
		return output;
	}

	// Classifies one whole line of a diff: marker, addition, deletion or plain.
	function diffLine(line: string): ExplorerSpan[] {
		const marker = diffMarker(line);
		return marker ? [{ start: 0, end: line.length, role: marker }] : [];
	}

	function shift(spans: ExplorerSpan[], offset: number): ExplorerSpan[] {
		return spans.map((span) => ({ ...span, start: span.start + offset, end: span.end + offset }));
	}

	const makeVariables = /\$\([^()]*\)|\$\{[^{}]*\}|\$[@<^?%]/g;

	// Make and automatic variables, such as $(VAR) and $@.
	function variableSpans(text: string): ExplorerSpan[] {
		return [...text.matchAll(makeVariables)].map((match) => ({
			start: match.index,
			end: match.index + match[0].length,
			role: match[0][1] === "(" || match[0][1] === "{" ? "member" : "variant",
		}));
	}

	function makefileTail(text: string, id: string): ExplorerSpan[] {
		const spans = paint(text, id);
		const output: ExplorerSpan[] = [];
		let index = 0;
		let offset = 0;
		for (const mark of variableSpans(text)) {
			while (spans[index] && spans[index].end <= mark.start) {
				const { start, end, role } = spans[index++];
				add(output, Math.max(offset, start), end, role);
			}
			const span = spans[index];
			if (span?.role === "com" && span.start <= mark.start) continue;
			if (span) add(output, Math.max(offset, span.start), Math.min(span.end, mark.start), span.role);
			output.push(mark);
			offset = mark.end;
		}
		for (; index < spans.length; index++) {
			const { start, end, role } = spans[index];
			add(output, Math.max(offset, start), end, role);
		}
		return output;
	}

	// One Makefile line: recipe lines use shell colouring, rules colour their target.
	function makefileLine(line: string): ExplorerSpan[] {
		if (line.startsWith("\t")) return shift(makefileTail(line.slice(1), "bash"), 1);
		const assignment = /^([^\s:#=]+)\s*[:?+]?=/.exec(line);
		const rule = assignment ? undefined : /^([^\s:#=]+(?:\s+[^\s:#=]+)*)\s*:(?!=)/.exec(line);
		const head = assignment ?? rule;
		const output: ExplorerSpan[] = [];
		if (head) {
			output.push({ start: head.index, end: head.index + head[1].length, role: assignment ? "member" : "fn" });
			output.push(...shift(makefileTail(line.slice(head[0].length), "make-words"), head[0].length));
		} else return makefileTail(line, "make-words");
		return output;
	}

	function ignoreLine(line: string): ExplorerSpan[] {
		return line.startsWith("#") ? [{ start: 0, end: line.length, role: "com" }] : [];
	}

	function dockerLine(line: string, continuing: boolean, output?: ExplorerSpan[]): State {
		const first = line.search(/\S/);
		if (first < 0) return { continuing };
		if (line[first] === "#") {
			add(output, first, line.length, "com");
			return { continuing };
		}
		const head = /^\s*([a-z]+)(?=\s|$)/i.exec(line);
		let start = 0;
		if (!continuing) {
			if (!head || !keywords.dockerfile.has(head[1].toLowerCase())) return {};
			start = head[0].length;
			add(output, first, start, "key");
		}
		paintRun(line, "bash", start, line.length, output);
		let backslashes = 0;
		const trimmed = line.trimEnd();
		while (trimmed[trimmed.length - backslashes - 1] === "\\") backslashes++;
		return { continuing: backslashes % 2 === 1 };
	}

	const rstInline = /``[^`]*``|(?::[\w-]+:)?`[^`]*`_?/g;
	function rstInlineRole(text: string) {
		if (text.startsWith("``")) return "str";
		return text.startsWith(":") || text.endsWith("_") ? "fn" : "";
	}

	function rstBlock(line: string): ExplorerSpan[] | undefined {
		if (/^\s*([!-/:-@[-`{-~])\1{2,}\s*$/.test(line)) return [{ start: 0, end: line.length, role: "meta" }];
		if (/^\s*\.\.(?:\s|$)/.test(line)) {
			const directive = /^\s*\.\.\s+[\w-]+::/.exec(line);
			return [{ start: 0, end: directive?.[0].length ?? line.length, role: directive ? "key" : "com" }];
		}
	}

	function rstLine(line: string): ExplorerSpan[] {
		const block = rstBlock(line);
		if (block) return block;
		const field = /^(\s*):[^:\s]+:(?!`)/.exec(line);
		const marker = field ?? /^(\s*)(?:[-+*]|\(?(?:\d+|[A-Za-z]|#)[.)])(?=\s)/.exec(line);
		const output: ExplorerSpan[] = [];
		const start = marker?.[0].length ?? 0;
		if (marker) add(output, marker[1].length, start, field ? "member" : "key");
		rstInline.lastIndex = start;
		for (const match of line.matchAll(rstInline)) {
			const role = rstInlineRole(match[0]);
			if (role) add(output, match.index, match.index + match[0].length, role);
		}
		return output;
	}

	const columnRoles = ["member", "str", "num", "fn", "type", "key"];
	function quotedFieldEnd(line: string, cursor: number) {
		while (++cursor < line.length) {
			if (line[cursor] !== '"') continue;
			if (line[cursor + 1] !== '"') return cursor + 1;
			cursor++;
		}
		return cursor;
	}

	function delimitedLine(line: string, separator: string): ExplorerSpan[] {
		const output: ExplorerSpan[] = [];
		let start = 0;
		let column = 0;
		while (start < line.length) {
			const from = line[start] === '"' ? quotedFieldEnd(line, start) : start;
			const delimiter = line.indexOf(separator, from);
			const end = delimiter < 0 ? line.length : delimiter;
			add(output, start, end, columnRoles[column++ % columnRoles.length]);
			if (delimiter < 0) break;
			add(output, end, end + 1, "punct");
			start = end + 1;
		}
		return output;
	}

	const linePainters = new Map<string, (line: string) => ExplorerSpan[]>([
		["html", html],
		["markdown", markdown],
		["diff", diffLine],
		["makefile", makefileLine],
		["ignore", ignoreLine],
		["rst", rstLine],
		["csv", (line) => delimitedLine(line, ",")],
		["tsv", (line) => delimitedLine(line, "\t")],
	]);
	// A word names a member after a dot, a key before a separator, or a variable before an assignment.
	function memberPosition(id: string, before: string, after: string) {
		if (before === ".") return true;
		if ((id === "yaml" || id === "css") && /^\s*:/.test(after)) return true;
		return id === "make-words" && /^\s*[:?+]?=/.test(after);
	}

	const lowerKeywords = new Set(["sql", "dockerfile", "dbml", "plantuml"]);
	function keywordRole(id: string, word: string): string | undefined {
		const keyword = lowerKeywords.has(id) ? word.toLowerCase() : word;
		if (commonLanguages.has(id) && /^(?:true|false|null|nil|undefined)$/i.test(keyword)) return "num";
		if (keywords[id]?.has(keyword)) return "key";
		if (commonLanguages.has(id) && builtins.has(word)) return "builtin";
		return undefined;
	}

	const literalLanguages = new Set(["hcl", "graphql", "gotemplate", "toml"]);
	function schemaRole(id: string, word: string, first: boolean, settings: number) {
		switch (id) {
			case "hcl":
				return first && hclBlocks.has(word) ? "key" : undefined;
			case "protobuf":
				return scalarTypes.has(word) ? "builtin" : undefined;
			case "dbml":
				return settings && dbmlSettings.has(word.toLowerCase()) ? "key" : undefined;
			case "graphql":
				return graphqlRole(word);
		}
	}

	function graphqlRole(word: string) {
		if (word.startsWith("$")) return "variant";
		if (word.startsWith("@")) return "macro";
		return /^[A-Z]/.test(word) ? "type" : undefined;
	}

	function goTemplateWord(word: string) {
		if (word.startsWith(".")) return "member";
		return word.startsWith("$") ? "variant" : "fn";
	}

	function languageWord(id: string, word: string) {
		if (id === "handlebars") return word.includes(".") ? "member" : "";
		if (id === "gotemplate") return goTemplateWord(word);
		if (id === "php" && word.startsWith("$")) return "variant";
	}

	function classifyWord(id: string, word: string, before: string, after: string) {
		const fixed = keywordRole(id, word) ?? languageWord(id, word);
		if (fixed !== undefined) return fixed;
		const common = commonLanguages.has(id);
		if ((common || id === "hcl") && /^\s*\(/.test(after)) return "fn";
		if (common && id !== "sql" && /^[A-Z]/.test(word)) return "type";
		return memberPosition(id, before, after) ? "member" : "";
	}
	type LexContext = { settings: number };
	function wordRole(id: string, word: string, text: string, start: number, first: boolean, context?: LexContext) {
		const end = start + word.length;
		assignment.lastIndex = end;
		if (assignments.has(id) && assignment.test(text)) return "member";
		if (literalLanguages.has(id) && /^(?:true|false|null)$/.test(word)) return "num";
		return (
			schemaRole(id, word, first, context?.settings ?? 0) ??
			classifyWord(id, word, text[start - 1] ?? "", text.slice(end, end + 32))
		);
	}
	function role(id: string, match: RegExpExecArray, text: string, first: boolean, context?: LexContext) {
		if (match[1]) return "com";
		if (match[2]) {
			const end = match.index + match[0].length;
			return id === "json" && /^\s*:/.test(text.slice(end, end + 32)) ? "member" : "str";
		}
		if (match[3]) return "num";
		if (match[4]) return wordRole(id, match[4], text, match.index, first, context);
		return match[5] ? "punct" : "op";
	}

	function dbmlBracket(context: LexContext, text: string) {
		if (text === "[") context.settings++;
		if (text === "]") context.settings = Math.max(0, context.settings - 1);
	}

	function tokenSpans(
		line: string,
		id: string,
		pattern: RegExp,
		lineStart = true,
		context?: LexContext,
	): ExplorerSpan[] {
		const output: ExplorerSpan[] = [];
		const first = lineStart && id === "hcl" ? line.search(/\S/) : -1;
		for (const match of line.matchAll(pattern)) {
			if (context) dbmlBracket(context, match[0]);
			const start = match.index;
			const name = role(id, match, line, start === first, context);
			if (name) output.push({ start, end: start + match[0].length, role: name });
		}
		return output;
	}

	const section = /^\[\[?[^[\]#]*\]\]?/;
	const tags = new Map<string, [RegExp, string]>([
		["toml", [section, "type"]],
		["ini", [section, "type"]],
		["c", [/^#.*/, "macro"]],
		["gettext", [/^#,.*/, "meta"]],
		["plantuml", [/^@(?:start|end)\w*.*/i, "meta"]],
		["php", [/^(?:<\?(?:php\b|=)?|\?>)/i, "meta"]],
	]);
	function tagged(id: string, line: string): ExplorerSpan | undefined {
		const tag = tags.get(id);
		if (!tag) return undefined;
		const rest = line.trimStart();
		const start = line.length - rest.length;
		const match = tag[0].exec(rest);
		return match ? { start, end: start + match[0].length, role: tag[1] } : undefined;
	}

	function paint(line: string, id: string): ExplorerSpan[] {
		if (!line) return [];
		const painter = linePainters.get(id);
		if (painter) return painter(line);
		const prefix = tagged(id, line);
		const pattern = tokens.get(id);
		if (!prefix) return pattern ? tokenSpans(line, id, pattern) : [];
		const rest = pattern && prefix.end < line.length ? tokenSpans(line.slice(prefix.end), id, pattern) : [];
		return [prefix, ...shift(rest, prefix.end)];
	}

	const lineLimit = 8192;
	type Template = { mode: "text" | "expression" | "comment"; parent?: Template; braces?: number };
	type Open = {
		delimiterLine?: "exact" | "directive";
		end: string;
		role: "str" | "com";
		escape?: string;
		depth?: number;
		template?: Template;
	};
	type Fence = { mark: string; width: number; id: string };
	type State = { open?: Open; fence?: Fence; guest?: Guest; continuing?: boolean; settings?: number; body?: State };
	const aliases = new Map(
		Object.entries({
			ts: "typescript",
			tsx: "typescript",
			js: "javascript",
			jsx: "javascript",
			mjs: "javascript",
			cjs: "javascript",
			py: "python",
			rs: "rust",
			sh: "bash",
			shell: "bash",
			zsh: "bash",
			yml: "yaml",
			md: "markdown",
			htm: "html",
			xml: "html",
			golang: "go",
			patch: "diff",
			rb: "ruby",
			mk: "makefile",
			tf: "hcl",
			tfvars: "hcl",
			terraform: "hcl",
			proto: "protobuf",
			gql: "graphql",
			hbs: "handlebars",
			puml: "plantuml",
			po: "gettext",
			pot: "gettext",
			restructuredtext: "rst",
			tpl: "gotemplate",
			tmpl: "gotemplate",
			gotmpl: "gotemplate",
			"go-template": "gotemplate",
			dotenv: "ini",
			env: "ini",
			docker: "dockerfile",
			make: "makefile",
		}),
	);
	const starts: Record<string, string> = {
		typescript: "`|/\\*",
		javascript: "`|/\\*",
		swift: '#*"""|/\\*',
		python: `(?:[bfru]|br|rb|fr|rf)?(?:"""|''')`,
		rust: '(?:br|cr|r)#{0,255}"|/\\*',
		go: "`|/\\*",
		toml: `"""|'''`,
		c: "/\\*",
		php: "/\\*",
		lua: "(?:--)?\\[=*\\[",
		ruby: "^=begin(?=\\s|$)",
		hcl: "<<-?[A-Za-z_][\\w-]*(?=\\s*$)|/\\*",
		graphql: '"""',
		protobuf: "/\\*",
		dbml: "'''|/\\*",
		plantuml: "/'",
		css: "/\\*",
	};
	const jsRegex = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[\r\n])+\/[a-z]*/.source;
	const jsLanguages = new Set(["typescript", "javascript"]);
	const scans = new Map(
		Object.entries(starts).map(([id, start]) => [
			id,
			new RegExp(
				`(${start})|${markers(id)}|${quotedTokens(id)}|(${jsLanguages.has(id) ? jsRegex : "(?!)"})|${identifier}`,
				"giu",
			),
		]),
	);

	const nestedComments = new Set(["swift", "rust"]);
	function opener(id: string, value: string): Open {
		if (value === "/*") return { role: "com", end: "*/", depth: nestedComments.has(id) ? 1 : undefined };
		if (value === "`") return { role: "str", end: "`", template: id === "go" ? undefined : { mode: "text" } };
		if (id === "swift") {
			const hashes = value.slice(0, -3);
			return { role: "str", end: `"""${hashes}`, escape: `\\${hashes}` };
		}
		if (id === "rust") return { role: "str", end: `"${value.match(/#*"$/)?.[0].slice(0, -1) ?? ""}` };
		return stringOpener(id, value);
	}

	function stringOpener(id: string, value: string): Open {
		if (id === "lua") return luaOpen(value);
		if (value === `"""`) return { role: "str", end: `"""`, escape: "\\" };
		if (value === `'''`) return { role: "str", end: `'''`, escape: id === "toml" ? undefined : "\\" };
		if (value === "=begin") return { role: "com", end: "=end", delimiterLine: "directive" };
		if (value === "/'") return { role: "com", end: "'/" };
		if (id === "hcl") return { role: "str", end: value.replace(/^<<-?/, ""), delimiterLine: "exact" };
		return { role: "str", end: value.slice(-3), escape: "\\" };
	}

	// Lua long brackets pair an opener such as [[ or --[==[ with its own closer.
	function luaOpen(value: string): Open {
		const level = value.replace(/^--/, "").replace(/^\[/, "").replace(/\[$/, "");
		return { role: value.startsWith("--") ? "com" : "str", end: `]${level}]` };
	}

	const templateText = /\\.|`|\$\{/g;
	const templateExpression = new RegExp(`//.*$|/\\*|(${jsRegex})|${quotesWithoutTemplate()}|[{}\u0060]`, "g");

	function quotesWithoutTemplate() {
		return /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/.source;
	}

	// Scan for a slash before attempting a regex, so malformed literals cannot trigger repeated suffix scans.
	const embeddedJsScan = new RegExp(`(\u0060|/\\*)|//.*$|${boundedQuotes}|(/)|${identifier}`, "giu");
	const embeddedExpression = new RegExp(`//.*$|/\\*|(/)|${boundedStrings}|[{}\u0060]`, "g");

	function regexPosition(line: string, index: number) {
		let end = index - 1;
		while (end >= 0 && /\s/.test(line[end])) end--;
		const left = line.slice(Math.max(0, end - 6), end + 1);
		return !left || /(?:[=(:,;!?&|~<>[{}]|\b(?:return|case|throw|yield|typeof|void|delete))$/.test(left);
	}

	function regexEnd(line: string, index: number) {
		let inClass = false;
		while (++index < line.length) {
			const char = line[index];
			if (char === "\\") index++;
			else if (char === "[") inClass = true;
			else if (char === "]") inClass = false;
			else if (char === "/" && !inClass) return regexFlagsEnd(line, index + 1);
		}
		return line.length;
	}

	function regexFlagsEnd(line: string, index: number) {
		while (/[a-z]/i.test(line[index] ?? "")) index++;
		return index;
	}

	function templateStep(
		line: string,
		index: number,
		frame: Template,
		embedded: boolean,
	): { index: number; frame?: Template } {
		if (frame.mode === "comment") {
			const end = line.indexOf("*/", index);
			return end < 0 ? { index: line.length, frame } : { index: end + 2, frame: frame.parent };
		}
		const pattern = frame.mode === "text" ? templateText : expressionPattern(embedded);
		pattern.lastIndex = index;
		const match = pattern.exec(line);
		if (!match) return { index: line.length, frame };
		if (frame.mode === "expression" && match[1]) {
			return { index: afterRegex(line, match, embedded), frame };
		}
		const next = match.index + match[0].length;
		return { index: next, frame: templateFrame(frame, match[0]) };
	}

	function expressionPattern(embedded: boolean) {
		return embedded ? embeddedExpression : templateExpression;
	}

	function afterRegex(line: string, match: RegExpExecArray, embedded: boolean) {
		if (!regexPosition(line, match.index)) return match.index + 1;
		return embedded ? regexEnd(line, match.index) : match.index + match[0].length;
	}

	function templateFrame(frame: Template, token: string): Template | undefined {
		switch (token) {
			case "`":
				return frame.mode === "text" ? frame.parent : { mode: "text", parent: frame };
			case "${":
				return { mode: "expression", braces: 1, parent: frame };
			case "/*":
				return { mode: "comment", parent: frame };
			case "{":
				return { ...frame, braces: (frame.braces ?? 0) + 1 };
			case "}":
				return frame.braces === 1 ? frame.parent : { ...frame, braces: (frame.braces ?? 0) - 1 };
			default:
				return frame;
		}
	}

	function closeTemplate(line: string, index: number, open: Open, frame: Template, embedded: boolean): number | Open {
		while (index < line.length) {
			const next = templateStep(line, index, frame, embedded);
			if (!next.frame) return next.index;
			frame = next.frame;
			index = next.index;
		}
		return frame === open.template ? open : { ...open, template: frame };
	}

	function closeLine(line: string, start: number, open: Open): number | Open {
		if (start !== 0) return open;
		const closes = open.delimiterLine === "exact" ? line.trim() === open.end : /^=end(?:\s|$)/.test(line);
		return closes ? line.length : open;
	}

	// Returns the first offset after the construct, or the state for the next line.
	function closeAt(line: string, start: number, open: Open, embedded = false): number | Open {
		if (open.delimiterLine) return closeLine(line, start, open);
		if (open.template) return closeTemplate(line, start, open, open.template, embedded);
		if (open.depth !== undefined) return closeComment(line, start, open, open.depth);
		if (!open.escape) {
			const end = line.indexOf(open.end, start);
			return end < 0 ? open : end + open.end.length;
		}
		return closeEscaped(line, start, open, open.escape);
	}

	function closeComment(line: string, start: number, open: Open, depth: number): number | Open {
		const delimiters = /\/\*|\*\//g;
		delimiters.lastIndex = start;
		for (const match of line.matchAll(delimiters)) {
			depth += match[0] === "/*" ? 1 : -1;
			if (!depth) return match.index + 2;
		}
		return depth === open.depth ? open : { ...open, depth };
	}

	function closeEscaped(line: string, start: number, open: Open, escapePrefix: string): number | Open {
		for (let index = start; index < line.length; index++) {
			if (line.startsWith(escapePrefix, index)) index += escapePrefix.length;
			else if (line.startsWith(open.end, index)) return index + open.end.length;
		}
		return open;
	}

	function paintRun(
		line: string,
		id: string,
		start: number,
		end: number,
		output?: ExplorerSpan[],
		context?: LexContext,
	) {
		if ((!output && !context) || start >= end) return;
		const text = line.slice(start, end);
		const pattern = context || (id === "hcl" && start > 0) ? tokens.get(id) : undefined;
		const spans = pattern ? tokenSpans(text, id, pattern, start === 0, context) : paint(text, id);
		if (output) output.push(...shift(spans, start));
	}

	function nextOpen(line: string, start: number, pattern: RegExp, embedded: boolean) {
		pattern.lastIndex = start;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			if (match[1]) return match;
			if (match[2]) pattern.lastIndex = afterRegex(line, match, embedded);
		}
	}

	function scanPattern(id: string, embedded: boolean) {
		return embedded && jsLanguages.has(id) ? embeddedJsScan : scans.get(id);
	}

	function codeLine(
		line: string,
		id: string,
		open: Open | undefined,
		output?: ExplorerSpan[],
		context?: LexContext,
		embedded = false,
	): Open | undefined {
		const pattern = scanPattern(id, embedded);
		if (!pattern) {
			paintRun(line, id, 0, line.length, output, context);
			return undefined;
		}
		let start = 0;
		let body = 0;
		while (start < line.length) {
			if (!open) {
				const match = nextOpen(line, start, pattern, embedded);
				if (!match) break;
				paintRun(line, id, start, match.index, output, context);
				open = opener(id, match[1]);
				start = match.index;
				body = start + match[1].length;
			}
			const end = closeAt(line, body, open, embedded);
			if (typeof end !== "number") {
				add(output, start, line.length, open.role);
				return end;
			}
			add(output, start, end, open.role);
			start = end;
			open = undefined;
		}
		paintRun(line, id, start, line.length, output, context);
		return open;
	}

	function add(output: ExplorerSpan[] | undefined, start: number, end: number, role: string) {
		if (start < end) output?.push({ start, end, role });
	}

	// Host markup and its guest lexer resume independently at each line boundary.
	type Guest = {
		kind: "action" | "brace" | "comment" | "element" | "frontmatter" | "html-comment";
		id: string;
		end: string;
		open?: Open;
		brace?: Open;
		lead?: boolean;
	};
	const hostOpeners = new Map([
		["erb", /<!--|<%[#=-]?/g],
		["handlebars", /<!--|\{\{(?:!--|!|\{)?/g],
		["gotemplate", /\{\{(?:(?:-\s+)?\/\*|-(?=\s))?/g],
		["astro", /<!--|<(script|style)(?=[\s/>])(?:"[^"<>]*"|'[^'<>]*'|[^<>"'])*>|\{/gi],
		["svelte", /<!--|<(script|style)(?=[\s/>])(?:"[^"<>]*"|'[^'<>]*'|[^<>"'])*>|\{[#:/@]?/gi],
	]);
	const scriptEnd = /<\/script\s*>/gi;
	const styleEnd = /<\/style\s*>/gi;
	const actionEnds = new Map([
		["%>", new RegExp(`(-?%>)|${boundedQuotes}`, "g")],
		["go", new RegExp(`(-?}})|${boundedQuotes}`, "g")],
		["}}", new RegExp(`(}})|${boundedQuotes}`, "g")],
		["}}}", new RegExp(`(}}})|${boundedQuotes}`, "g")],
	]);
	const goCommentEnd = /\*\/(?:\s*-)?}}/g;

	function openGuest(id: string, token: RegExpExecArray): Guest {
		if (token[0] === "<!--") return { kind: "html-comment", id: "", end: "-->" };
		if (token[1]) {
			const script = token[1].toLowerCase() === "script";
			return { kind: "element", id: script ? "typescript" : "css", end: script ? "script" : "style" };
		}
		const action = openAction(id, token[0]);
		if (action) return action;
		return {
			kind: "brace",
			id: "typescript",
			end: "}",
			lead: token[0].length > 1,
			brace: { end: "}", role: "str", template: { mode: "expression", braces: 1 } },
		};
	}

	function openAction(id: string, text: string): Guest | undefined {
		if (id === "erb") return { kind: text === "<%#" ? "comment" : "action", id: "ruby", end: "%>" };
		if (id === "gotemplate") return { kind: text.endsWith("/*") ? "comment" : "action", id, end: "}}" };
		if (id === "handlebars") return handlebarsGuest(text);
	}

	function handlebarsGuest(token: string): Guest {
		if (token === "{{!--") return { kind: "comment", id: "handlebars", end: "--}}" };
		if (token === "{{!") return { kind: "comment", id: "handlebars", end: "}}" };
		return { kind: "action", id: "handlebars", end: token === "{{{" ? "}}}" : "}}", lead: true };
	}

	function elementEnd(line: string, start: number, guest: Guest) {
		const pattern = guest.end === "script" ? scriptEnd : styleEnd;
		pattern.lastIndex = start;
		const match = pattern.exec(line);
		return match ? { start: match.index, end: pattern.lastIndex } : undefined;
	}

	function actionEnd(line: string, start: number, guest: Guest) {
		const pattern = actionEnds.get(guest.id === "gotemplate" ? "go" : guest.end);
		if (!pattern) return undefined;
		pattern.lastIndex = start;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			if (match[1]) return { start: match.index, end: pattern.lastIndex };
		}
	}

	function commentEnd(line: string, start: number, guest: Guest) {
		if (guest.id === "gotemplate") {
			goCommentEnd.lastIndex = start;
			const match = goCommentEnd.exec(line);
			return match ? { start: match.index + 2, end: goCommentEnd.lastIndex } : undefined;
		}
		const end = line.indexOf(guest.end, start);
		if (end < 0) return undefined;
		const trimmed = guest.id === "ruby" && end > start && line[end - 1] === "-";
		return { start: trimmed ? end - 1 : end, end: end + guest.end.length };
	}

	type GuestClose = { start: number; end: number };
	function guestEnd(line: string, start: number, guest: Guest): GuestClose | undefined {
		if (guest.kind === "element") return elementEnd(line, start, guest);
		if (guest.kind === "action") return actionEnd(line, start, guest);
		if (guest.kind === "frontmatter") return line.trim() === "---" ? { start: 0, end: line.length } : undefined;
		if (guest.brace) {
			const end = closeAt(line, start, guest.brace, true);
			if (typeof end === "number") return { start: end - 1, end };
			guest.brace = end;
			return undefined;
		}
		return commentEnd(line, start, guest);
	}

	const handlebarsHead = /\s*(?:([#/^>]\s*)([\w.-]+)|else\b)/y;
	const svelteHead = /\s*([\w-]+)/y;
	function guestHead(line: string, start: number, limit: number, guest: Guest, output?: ExplorerSpan[]) {
		if (!guest.lead) return start;
		const pattern = guest.id === "handlebars" ? handlebarsHead : svelteHead;
		pattern.lastIndex = start;
		const match = pattern.exec(line);
		if (!match || pattern.lastIndex > limit) {
			guest.lead = !/\S/.test(line.slice(start, limit));
			return start;
		}
		guest.lead = false;
		const name = match[2] ?? match[1] ?? "else";
		const end = pattern.lastIndex;
		if (match[2]) {
			const sigil = end - match[2].length - match[1].length;
			add(output, sigil, sigil + 1, "op");
		}
		add(output, end - name.length, end, "key");
		return end;
	}

	function paintGuest(line: string, start: number, end: number, guest: Guest, output?: ExplorerSpan[]) {
		if (guest.kind === "html-comment" || guest.kind === "comment") {
			add(output, start, end, "com");
			return;
		}
		const from = guestHead(line, start, end, guest, output);
		const spans = output ? [] : undefined;
		guest.open = codeLine(line.slice(from, end), guest.id, guest.open, spans, undefined, true);
		if (output && spans) output.push(...shift(spans, from));
	}

	function keepHost(host: GuestClose[] | undefined, start: number, end: number) {
		if (start < end) host?.push({ start, end });
	}

	function paintGuestMarker(
		host: GuestClose[] | undefined,
		start: number,
		end: number,
		guest: Guest,
		output?: ExplorerSpan[],
	) {
		if (guest.kind === "element") keepHost(host, start, end);
		else add(output, start, end, guest.kind === "html-comment" ? "com" : "meta");
	}

	function findGuest(
		line: string,
		id: string,
		pattern: RegExp,
		start: number,
		host: GuestClose[] | undefined,
		output?: ExplorerSpan[],
	) {
		pattern.lastIndex = start;
		const token = pattern.exec(line);
		if (!token) return undefined;
		keepHost(host, start, token.index);
		const guest = openGuest(id, token);
		const end = pattern.lastIndex - (guest.id === "gotemplate" && guest.kind === "comment" ? 2 : 0);
		paintGuestMarker(host, token.index, end, guest, output);
		return { guest, end };
	}

	// Keep HTML attributes in one run even when a guest supplies part of their value.
	function markupSpans(line: string, host: GuestClose[]) {
		let end = 0;
		const parts: string[] = [];
		for (const range of host) {
			parts.push(" ".repeat(range.start - end), line.slice(range.start, range.end));
			end = range.end;
		}
		const spans = html(parts.join(""), true);
		const markup: ExplorerSpan[] = [];
		let index = 0;
		for (const range of host) {
			while (spans[index] && spans[index].start < range.end) {
				const span = spans[index];
				add(markup, Math.max(span.start, range.start), Math.min(span.end, range.end), span.role);
				if (span.end > range.end) break;
				index++;
			}
		}
		return markup;
	}

	function mergeMarkup(markup: ExplorerSpan[], guests: ExplorerSpan[], output: ExplorerSpan[]) {
		let index = 0;
		for (const span of markup) {
			while (guests[index] && guests[index].start < span.start) output.push(guests[index++]);
			output.push(span);
		}
		output.push(...guests.slice(index));
	}

	function templateLine(line: string, id: string, pattern: RegExp, state: State, output?: ExplorerSpan[]): State {
		if (!output || id === "gotemplate") return scanTemplate(line, id, pattern, state, undefined, output);
		const host: GuestClose[] = [];
		const guests: ExplorerSpan[] = [];
		const next = scanTemplate(line, id, pattern, state, host, guests);
		mergeMarkup(markupSpans(line, host), guests, output);
		return next;
	}

	function scanTemplate(
		line: string,
		id: string,
		pattern: RegExp,
		state: State,
		host: GuestClose[] | undefined,
		output?: ExplorerSpan[],
	): State {
		let guest = state.guest ? { ...state.guest } : undefined;
		let start = 0;
		while (start < line.length) {
			if (!guest) {
				const next = findGuest(line, id, pattern, start, host, output);
				if (!next) break;
				guest = next.guest;
				start = next.end;
			}
			const close = guestEnd(line, start, guest);
			paintGuest(line, start, close?.start ?? line.length, guest, output);
			if (!close) return { guest };
			paintGuestMarker(host, close.start, close.end, guest, output);
			start = close.end;
			guest = undefined;
		}
		keepHost(host, start, line.length);
		return { guest };
	}

	function sourceLine(line: string, id: string, state: State, first: boolean, output?: ExplorerSpan[]): State {
		if (first && id === "astro" && /^---[ \t\r]*$/.test(line)) {
			add(output, 0, line.length, "meta");
			return { guest: { kind: "frontmatter", id: "typescript", end: "---" } };
		}
		const pattern = hostOpeners.get(id);
		if (pattern) return templateLine(line, id, pattern, state, output);
		if (id === "dockerfile") return dockerLine(line, state.continuing ?? false, output);
		if (id === "css") {
			paintRun(line, id, 0, line.length, output);
			return {};
		}
		const context = id === "dbml" ? { settings: state.settings ?? 0 } : undefined;
		const open = codeLine(line, id, state.open, output, context);
		return { open, settings: context?.settings };
	}

	function fenceStart(mark: string, info: string): Fence | undefined {
		if (mark[0] === "`" && info.includes("`")) return undefined;
		const name = (info.trim().split(/\s+/)[0] ?? "").toLowerCase();
		const id = aliases.get(name) ?? name;
		return { mark: mark[0], width: mark.length, id: id === "markdown" ? "" : id };
	}

	function fenceEnd(fence: Fence, mark: string, info: string) {
		return mark[0] === fence.mark && mark.length >= fence.width && !info.trim();
	}

	function markdownLine(line: string, state: State, output?: ExplorerSpan[]): State {
		const [, mark = "", info = ""] = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line) ?? [];
		if (state.fence) {
			if (!fenceEnd(state.fence, mark, info))
				return { fence: state.fence, body: sourceLine(line, state.fence.id, state.body ?? {}, !state.body, output) };
			add(output, 0, line.length, "meta");
			return {};
		}
		const fence = mark ? fenceStart(mark, info) : undefined;
		if (fence) add(output, 0, line.length, "meta");
		else paintRun(line, "markdown", 0, line.length, output);
		return { fence };
	}

	window.explorer.syntax = (text, id) => {
		const line = text.slice(0, lineLimit);
		if (legacyLanguages.has(id)) return paint(line, id);
		const output: ExplorerSpan[] = [];
		sourceLine(line, id, {}, false, output);
		return output;
	};
	const syntaxFile = (lines: string[], id: string): ((index: number) => ExplorerSpan[]) => {
		const states: State[] = [{}];
		function scan(index: number, state: State, output?: ExplorerSpan[]): State {
			const line = (lines[index] ?? "").slice(0, lineLimit);
			if (id === "markdown") return markdownLine(line, state, output);
			return sourceLine(line, id, state, index === 0, output);
		}
		return (index) => {
			if (!Number.isInteger(index) || index < 0 || index >= lines.length) return [];
			while (states.length <= index) {
				const last = states.length - 1;
				states.push(scan(last, states[last]));
			}
			const output: ExplorerSpan[] = [];
			const end = scan(index, states[index], output);
			if (states.length === index + 1) states.push(end);
			return output;
		};
	};
	Object.assign(window.explorer, { syntaxFile });
})();
