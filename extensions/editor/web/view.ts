type TextBlock = { kind: "text" | "code"; text: string };
type LocationBlock = { kind: "location"; text: string; doc: string; line: number };

export type ComposedView = {
	id: string;
	title: string;
	rev: number;
	author: string;
	blocks: (TextBlock | LocationBlock)[];
};

export function renderView(
	container: HTMLElement,
	view: ComposedView,
	{ openLocation }: { openLocation: (doc: string, line: number) => void },
): void {
	const document = container.ownerDocument;
	const sameView = container.firstElementChild?.getAttribute("data-view-id") === view.id;
	const previous = document.activeElement;
	const activeLocation = sameView && container.contains(previous) ? previous?.getAttribute("data-location") : undefined;
	const scrollTop = sameView ? container.scrollTop : 0;
	let restoreFocus: HTMLButtonElement | undefined;

	function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className?: string, text?: string) {
		const node = document.createElement(tag);
		if (className) node.className = className;
		if (text !== undefined) node.textContent = text;
		return node;
	}

	const article = element("article", "editor-composed-page");
	article.dataset.viewId = view.id;
	const header = element("header", "editor-composed-header");
	header.append(element("h1", undefined, view.title), element("p", undefined, `Composed by ${view.author}`));
	article.append(header);

	for (const block of view.blocks) {
		if (block.kind === "text") {
			article.append(element("p", "editor-composed-text", block.text));
		} else if (block.kind === "code") {
			const pre = element("pre", "editor-composed-code");
			pre.append(element("code", undefined, block.text));
			article.append(pre);
		} else if (block.kind === "location") {
			const { doc, line, text } = block;
			const button = element("button", "editor-composed-location");
			button.type = "button";
			button.dataset.location = JSON.stringify([doc, line, text]);
			button.append(
				element("span", "editor-composed-label", text || "Open location"),
				element("span", "editor-composed-path", `${doc}:${line}`),
			);
			button.addEventListener("click", () => openLocation(doc, line));
			if (!restoreFocus && button.dataset.location === activeLocation) restoreFocus = button;
			article.append(button);
		}
	}

	container.classList.add("editor-composed");
	container.replaceChildren(article);
	restoreFocus?.focus({ preventScroll: true });
	container.scrollTop = scrollTop;
}
