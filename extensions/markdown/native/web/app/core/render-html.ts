(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	type Policy = { createHTML(source: string): string };
	const policies = new WeakMap<Document, Policy>();
	api.setRenderedHTML = (element, html) => {
		const document = element.ownerDocument;
		const types = (
			document.defaultView as unknown as {
				trustedTypes?: { createPolicy(name: string, rules: { createHTML(source: string): string }): Policy };
			}
		).trustedTypes;
		if (!types) {
			element.innerHTML = html;
			return;
		}
		let policy = policies.get(document);
		if (!policy) {
			policy = types.createPolicy("cmark", { createHTML: (source) => source });
			policies.set(document, policy);
		}
		element.innerHTML = policy.createHTML(html);
	};
})();
