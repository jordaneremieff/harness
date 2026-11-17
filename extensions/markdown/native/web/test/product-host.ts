(() => {
	const api = (
		globalThis as unknown as {
			reader: ReaderNamespace & {
				fixtures: { render(source: string): ReaderMappedBlock[]; document(source?: string): ReaderCoreDocument };
				boot(host: ReaderCoreHost): { controller: ReaderController; editor: ReaderEditor; ui: unknown };
			};
		}
	).reader;
	const rich = "A paragraph with **bold words**, *italic words*, `code` and [a link](https://example.test).";
	const code = "const answer = 42;\n",
		fence = "```typescript\n",
		codeBlock = `${fence}${code}\x60\x60\x60`;
	const source = `# Reader fixture\n\n${rich}\n\n## A second section\n\n- A list item\n\n${codeBlock}\n\nThe agent works on this passage.\n\n## Last section\n\nA quiet closing paragraph.`;
	function render(value: string) {
		const blocks = api.fixtures.render(value);
		for (const block of blocks) {
			const raw = value.slice(block.start, block.end);
			if (raw === rich)
				block.html =
					'<p>A paragraph with <strong>bold words</strong>, <em>italic words</em>, <code>code</code> and <a href="https://example.test">a link</a>.</p>';
			if (raw === codeBlock) {
				block.type = "code";
				block.html = `<pre><code class="language-typescript">${code}</code></pre>`;
				block.map = [[0, code.length, block.start + fence.length, code.length]];
			}
		}
		return blocks;
	}
	const payload = api.fixtures.document(source);
	payload.blocks = render(source);
	payload.headings = [
		{ level: 1, text: "Reader fixture", anchor: "reader-fixture", start: 0 },
		{ level: 2, text: "A second section", anchor: "second-section", start: source.indexOf("## A second") },
		{ level: 2, text: "Last section", anchor: "last-section", start: source.indexOf("## Last") },
	];
	const host = api.createMemoryHost(payload, render);
	const app = api.boot(host);
	document.documentElement.dataset.checkMode = "";
	const check = { ...app, host, payload };
	(globalThis as unknown as { readerProduct: typeof check }).readerProduct = check;
})();
