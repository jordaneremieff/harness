(() => {
	const listeners: ((event: ExplorerEvent) => void)[] = [];
	const eventTypes = new Set(["files.changed", "notes.changed", "live", "open", "promptState", "zoom"]);
	async function request<K extends keyof ExplorerRequests>(
		type: K,
		...args: undefined extends ExplorerRequests[K][0]
			? [fields?: ExplorerRequests[K][0]]
			: [fields: ExplorerRequests[K][0]]
	): Promise<ExplorerRequests[K][1]> {
		const channel = (
			window as Window & {
				webkit?: { messageHandlers?: { explorer?: { postMessage(value: object): Promise<unknown> } } };
			}
		).webkit?.messageHandlers?.explorer;
		if (!channel) throw Object.assign(new Error("The Explorer host is unavailable."), { code: "unavailable" });
		const packet = JSON.parse(JSON.stringify({ ...args[0], v: 1, type })) as object;
		const result = (await channel.postMessage(packet)) as {
			ok?: unknown;
			error?: { code?: string; message?: string; retryable?: boolean };
		};
		if (result?.ok !== true)
			throw Object.assign(new Error(result?.error?.message ?? "The host did not confirm the request."), {
				code: result?.error?.code,
				retryable: result?.error?.retryable,
			});
		return result as ExplorerRequests[K][1];
	}

	function lines(text: string | null | undefined): string[] {
		return text ? text.replace(/\n$/, "").split("\n") : [];
	}

	const languages: [string, string, string, string][] = [
		["typescript", "TypeScript", "TS", "ts tsx mts cts"],
		["javascript", "JavaScript", "JS", "js jsx mjs cjs"],
		["swift", "Swift", "SW", "swift"],
		["json", "JSON", "{}", "json jsonc jsonl json5"],
		["markdown", "Markdown", "M↓", "md mdx markdown apib"],
		["css", "CSS", "#", "css scss less"],
		["html", "HTML", "<>", "html htm xml svg"],
		["bash", "Shell", ">_", "sh bash zsh fish"],
		["yaml", "YAML", "Y", "yaml yml neon"],
		["python", "Python", "PY", "py pyw py-tpl"],
		["rust", "Rust", "RS", "rs"],
		["go", "Go", "GO", "go"],
		["sql", "SQL", "SQ", "sql"],
		["diff", "Diff", "±", "diff patch"],
		["toml", "TOML", "TM", "toml"],
		["ini", "INI", "IN", "ini cfg conf properties env service socket timer"],
		["c", "C", "CC", "c h"],
		["ruby", "Ruby", "RB", "rb gemspec rake"],
		["php", "PHP", "PH", "php"],
		["lua", "Lua", "LU", "lua"],
		["dockerfile", "Dockerfile", "DK", "dockerfile"],
		["makefile", "Makefile", "MK", "mk"],
		["ignore", "Ignore file", "##", ""],
		["gomod", "Go module", "GM", ""],
		["hcl", "HCL", "HC", "tf tfvars hcl"],
		["graphql", "GraphQL", "GQ", "graphql gql"],
		["protobuf", "Protocol Buffers", "PB", "proto"],
		["dbml", "DBML", "DB", "dbml"],
		["gettext", "Gettext", "PO", "po pot"],
		["plantuml", "PlantUML", "PU", "puml plantuml"],
		["rst", "reStructuredText", "RT", "rst"],
		["csv", "CSV", "CV", "csv"],
		["tsv", "TSV", "TV", "tsv"],
		["erb", "ERB", "ER", "erb"],
		["handlebars", "Handlebars", "HB", "hbs handlebars"],
		["gotemplate", "Go template", "GT", "tpl tmpl gotmpl"],
		["svelte", "Svelte", "SV", "svelte"],
		["astro", "Astro", "AS", "astro"],
	];
	const byExtension = new Map(
		languages.flatMap(([id, label, mark, extensions]) =>
			extensions
				.split(" ")
				.filter(Boolean)
				.map((extension) => [extension, { id, label, mark }] as const),
		),
	);
	const languageEntries = new Map(languages.map(([id, label, mark]) => [id, { id, label, mark }] as const));
	const named: [string, string][] = [
		["Cargo.lock", "toml"],
		["Package.resolved", "json"],
		["Tiltfile", "python"],
		["go.mod", "gomod"],
		["go.work", "gomod"],
		[".zshrc", "bash"],
		[".zprofile", "bash"],
		[".bashrc", "bash"],
		[".bash_profile", "bash"],
		["Dockerfile", "dockerfile"],
		["Containerfile", "dockerfile"],
		["Makefile", "makefile"],
		["GNUmakefile", "makefile"],
		["makefile", "makefile"],
		["Gemfile", "ruby"],
		["Rakefile", "ruby"],
		[".editorconfig", "ini"],
		[".gitconfig", "ini"],
		[".npmrc", "ini"],
		[".env", "ini"],
		[".gitignore", "ignore"],
		[".gitattributes", "ignore"],
		[".dockerignore", "ignore"],
		[".npmignore", "ignore"],
		[".prettierignore", "ignore"],
	];
	const byName = new Map(
		named.flatMap(([name, id]) => {
			const entry = languageEntries.get(id);
			return entry ? ([[name, entry]] as const) : [];
		}),
	);
	const interpreters: Record<string, string> = {
		node: "javascript",
		deno: "javascript",
		bun: "javascript",
		"ts-node": "typescript",
		tsx: "typescript",
		python: "python",
		bash: "bash",
		sh: "bash",
		zsh: "bash",
		dash: "bash",
		ksh: "bash",
		fish: "bash",
		ruby: "ruby",
		swift: "swift",
		php: "php",
		lua: "lua",
	};
	const plainText: ExplorerLanguage = { id: "text", label: "Plain text", mark: "" };

	// Reads the interpreter from a #! line, through env and its flags, past version suffixes.
	function shebang(firstLine: string | undefined): ExplorerLanguage | undefined {
		if (!firstLine?.startsWith("#!")) return undefined;
		const words = firstLine.slice(2, 8192).trim().split(/\s+/);
		const env = (words[0] ?? "").split("/").at(-1) === "env";
		const index = env ? words.findIndex((word, at) => at > 0 && !word.startsWith("-")) : 0;
		const name = ((index > 0 ? words[index] : words[0]) ?? "").split("/").at(-1) ?? "";
		return languageEntries.get(interpreters[name.replace(/[\d.]+$/, "")] ?? "");
	}

	// Exact file names win over extensions; an unknown extension falls back to the shebang line.
	function language(path: string, firstLine?: string): ExplorerLanguage {
		const name = path.split("/").at(-1) ?? "";
		const exact = byName.get(name) ?? (/^\.env\./.test(name) ? languageEntries.get("ini") : undefined);
		const dot = name.lastIndexOf(".");
		const extension = dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
		return exact ?? byExtension.get(extension) ?? shebang(firstLine) ?? plainText;
	}

	// Scores one path against the query: substring hits outrank subsequence hits.
	function exactScore(value: string, exact: number, leaf: number): number {
		return 200 + (exact >= leaf ? 60 : 0) + (exact === leaf ? 25 : 0) - value.length * 0.1;
	}

	function sequenceScore(value: string, needle: string, leaf: number): number | undefined {
		let index = 0;
		let first = Number.POSITIVE_INFINITY;
		let last = -1;
		let score = 0;
		for (let cursor = 0; cursor < value.length && index < needle.length; cursor++) {
			if (value[cursor] !== needle[index]) continue;
			first = Math.min(first, cursor);
			if (cursor === last + 1) score += 5;
			if (cursor >= leaf) score += 2;
			last = cursor;
			index++;
		}
		if (index !== needle.length) return undefined;
		return score - (last - first) * 0.4 - value.length * 0.13;
	}

	function fuzzyScore(value: string, needle: string): number | undefined {
		const leaf = value.lastIndexOf("/") + 1;
		const exact = value.indexOf(needle);
		if (exact >= 0) return exactScore(value, exact, leaf);
		return sequenceScore(value, needle, leaf);
	}

	function indexedPath(entry: ExplorerIndexedPath) {
		return typeof entry === "string" ? { path: entry, lower: entry.toLowerCase() } : entry;
	}
	function leadingPaths(paths: Iterable<ExplorerIndexedPath>, limit: number) {
		const matches: ExplorerHit[] = [];
		for (const entry of paths) {
			if (matches.length >= limit) break;
			matches.push({ path: typeof entry === "string" ? entry : entry.path, score: 0 });
		}
		return matches;
	}
	function fuzzy(paths: Iterable<ExplorerIndexedPath>, query: string, limit = 100): ExplorerHit[] {
		const needle = query.trim().toLowerCase();
		if (!needle) return leadingPaths(paths, limit);
		const matches: ExplorerHit[] = [];
		for (const entry of paths) {
			const { path, lower } = indexedPath(entry);
			const score = fuzzyScore(lower, needle);
			if (score !== undefined) matches.push({ path, score });
		}
		return matches.sort(byScore).slice(0, limit);
	}

	function byScore(a: ExplorerHit, b: ExplorerHit) {
		return b.score - a.score || a.path.localeCompare(b.path);
	}

	function find(source: string[], query: string, side: ExplorerSide, limit = 10000): ExplorerMatch[] {
		if (!query) return [];
		const re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
		const result: ExplorerMatch[] = [];
		for (let row = 0; row < source.length; row++) {
			for (const match of source[row].matchAll(re)) {
				result.push({ side, line: row + 1, start: match.index, end: match.index + match[0].length });
				if (result.length >= limit) return result;
			}
		}
		return result;
	}

	function word(a: string, b: string): ReturnType<ExplorerModel["word"]> {
		if (a === b || a.length + b.length > 1000) return undefined;
		const tokens = (text: string) => [...text.matchAll(/[\p{L}\p{N}_$]+|\s+|[^\s]/gu)];
		const left = tokens(a),
			right = tokens(b);
		let start = 0,
			end = 0;
		while (start < Math.min(left.length, right.length) && left[start][0] === right[start][0]) start++;
		while (
			end < Math.min(left.length, right.length) - start &&
			left[left.length - end - 1][0] === right[right.length - end - 1][0]
		)
			end++;
		return {
			base: [left[start]?.index ?? a.length, left[left.length - end]?.index ?? a.length],
			head: [right[start]?.index ?? b.length, right[right.length - end]?.index ?? b.length],
		};
	}

	// Walking line counters shared by the context and hunk row builders.
	type Cursor = { base: number; head: number };

	function addContextLine(rows: ExplorerCodeRow[], cursor: Cursor) {
		rows.push({ type: "line", kind: "context", base: cursor.base++, head: cursor.head++ });
	}

	// Emits the unchanged lines around a hunk, folding the distant middle when it is long.
	function contextRows(rows: ExplorerCodeRow[], cursor: Cursor, count: number, leading: number, trailing: number) {
		if (count > leading + trailing + 3) {
			for (let index = 0; index < leading; index++) addContextLine(rows, cursor);
			const folded = count - leading - trailing;
			rows.push({
				type: "fold",
				key: `${cursor.base}:${cursor.head}`,
				base: cursor.base,
				head: cursor.head,
				count: folded,
			});
			cursor.base += folded;
			cursor.head += folded;
			for (let index = 0; index < trailing; index++) addContextLine(rows, cursor);
		} else for (let index = 0; index < count; index++) addContextLine(rows, cursor);
	}

	function wordPairs(
		base: string[],
		head: string[],
		cursor: Cursor,
		bn: number,
		hn: number,
	): ReturnType<ExplorerModel["word"]>[] {
		const words: ReturnType<ExplorerModel["word"]>[] = [];
		if (!(bn + hn <= 360)) return words;
		for (let offset = 0; offset < Math.min(bn, hn); offset++)
			words.push(word(base[cursor.base + offset - 1], head[cursor.head + offset - 1]));
		return words;
	}

	function lineKind(offset: number, bn: number, hn: number): "pair" | "del" | "add" {
		if (offset >= bn) return "add";
		return offset < hn ? "pair" : "del";
	}

	function lineNumber(offset: number, count: number, start: number): number | undefined {
		return offset < count ? start + offset : undefined;
	}

	function hunkLines(
		rows: ExplorerCodeRow[],
		cursor: Cursor,
		bn: number,
		hn: number,
		words: ReturnType<ExplorerModel["word"]>[],
		split: boolean,
	) {
		if (split) {
			for (let offset = 0; offset < Math.max(bn, hn); offset++)
				rows.push({
					type: "line",
					kind: lineKind(offset, bn, hn),
					base: lineNumber(offset, bn, cursor.base),
					head: lineNumber(offset, hn, cursor.head),
					word: words[offset],
				});
		} else {
			for (let offset = 0; offset < bn; offset++)
				rows.push({ type: "line", kind: "del", base: cursor.base + offset, word: words[offset] });
			for (let offset = 0; offset < hn; offset++)
				rows.push({ type: "line", kind: "add", head: cursor.head + offset, word: words[offset] });
		}
		cursor.base += bn;
		cursor.head += hn;
	}

	// The Git zero-count coordinate picks the line before or after an empty side.
	function startOf(start: number, count: number) {
		return start + (count === 0 ? 1 : 0);
	}

	function project(base: string[], head: string[], hunks: ExplorerHunk[], split: boolean): ExplorerCodeRow[] {
		const rows: ExplorerCodeRow[] = [];
		const cursor: Cursor = { base: 1, head: 1 };
		for (const [index, hunk] of hunks.entries()) {
			const bs = startOf(hunk.baseStart, hunk.baseCount);
			const hs = startOf(hunk.headStart, hunk.headCount);
			const gap = Math.min(
				bs - cursor.base,
				hs - cursor.head,
				base.length - cursor.base + 1,
				head.length - cursor.head + 1,
			);
			contextRows(rows, cursor, Math.max(0, gap), index > 0 ? 3 : 0, 3);
			rows.push({
				type: "hunk",
				label: `@@ −${hunk.baseStart},${hunk.baseCount} +${hunk.headStart},${hunk.headCount} @@`,
			});
			cursor.base = bs;
			cursor.head = hs;
			const bn = Math.max(0, Math.min(hunk.baseCount, base.length - cursor.base + 1));
			const hn = Math.max(0, Math.min(hunk.headCount, head.length - cursor.head + 1));
			hunkLines(rows, cursor, bn, hn, wordPairs(base, head, cursor, bn, hn), split);
		}
		if (hunks.length)
			contextRows(
				rows,
				cursor,
				Math.max(0, Math.min(base.length - cursor.base + 1, head.length - cursor.head + 1)),
				3,
				0,
			);
		return rows;
	}

	function source(item: ExplorerExcerpt): string {
		const span =
			item.start === undefined
				? ""
				: item.end && item.end !== item.start
					? `, lines ${item.start}–${item.end}`
					: `, line ${item.start}`;
		const reference = `${item.path}${span}, at ${item.commit ? item.commit.slice(0, 7) : "working tree"}${item.id ? ` (note ${item.id})` : ""}`;
		if (item.quote === undefined) return reference;
		const fence = "`".repeat(Math.max(3, ...[...item.quote.matchAll(/`+/g)].map((match) => match[0].length + 1)));
		const id = language(item.path).id;
		return `${reference}\n${fence}${id === "text" ? "" : id}\n${item.quote}\n${fence}`;
	}

	function excerpt(root: string, scope: string, items: ExplorerExcerpt[]): string {
		return `Review comments on ${root}, ${scope} (${items.length} comment${items.length === 1 ? "" : "s"})\n\n${items.map((item, index) => `${index + 1}. ${source(item)}\n${item.text}`).join("\n\n")}`;
	}

	function size(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
	}

	const app = {
		request,
		receive(value: unknown) {
			if (!value || typeof value !== "object") return;
			const event = value as Partial<ExplorerEvent>;
			if (event.v !== 1 || !event.type || !eventTypes.has(event.type)) return;
			for (const listener of listeners) listener(event as ExplorerEvent);
		},
		listen(cb: (event: ExplorerEvent) => void) {
			listeners.push(cb);
		},
		model: { lines, language, fuzzy, find, project, word, excerpt, source, size },
	};
	window.explorer = app as ExplorerApp;
})();
