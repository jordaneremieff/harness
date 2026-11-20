(() => {
	const app = window.explorer;
	const { el } = app.dom;
	const { sourceSpan, cover, link, slugs } = app.markdown;
	type Block = { node: HTMLElement; span: ExplorerRange; children: Block[] };
	type Options = ExplorerCodeOptions & { html?: string };

	type TextPart = { node: Text; start: number; end: number };

	function prepareImages(content: DocumentFragment) {
		for (const img of content.querySelectorAll("img")) {
			const source = img.getAttribute("src") ?? "";
			const alt = () => img.replaceWith(el("span", "markdown-image-alt", img.alt));
			if (/^explorer-asset:\/\/image\/[0-9a-f-]+$/u.test(source)) {
				img.loading = "lazy";
				img.addEventListener("error", alt, { once: true });
			} else alt();
		}
	}

	function prepareBlocks(content: DocumentFragment) {
		for (const task of content.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) task.disabled = true;
		for (const node of content.querySelectorAll<HTMLElement>("pre > code")) colourCode(node);
		for (const table of content.querySelectorAll("table")) {
			const wrapper = el("div", "markdown-table");
			table.replaceWith(wrapper);
			wrapper.append(table);
		}
	}

	function* textNodes(root: Node) {
		if (root instanceof Text) yield root;
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		for (let node = walker.nextNode(); node; node = walker.nextNode()) yield node as Text;
	}

	function touchesText(range: Range, text: Text) {
		const from = text === range.startContainer ? range.startOffset : 0;
		const to = text === range.endContainer ? range.endOffset : text.length;
		return range.intersectsNode(text) && !!text.data.slice(from, to).trim();
	}

	function noteRange(note: ExplorerNote, opts: Options | null): ExplorerRange | null {
		if (note.state === "resolved" || note.location === "outdated" || note.side !== "head" || note.path !== opts?.path)
			return null;
		const matches = (start: number, end: number) =>
			end <= opts.head.length && opts.head.slice(start - 1, end).join("\n") === note.anchor.quote;
		if (matches(note.start, note.end)) return note;
		const { start, end } = note.anchor;
		return matches(start, end) ? { side: "head", start, end } : null;
	}

	function textRange(parts: TextPart[], start: number, end: number) {
		const first = parts[firstWhere(parts, (part) => part.end > start)];
		const last = parts[firstWhere(parts, (part) => part.end >= end)];
		const range = new Range();
		range.setStart(first.node, start - first.start);
		range.setEnd(last.node, end - last.start);
		return range;
	}

	function colourCode(node: HTMLElement) {
		const fence = [...node.classList].find((name) => name.startsWith("language-"))?.slice(9);
		if (!fence) return;
		const extension =
			{ typescript: "ts", javascript: "js", python: "py", rust: "rs", shell: "sh" }[fence.toLowerCase()] ?? fence;
		const language = app.model.language(`fence.${extension}`);
		if (language.id === "text") return;
		const lines = (node.textContent ?? "").split("\n");
		const syntax = app.syntaxFile(lines, language.id);
		const result = document.createDocumentFragment();
		lines.forEach((line, index) => {
			if (index) result.append("\n");
			let offset = 0;
			for (const { start, end, role } of syntax(index)) {
				if (start > offset) result.append(line.slice(offset, start));
				result.append(el("span", `syn-${role}`, line.slice(start, end)));
				offset = end;
			}
			if (offset < line.length) result.append(line.slice(offset));
		});
		node.replaceChildren(result);
	}

	function firstWhere<T>(items: T[], test: (item: T) => boolean) {
		let left = 0,
			right = items.length;
		while (left < right) {
			const mid = (left + right) >>> 1;
			if (test(items[mid])) right = mid;
			else left = mid + 1;
		}
		return left;
	}

	app.preview = (body, follow) => {
		const article = el("article", "markdown-preview");
		let opts: Options | null = null;
		let roots: Block[] = [];
		const mapped = new Map<Element, Block>();
		const headings = new Map<string, HTMLElement>();
		const painted = new Map<HTMLElement, ExplorerNote[]>();
		const matches = new Map<ExplorerMatch, Range>();
		let selected: Block[] = [],
			flashed: HTMLElement | null = null;
		let flashTimer = 0,
			clickTimer = 0;
		const target = (node: Node | null) => (node instanceof Element ? node : node?.parentElement);
		const blockAt = (node: Node | null) => {
			for (let element = target(node); element && element !== article; element = element.parentElement) {
				const block = mapped.get(element);
				if (block) return block;
			}
			return undefined;
		};
		function clear() {
			opts = null;
			roots = [];
			mapped.clear();
			headings.clear();
			painted.clear();
			matches.clear();
			selected = [];
			flashed = null;
			clearTimeout(flashTimer);
			clearTimeout(clickTimer);
			CSS.highlights?.delete("explorer-preview-find");
			CSS.highlights?.delete("explorer-preview-current");
			article.replaceChildren();
			article.remove();
		}
		function bindLinks(content: DocumentFragment, path: string) {
			for (const a of content.querySelectorAll("a[href]")) {
				const destination = link(a.getAttribute("href") ?? "", path);
				if (!destination) a.removeAttribute("href");
				else
					a.addEventListener("click", (event) => {
						event.preventDefault();
						clearTimeout(clickTimer);
						if (window.getSelection()?.isCollapsed !== false) follow(destination);
					});
			}
		}
		function indexHeadings(content: DocumentFragment) {
			const slug = slugs();
			for (const heading of content.querySelectorAll<HTMLElement>("h1,h2,h3,h4,h5,h6")) {
				const name = slug(heading.textContent ?? "");
				// Namespace the element ID so a file heading cannot shadow an app control.
				heading.id = `preview-heading-${name}`;
				headings.set(name, heading);
			}
		}
		function indexBlocks(content: DocumentFragment) {
			for (const node of content.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
				const span = sourceSpan(node.dataset.sourcepos ?? "");
				if (!span) continue;
				const block = { node, span, children: [] };
				const parent = blockAt(node.parentElement);
				(parent?.children ?? roots).push(block);
				mapped.set(node, block);
			}
		}
		function show(next: Options) {
			clear();
			opts = next;
			const template = document.createElement("template");
			template.innerHTML = next.html ?? "";
			const content = template.content;
			prepareImages(content);
			bindLinks(content, next.path);
			indexHeadings(content);
			prepareBlocks(content);
			indexBlocks(content);
			article.style.setProperty("--preview-size", `${next.size}px`);
			article.append(content);
			if (!roots.length) article.append(el("p", "markdown-empty", "This file has no rendered Markdown content."));
			body.replaceChildren(article);
			body.scrollTo(0, 0);
			updateNotes(next.notes);
		}
		function blocksFor(range: ExplorerRange, nodes = roots, found: Block[] = []): Block[] {
			if (range.side !== "head") return found;
			for (let i = firstWhere(nodes, (block) => block.span.end >= range.start); i < nodes.length; i++) {
				const block = nodes[i];
				if (block.span.start > range.end) break;
				const before = found.length;
				blocksFor(range, block.children, found);
				if (before === found.length) found.push(block);
			}
			return found;
		}
		function forLine(line: number) {
			return (
				blocksFor({ side: "head", start: line, end: line })[0] ??
				roots[firstWhere(roots, (block) => block.span.end >= line)] ??
				roots.at(-1)
			);
		}
		const top = (node: Element) => node.getBoundingClientRect().top - body.getBoundingClientRect().top + body.scrollTop;
		function place(): ReturnType<ExplorerCodeView["place"]> {
			const edge = body.getBoundingClientRect().top;
			const at = (nodes: Block[]) =>
				nodes[firstWhere(nodes, (block) => block.node.getBoundingClientRect().bottom > edge)];
			let block = at(roots) ?? roots.at(-1);
			while (block) {
				const child = at(block.children);
				if (!child || child.node.getBoundingClientRect().top > edge) break;
				block = child;
			}
			return {
				line: block?.span.start ?? 1,
				side: "head",
				offset: block ? body.scrollTop - top(block.node) : body.scrollTop,
				left: 0,
			};
		}
		function flash(node: HTMLElement) {
			flashed?.classList.remove("markdown-jump");
			clearTimeout(flashTimer);
			flashed = node;
			node.classList.add("markdown-jump");
			flashTimer = window.setTimeout(() => node.classList.remove("markdown-jump"), 1600);
		}
		function jump(line: number, side: ExplorerSide = "head", nearTop = false) {
			if (side !== "head") return;
			const block = forLine(line);
			if (!block) return;
			body.scrollTop = top(block.node) - (nearTop ? 24 : body.clientHeight * 0.26);
			flash(block.node);
			opts?.onScroll(line);
		}
		function anchor(range: ExplorerRange | null) {
			if (!range) return null;
			const blocks = blocksFor(range);
			const bodyRect = body.getBoundingClientRect();
			let x = Infinity,
				y = Infinity,
				endX = -Infinity,
				endY = -Infinity;
			for (const { node } of blocks) {
				const rect = node.getBoundingClientRect();
				if (rect.bottom <= bodyRect.top || rect.top >= bodyRect.bottom) continue;
				x = Math.min(x, rect.left);
				y = Math.min(y, rect.top);
				endX = Math.max(endX, rect.right);
				endY = Math.max(endY, rect.bottom);
			}
			return Number.isFinite(y)
				? DOMRect.fromRect({
						x,
						y: Math.max(y, bodyRect.top),
						width: endX - x,
						height: Math.min(endY, bodyRect.bottom) - Math.max(y, bodyRect.top),
					})
				: null;
		}
		function selectedLines(dom: Range) {
			const base = dom.commonAncestorContainer;
			const spans = new Set<ExplorerRange>();
			for (const node of textNodes(article.contains(base) ? base : article)) {
				if (!touchesText(dom, node)) continue;
				const block = blockAt(node);
				if (block) spans.add(block.span);
			}
			return cover(spans);
		}
		function selection() {
			const selected = window.getSelection();
			if (!selected || selected.isCollapsed || !selected.rangeCount) return null;
			const dom = selected.getRangeAt(0);
			if (!article.isConnected || !dom.intersectsNode(article)) return null;
			const range = selectedLines(dom);
			return range ? { range, text: selected.toString(), rect: dom.getBoundingClientRect() } : null;
		}
		function paintNote(node: HTMLElement, note: ExplorerNote) {
			node.classList.add("has-note");
			const prior = painted.get(node);
			if (prior) prior.push(note);
			else painted.set(node, [note]);
		}
		function updateNotes(notes: ExplorerNote[]) {
			for (const node of painted.keys()) node.classList.remove("has-note", "has-draft", "has-agent");
			painted.clear();
			for (const note of notes) {
				const range = noteRange(note, opts);
				if (range) for (const { node } of blocksFor(range)) paintNote(node, note);
			}
			painted.forEach(tintNote);
		}
		function tintNote(notes: ExplorerNote[], node: HTMLElement) {
			node.classList.toggle(
				"has-draft",
				notes.some((note) => note.state === "draft"),
			);
			node.classList.toggle(
				"has-agent",
				notes.every((note) => note.author === "agent"),
			);
		}
		function plainClick(event: MouseEvent) {
			return (
				!event.defaultPrevented &&
				event.button === 0 &&
				event.detail <= 1 &&
				!event.shiftKey &&
				!event.metaKey &&
				!event.ctrlKey &&
				!event.altKey
			);
		}
		document.addEventListener("pointerdown", () => clearTimeout(clickTimer), true);
		article.addEventListener("click", (event) => {
			clearTimeout(clickTimer);
			if (!plainClick(event) || window.getSelection()?.isCollapsed === false) return;
			let block = blockAt(event.target as Node | null);
			while (block && !painted.has(block.node)) block = blockAt(block.node.parentElement);
			const notes = block ? painted.get(block.node) : undefined;
			if (notes?.length)
				clickTimer = window.setTimeout(() => {
					if (window.getSelection()?.isCollapsed !== false) opts?.onNote(notes);
				}, 500);
		});
		article.addEventListener("auxclick", (event) => {
			if (target(event.target as Node | null)?.closest("a")) event.preventDefault();
		});
		body.addEventListener("scroll", () => opts?.onScroll(place().line), { passive: true });

		function collectMatches(pattern: RegExp, block: Block, text: string, parts: TextPart[]) {
			for (const result of text.matchAll(pattern)) {
				const start = result.index,
					end = start + result[0].length;
				matches.set({ side: "head", line: block.span.start, start, end }, textRange(parts, start, end));
				if (matches.size === 10000) break;
			}
		}
		function textRun(walker: TreeWalker, node: Text | null, block: Block) {
			const parts: TextPart[] = [];
			let text = "";
			while (node && blockAt(node) === block) {
				parts.push({ node, start: text.length, end: text.length + node.length });
				text += node.data;
				node = walker.nextNode() as Text | null;
			}
			return { text, parts, next: node };
		}
		function find(query: string) {
			matches.clear();
			if (!query) return [];
			const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/ +/gu, "[ \\t\\n]+"), "giu");
			const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
			let node = walker.nextNode() as Text | null;
			while (node) {
				if (matches.size >= 10000) break;
				const block = blockAt(node);
				if (!block) {
					node = walker.nextNode() as Text | null;
					continue;
				}
				const run = textRun(walker, node, block);
				collectMatches(pattern, block, run.text, run.parts);
				node = run.next;
			}
			return [...matches.keys()];
		}
		return {
			show,
			clear,
			jump,
			place,
			anchor,
			selection,
			updateNotes,
			find,
			rowAt: (node) => blockAt(node)?.span ?? null,
			restore(saved) {
				const block = forLine(saved.line);
				body.scrollTop = (block ? top(block.node) : 0) + saved.offset;
			},
			highlight(range) {
				for (const block of selected) block.node.classList.remove("markdown-picked");
				selected = range ? blocksFor(range) : [];
				for (const block of selected) block.node.classList.add("markdown-picked");
			},
			marks(items, current) {
				if (!CSS.highlights || typeof Highlight !== "function") return;
				if (!items.length) matches.clear();
				const mark = new Highlight(...matches.values());
				const range = current && matches.get(current);
				const active = range ? new Highlight(range) : new Highlight();
				active.priority = 1;
				CSS.highlights.set("explorer-preview-find", mark);
				CSS.highlights.set("explorer-preview-current", active);
			},
			focusMatch(match) {
				const rect = matches.get(match)?.getBoundingClientRect();
				if (rect) body.scrollTop += rect.top - body.getBoundingClientRect().top - body.clientHeight * 0.26;
			},
			fragment(name) {
				const node = headings.get(name);
				if (node) {
					body.scrollTop = top(node) - 24;
					flash(node);
				}
			},
		};
	};
})();
