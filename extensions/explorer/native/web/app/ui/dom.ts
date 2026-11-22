(() => {
	const paths: Record<string, string> = {
		folder: "M2 16V4h5l2 2h9v10z",
		open: "M2 16V4h5l2 2h9v3M2 16l3-7h14l-3 7z",
		"promote-root": "M10 4h6v6M16 4 8 12M8 5H4v11h11v-4",
		file: "M5 2h7l4 4v12H5zM12 2v5h4",
		"new-file": "M11 2H4v16h12V7l-5-5v5h5M7 12h6M10 9v6",
		sidebar: "M2 3h16v14H2zM7 3v14",
		search: "M14 8a5 5 0 1 1-10 0 5 5 0 0 1 10 0zm-1 4 4 4",
		copy: "M7 6h10v11H7zM13 3H3v11",
		note: "M3 4h14v10H9l-4 3v-3H3z",
		ask: "M3 4h14v10H9l-4 3v-3H3zM8 7a2 2 0 1 1 3 2l-1 1m0 2h.1",
		back: "M8 5l-5 5 5 5M3 10h14",
		forward: "M12 5l5 5-5 5M3 10h14",
		up: "M5 12l5-5 5 5",
		down: "M5 8l5 5 5-5",
		tour: "M5 3v14l12-7z",
		close: "m5 5 10 10M15 5 5 15",
		check: "m4 10 4 4 8-8",
		branch:
			"M5 6v8M5 10c8 0 10-2 10-5M5 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm10-13a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
		list: "M7 5h10M7 10h10M7 15h10M3 5h.1M3 10h.1M3 15h.1",
		edit: "M4 13 14 3l3 3L7 16l-4 1zM12 5l3 3",
		trash: "M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11M9 9v5m2-5v5",
		bookmark: "M6 3h8v14l-4-3-4 3z",
		image: "M2 3h16v14H2zM3 14l4-5 4 4 3-3 3 4M13 6h.1",
		binary: "M5 2h7l4 4v12H5zM12 2v5h4M8 10h.1m4 0h.1m-4 4h.1m4 0h.1",
		error: "M10 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 4v5m0 3h.1",
		palette: "M3 4h14v12H3zM6 8l2 2-2 2m4 0h4",
	};
	function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
		const node = document.createElement(tag);
		if (cls) node.className = cls;
		if (text !== undefined) node.textContent = text;
		return node;
	}
	function get<T extends HTMLElement = HTMLElement>(id: string): T {
		const node = document.getElementById(id);
		if (!node) throw new Error(`Missing Explorer element ${id}.`);
		return node as T;
	}
	function icon(name: string): HTMLElement {
		const node = el("span", "ico");
		node.setAttribute("aria-hidden", "true");
		const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
		svg.setAttribute("viewBox", "0 0 20 20");
		svg.setAttribute("fill", "none");
		svg.setAttribute("stroke", "currentColor");
		svg.setAttribute("stroke-width", "1.55");
		svg.setAttribute("stroke-linecap", "round");
		svg.setAttribute("stroke-linejoin", "round");
		const shape = document.createElementNS(svg.namespaceURI, "path");
		shape.setAttribute("d", paths[name] ?? paths.file);
		svg.append(shape);
		node.append(svg);
		return node;
	}
	function button(text: string, action: () => void, cls = ""): HTMLButtonElement {
		const node = el("button", cls, text);
		node.type = "button";
		node.addEventListener("click", action);
		return node;
	}
	function glyph(node: HTMLElement, name: string) {
		node.replaceChildren(icon(name));
	}
	function iconButton(name: string, label: string, action: () => void): HTMLButtonElement {
		const node = button("", action, "icon-button");
		node.setAttribute("aria-label", label);
		node.title = label;
		glyph(node, name);
		return node;
	}
	window.explorer.dom = { el, get, icon, button, iconButton, glyph };
})();
