(() => {
	const isMarkdown = (path: string) => /[^/]\.(?:md|markdown)$/iu.test(path);

	function sourceSpan(sourcepos: string): ExplorerRange | null {
		const match = /^(\d+):\d+-(\d+):\d+$/u.exec(sourcepos);
		if (!match) return null;
		const start = Number(match[1]),
			end = Number(match[2]);
		return start >= 1 && end >= start && Number.isSafeInteger(end) ? { side: "head", start, end } : null;
	}

	function cover(ranges: Iterable<ExplorerRange>): ExplorerRange | null {
		let start = Infinity,
			end = 0;
		for (const range of ranges) {
			start = Math.min(start, range.start);
			end = Math.max(end, range.end);
		}
		return end ? { side: "head", start, end } : null;
	}

	function slugs() {
		const used = new Set<string>();
		const counts = new Map<string, number>();
		return (text: string) => {
			const base = text
				.toLowerCase()
				.replace(/[^\p{L}\p{M}\p{N}_ -]/gu, "")
				.replaceAll(" ", "-");
			let slug = base,
				suffix = counts.get(base) ?? 0;
			while (used.has(slug)) slug = `${base}-${++suffix}`;
			counts.set(base, suffix);
			used.add(slug);
			return slug;
		};
	}

	function relativePath(name: string, current: string) {
		if (/^(?:$|\/)|[:\\\p{Cc}]|(?:^|\/)\.git(?:\/|$)/iu.test(name)) return null;
		const parts = current.split("/").slice(0, -1);
		for (const part of name.split("/")) {
			if (!part || part === ".") continue;
			if (part !== "..") {
				parts.push(part);
				continue;
			}
			if (!parts.length) return null;
			parts.pop();
		}
		return parts.join("/");
	}

	function localLink(destination: string, current: string): ExplorerMarkdownLink | null {
		const hash = destination.indexOf("#");
		const fragment = hash < 0 ? "" : decodeURIComponent(destination.slice(hash + 1));
		if (hash === 0) return { kind: "fragment", fragment };
		const address = hash < 0 ? destination : destination.slice(0, hash);
		const path = relativePath(decodeURIComponent(address.split("?", 1)[0]), current);
		return path === null ? null : { kind: "file", path, fragment };
	}

	function link(destination: string, path: string): ExplorerMarkdownLink | null {
		if (!destination || /^[/\\]/u.test(destination) || /\p{Cc}/u.test(destination)) return null;
		const scheme = /^[a-z][a-z0-9+.-]*:/iu.exec(destination)?.[0].toLowerCase();
		if (scheme) return ["http:", "https:", "mailto:"].includes(scheme) ? { kind: "external", url: destination } : null;
		try {
			return localLink(destination, path);
		} catch {
			return null;
		}
	}

	window.explorer.markdown = { isMarkdown, sourceSpan, cover, slugs, link };
})();
