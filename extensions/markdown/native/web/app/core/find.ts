((): void => {
	const root = globalThis as unknown as { reader: ReaderCoreAPI };
	const api = root.reader ?? ({} as ReaderCoreAPI);
	root.reader = api;
	const special = /[\\^$.*+?()[\]{}|]/g;
	function escapePattern(query: string): string {
		return query.replace(special, "\\$&");
	}
	// Matching runs the query as an escaped literal against the original text, so a case fold that
	// expands (for example U+0130 to "i" plus a combining dot) never moves the reported UTF-16
	// offsets. Unicode simple case folding also differs from lowercasing: "i" does not match U+0130.
	function literal(query: string): (text: string) => ReaderRange[] {
		if (!query) return () => [];
		const pattern = new RegExp(escapePattern(query), "giu");
		return (text) => {
			const found: ReaderRange[] = [];
			for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
				const start = match.index;
				found.push({ start, end: start + match[0].length });
			}
			return found;
		};
	}
	api.find = { literal };
})();
