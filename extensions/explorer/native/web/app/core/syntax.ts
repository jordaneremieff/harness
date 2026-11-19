(() => {
	const common = "as break case const continue default else false for if import in new null return true while";
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
	};
	const builtins = new Set(
		"Array Boolean console Date document Error JSON Map Math Number Object Promise RegExp Set String Symbol self this window globalThis print len range fmt panic".split(
			" ",
		),
	);
	const keywords = Object.fromEntries(
		Object.entries(languages).map(([key, text]) => [key, new Set(`${common} ${text}`.split(" "))]),
	);
	const hashLanguages = new Set(["bash", "python", "yaml"]);
	const slashLanguages = new Set(["typescript", "javascript", "swift", "rust", "go", "json"]);
	const quotes = /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|`(?:\\.|[^`\\])*(?:`|$)/.source;
	const number = /\b(?:0[xob][a-f0-9_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)(?:n\b|\b)/i.source;
	const identifier = /[$\p{L}_][$\p{L}\p{N}_-]*/u.source;
	const punct = /[{}()[\],.;:]/.source;
	const operators = /[=+!*%&|~^<>/?-]+/.source;

	function markers(id: string) {
		if (hashLanguages.has(id)) return /#.*$/.source;
		if (slashLanguages.has(id)) return /\/\/.*$|\/\*.*?(?:\*\/|$)/.source;
		if (id === "css") return /\/\*.*?(?:\*\/|$)/.source;
		if (id === "sql") return /--.*$|\/\*.*?(?:\*\/|$)/.source;
		return "(?!)";
	}
	const tokens = new Map(
		Object.keys(keywords).map((id) => [
			id,
			new RegExp(`(${markers(id)})|(${quotes})|(${number})|(${identifier})|(${punct})|(${operators})`, "giu"),
		]),
	);

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Test token roles in priority order before assigning the first matching class.
	function html(text: string): ExplorerSpan[] {
		const output: ExplorerSpan[] = [];
		for (const match of text.matchAll(/<!--.*?(?:-->|$)|<\/?[A-Za-z](?:"[^"]*"|'[^']*'|[^'">])*(?:>|$)|&[#\w]+;/g)) {
			if (!match[0].startsWith("<") || match[0].startsWith("<!--")) {
				output.push({
					start: match.index,
					end: match.index + match[0].length,
					role: match[0].startsWith("<") ? "com" : "escape",
				});
				continue;
			}
			for (const token of match[0].matchAll(/<\/?[\w:-]+|"[^"]*"|'[^']*'|[\w:-]+(?=\s*=)|[=/>]/g)) {
				const start = match.index + token.index;
				const role = token[0].startsWith("<")
					? "fn"
					: /^["']/.test(token[0])
						? "str"
						: /^[\w-]/.test(token[0])
							? "member"
							: "punct";
				output.push({ start, end: start + token[0].length, role });
			}
		}
		return output;
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
	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Test token roles in priority order before assigning the first matching class.
	function classifyWord(id: string, word: string, before: string, after: string) {
		const keyword = id === "sql" ? word.toLowerCase() : word;
		if (/^(?:true|false|null|nil|undefined)$/i.test(keyword)) return "num";
		if (keywords[id]?.has(keyword)) return "key";
		if (builtins.has(word)) return "builtin";
		if (/^\s*\(/.test(after)) return "fn";
		if (/^[A-Z][\w$]*/.test(word) && id !== "sql") return "type";
		if (before === "." || ((id === "yaml" || id === "css") && /^\s*:/.test(after))) return "member";
		return "";
	}
	function role(id: string, match: RegExpMatchArray, text: string, start: number) {
		if (match[1]) return "com";
		if (match[2])
			return id === "json" && /^\s*:/.test(text.slice(start + match[0].length, start + match[0].length + 32))
				? "member"
				: "str";
		if (match[3]) return "num";
		if (match[4])
			return classifyWord(
				id,
				match[4],
				text[start - 1] ?? "",
				text.slice(start + match[0].length, start + match[0].length + 32),
			);
		return match[5] ? "punct" : "op";
	}

	// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Test token roles in priority order before assigning the first matching class.
	function paint(line: string, id: string): ExplorerSpan[] {
		if (!line) return [];
		if (id === "html") return html(line);
		if (id === "markdown") return markdown(line);
		if (id === "diff") {
			const marker = /^(?:@@|diff |index |---|\+\+\+)/.test(line)
				? "meta"
				: line.startsWith("+")
					? "str"
					: line.startsWith("-")
						? "builtin"
						: "";
			return marker ? [{ start: 0, end: line.length, role: marker }] : [];
		}
		const pattern = tokens.get(id);
		if (!pattern) return [];
		const output: ExplorerSpan[] = [];
		for (const match of line.matchAll(pattern)) {
			const start = match.index;
			const name = role(id, match, line, start);
			if (name) output.push({ start, end: start + match[0].length, role: name });
		}
		return output;
	}

	const lineLimit = 8192;
	type Template = { mode: "text" | "expression" | "comment"; parent?: Template; braces?: number };
	type Open = { end: string; role: "str" | "com"; escape?: string; depth?: number; template?: Template };
	type Fence = { mark: string; width: number; id: string };
	type State = { open?: Open; fence?: Fence };
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
		}),
	);
	const starts: Record<string, string> = {
		typescript: "`|/\\*",
		javascript: "`|/\\*",
		swift: '#*"""|/\\*',
		python: `(?:[bfru]|br|rb|fr|rf)?(?:"""|''')`,
		rust: '(?:br|cr|r)#{0,255}"|/\\*',
		go: "`|/\\*",
	};
	const jsRegex = /\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\[\r\n])+\/[a-z]*/.source;
	const jsLanguages = new Set(["typescript", "javascript"]);
	const scans = new Map(
		Object.entries(starts).map(([id, start]) => [
			id,
			new RegExp(`(${start})|${markers(id)}|${quotes}|(${jsLanguages.has(id) ? jsRegex : "(?!)"})|${identifier}`, "giu"),
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
		return { role: "str", end: value.slice(-3), escape: "\\" };
	}

	const templateText = /\\.|`|\$\{/g;
	const templateExpression = new RegExp(`//.*$|/\\*|(${jsRegex})|${quotesWithoutTemplate()}|[{}\u0060]`, "g");

	function quotesWithoutTemplate() {
		return /"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)/.source;
	}

	function regexPosition(line: string, index: number) {
		const left = line.slice(0, index).trimEnd();
		return !left || /(?:[=(:,;!?&|~<>[{}]|=>|\b(?:return|case|throw|yield|typeof|void|delete))$/.test(left);
	}

	function templateStep(line: string, index: number, frame: Template): { index: number; frame?: Template } {
		if (frame.mode === "comment") {
			const end = line.indexOf("*/", index);
			return end < 0 ? { index: line.length, frame } : { index: end + 2, frame: frame.parent };
		}
		const pattern = frame.mode === "text" ? templateText : templateExpression;
		pattern.lastIndex = index;
		const match = pattern.exec(line);
		if (!match) return { index: line.length, frame };
		if (frame.mode === "expression" && match[1]) {
			return { index: regexPosition(line, match.index) ? match.index + match[0].length : match.index + 1, frame };
		}
		const next = match.index + match[0].length;
		return { index: next, frame: templateFrame(frame, match[0]) };
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

	function closeTemplate(line: string, index: number, open: Open, frame: Template): number | Open {
		while (index < line.length) {
			const next = templateStep(line, index, frame);
			if (!next.frame) return next.index;
			frame = next.frame;
			index = next.index;
		}
		return frame === open.template ? open : { ...open, template: frame };
	}

	// Returns the first offset after the construct, or the state for the next line.
	function closeAt(line: string, start: number, open: Open): number | Open {
		if (open.template) return closeTemplate(line, start, open, open.template);
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

	function paintRun(line: string, id: string, start: number, end: number, output?: ExplorerSpan[]) {
		if (!output || start >= end) return;
		for (const span of paint(line.slice(start, end), id))
			output.push({ start: span.start + start, end: span.end + start, role: span.role });
	}

	function nextOpen(line: string, start: number, pattern: RegExp) {
		pattern.lastIndex = start;
		for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
			if (match[1]) return match;
			if (match[2] && !regexPosition(line, match.index)) pattern.lastIndex = match.index + 1;
		}
	}

	function codeLine(line: string, id: string, open: Open | undefined, output?: ExplorerSpan[]): Open | undefined {
		const pattern = scans.get(id);
		if (!pattern) {
			paintRun(line, id, 0, line.length, output);
			return undefined;
		}
		let start = 0;
		let body = 0;
		while (start < line.length) {
			if (!open) {
				const match = nextOpen(line, start, pattern);
				if (!match) break;
				paintRun(line, id, start, match.index, output);
				open = opener(id, match[1]);
				start = match.index;
				body = start + match[1].length;
			}
			const end = closeAt(line, body, open);
			if (typeof end !== "number") {
				add(output, start, line.length, open.role);
				return end;
			}
			add(output, start, end, open.role);
			start = end;
			open = undefined;
		}
		paintRun(line, id, start, line.length, output);
		return open;
	}

	function add(output: ExplorerSpan[] | undefined, start: number, end: number, role: string) {
		output?.push({ start, end, role });
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
				return { fence: state.fence, open: codeLine(line, state.fence.id, state.open, output) };
			add(output, 0, line.length, "meta");
			return {};
		}
		const fence = mark ? fenceStart(mark, info) : undefined;
		if (fence) add(output, 0, line.length, "meta");
		else paintRun(line, "markdown", 0, line.length, output);
		return { fence };
	}

	window.explorer.syntax = (text, id) => paint(text.slice(0, lineLimit), id);
	const syntaxFile = (lines: string[], id: string): ((index: number) => ExplorerSpan[]) => {
		const states: State[] = [{}];
		function scan(index: number, state: State, output?: ExplorerSpan[]): State {
			const line = (lines[index] ?? "").slice(0, lineLimit);
			if (id === "markdown") return markdownLine(line, state, output);
			return { open: codeLine(line, id, state.open, output) };
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
