(() => {
	const app = window.explorer;
	const { el } = app.dom;
	const rendered = new Map<string, string>();
	const pending = new Map<string, Promise<string>>();
	const aliases: Record<string, string> = {
		typescript: "ts",
		javascript: "js",
		python: "py",
		shell: "sh",
		console: "sh",
		ruby: "rb",
		rust: "rs",
		golang: "go",
		markdown: "md",
		dockerfile: "Dockerfile",
		makefile: "Makefile",
	};

	// Rendered HTML for card text; the host renders Markdown without raw HTML.
	function markup(text: string) {
		const known = pending.get(text);
		if (known) return known;
		const next = app.request("markdown.text", { text }).then((result) => {
			if (rendered.size >= 256) rendered.delete(rendered.keys().next().value as string);
			rendered.set(text, result.html);
			pending.delete(text);
			return result.html;
		});
		next.catch(() => pending.delete(text));
		pending.set(text, next);
		return next;
	}

	function language(name: string) {
		const lower = name.toLowerCase();
		const direct = app.model.language(`snippet.${lower}`);
		if (direct.id !== "text") return direct.id;
		const alias = aliases[lower];
		if (!alias) return "text";
		return app.model.language(/^[A-Z]/u.test(alias) ? alias : `snippet.${alias}`).id;
	}

	function highlight(code: HTMLElement) {
		const match = /(?:^|\s)language-([\w+#.-]+)/u.exec(code.className);
		const id = match ? language(match[1]) : "text";
		if (id === "text") return;
		const text = code.textContent ?? "";
		const spans = app.syntax(text, id);
		if (spans.length) code.replaceChildren(paint(text, spans));
	}

	function paint(text: string, spans: ExplorerSpan[]) {
		const out = document.createDocumentFragment();
		let at = 0;
		for (const span of spans) {
			if (span.start < at) continue;
			if (span.start > at) out.append(text.slice(at, span.start));
			out.append(el("span", `syn-${span.role}`, text.slice(span.start, span.end)));
			at = span.end;
		}
		if (at < text.length) out.append(text.slice(at));
		return out;
	}

	function lineFragment(fragment: string) {
		const match = /^L(\d+)(?:-L?(\d+))?$/u.exec(fragment);
		if (!match) return null;
		const start = Number(match[1]),
			end = Number(match[2] ?? match[1]);
		return start >= 1 && end >= start ? { start, end } : null;
	}

	// The navigation target of a Markdown link destination.
	function linkTarget(destination: string, options: ExplorerRichOptions): ExplorerRichTarget | null {
		const link = app.markdown.link(destination, options.path ?? "");
		if (!link) return null;
		if (link.kind === "external") return { kind: "url", url: link.url };
		const lines = lineFragment(link.fragment);
		if (link.kind === "fragment") return lines && options.path ? { kind: "lines", path: options.path, ...lines } : null;
		return lines ? { kind: "lines", path: link.path, ...lines } : { kind: "file", path: link.path };
	}

	function describe(target: ExplorerRichTarget) {
		switch (target.kind) {
			case "url":
				return `Open ${target.url}`;
			case "file":
				return `Open ${target.path}`;
			case "lines":
				return `Go to ${target.path ?? "this file"} ${app.references.lineLabel(target.start, target.end)}`;
			case "commit":
				return `Review commit ${target.commit}`;
			case "range":
				return `Review ${target.base}..${target.head}`;
		}
	}

	function activate(anchor: HTMLAnchorElement, target: ExplorerRichTarget, options: ExplorerRichOptions) {
		anchor.href = "#";
		anchor.title = describe(target);
		anchor.classList.add("ref", `ref-${target.kind}`);
		anchor.onclick = (event) => {
			event.preventDefault();
			event.stopPropagation();
			if (window.getSelection()?.isCollapsed === false) return;
			options.open(target);
		};
	}

	function referenceTarget(ref: ExplorerReference, options: ExplorerRichOptions): ExplorerRichTarget | null {
		if (ref.kind !== "lines") return ref;
		const path = ref.path ?? options.path;
		return path ? { ...ref, path } : null;
	}

	// Turns code locations and commits named in plain text into links.
	function linkText(node: Text, options: ExplorerRichOptions) {
		const text = node.data;
		const found = app.references.find(text);
		if (!found.length) return;
		const out = document.createDocumentFragment();
		let at = 0;
		for (const item of found) {
			const target = referenceTarget(item.ref, options);
			if (!target) continue;
			out.append(text.slice(at, item.start));
			const anchor = el("a", "", text.slice(item.start, item.end));
			activate(anchor, target, options);
			out.append(anchor);
			at = item.end;
		}
		if (!at) return;
		out.append(text.slice(at));
		node.replaceWith(out);
	}

	function enhance(root: DocumentFragment | HTMLElement, options: ExplorerRichOptions) {
		for (const anchor of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
			const target = linkTarget(anchor.getAttribute("href") ?? "", options);
			if (target) activate(anchor, target, options);
			else anchor.removeAttribute("href");
		}
		for (const image of root.querySelectorAll("img")) image.replaceWith(image.getAttribute("alt") ?? "");
		for (const code of root.querySelectorAll<HTMLElement>("pre > code")) highlight(code);
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
			acceptNode: (node) =>
				node.parentElement?.closest("a, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
		});
		const texts: Text[] = [];
		while (walker.nextNode()) texts.push(walker.currentNode as Text);
		for (const text of texts) linkText(text, options);
	}

	// Plain paragraphs shown until the rendered Markdown arrives.
	function plain(text: string) {
		const out = document.createDocumentFragment();
		for (const block of text.split(/\n{2,}/u)) if (block.trim()) out.append(el("p", "plain", block));
		return out;
	}

	function fill(node: HTMLElement, html: string, options: ExplorerRichOptions) {
		const template = document.createElement("template");
		template.innerHTML = html;
		enhance(template.content, options);
		for (const table of template.content.querySelectorAll("table")) {
			const frame = el("div", "rich-table");
			table.replaceWith(frame);
			frame.append(table);
		}
		node.replaceChildren(template.content);
	}

	// Card text as Markdown, with links to the code locations and commits it names.
	function render(text: string, options: ExplorerRichOptions): HTMLElement {
		const node = el("div", "rich");
		const known = rendered.get(text);
		if (known !== undefined) {
			fill(node, known, options);
			return node;
		}
		const fallback = plain(text);
		enhance(fallback, options);
		node.append(fallback);
		markup(text).then(
			(html) => {
				fill(node, html, options);
				options.changed?.();
			},
			() => {},
		);
		return node;
	}

	app.rich = { render };
})();
