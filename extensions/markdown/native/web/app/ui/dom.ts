/// <reference lib="dom" />
(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const paths: Record<string, string> = {
		outline: "M4 4h16v16H4z M10 4v16 M6 8h2 M6 12h2 M6 16h2",
		search: "M16 16l5 5 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0",
		pen: "M4 20l1-5L16 4l4 4L9 19z M14 6l4 4",
		check: "M5 12l5 5L20 6",
		x: "M6 6l12 12 M18 6 6 18",
		chev: "m7 10 5 5 5-5",
		up: "m7 14 5-5 5 5",
		down: "m7 10 5 5 5-5",
		back: "m14 6-6 6 6 6",
		forward: "m10 6 6 6-6 6",
		ask: "M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2 M12 8v6 M9 11h6",
		spark: "M12 3c.6 5 2 6.4 7 7-5 .6-6.4 2-7 7-.6-5-2-6.4-7-7 5-.6 6.4-2 7-7 M19 16v5 M16.5 18.5h5",
		copy: "M9 9h11v11H9z M15 9V4H4v11h5",
		quote: "M10 7H5v6h5v1c0 2-2 3-4 3 M20 7h-5v6h5v1c0 2-2 3-4 3",
		bold: "M7 5h6a3.5 3.5 0 0 1 0 7H7z M7 12h7a3.5 3.5 0 0 1 0 7H7z",
		italic: "M10 5h8 M6 19h8 M15 5 9 19",
		code: "m8 7-5 5 5 5 M16 7l5 5-5 5",
		link: "M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-2 2 M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l2-2",
		doc: "M6 3h8l5 5v13H6z M14 3v6h5 M9 13h7 M9 17h5",
		file: "M3 7h7l2 2h9v11H3z M3 7V5h7l2 2",
		text: "M3 19 8 5l5 14 M5 14h6 M15 19l3-8 3 8 M16 16h4",
		minus: "M5 12h14",
		plus: "M5 12h14 M12 5v14",
		send: "M12 20V4 M6 10l6-6 6 6",
		undo: "m9 5-5 5 5 5 M4 10h10a5 5 0 0 1 0 10h-3",
		redo: "m15 5 5 5-5 5 M20 10H10a5 5 0 0 0 0 10h3",
		info: "M12 11v6 M12 7h.01 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
		clock: "M12 6v6l4 3 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0",
		compare: "M3 4h8v16H3z M13 4h8v16h-8z M5 9h4 M15 9h4 M5 13h4 M15 13h4",
		export: "M12 15V3 M7 8l5-5 5 5 M5 13v8h14v-8",
		archive: "M3 4h18v4H3z M5 8v12h14V8 M10 12h4",
		terminal: "M3 5h18v14H3z m4 4 4 3-4 3 M13 15h4",
		open: "M3 19V5h7l2 2h8v4 M3 19l3-8h16l-3 8z",
		new: "M6 3h8l5 5v13H6z M12 10v7 M9 13.5h6",
		image: "M3 5h18v14H3z m1 12 5-5 4 4 3-3 4 4 M8 8h.01",
		response: "M12 3c.5 5 2 6.5 7 7-5 .5-6.5 2-7 7-.5-5-2-6.5-7-7 5-.5 6.5-2 7-7",
		sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8 M12 2v2 M12 20v2 M4.9 4.9l1.4 1.4 M17.7 17.7l1.4 1.4 M2 12h2 M20 12h2 M4.9 19.1l1.4-1.4 M17.7 6.3l1.4-1.4",
		moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5",
		system: "M3 4h18v12H3z M8 20h8 M12 16v4",
		expand: "M14 4h6v6 M20 4l-7 7 M10 20H4v-6 M4 20l7-7",
	};
	function element<K extends keyof HTMLElementTagNameMap>(
		tag: K,
		attrs: Record<string, string> = {},
		...children: (Node | string | null | undefined)[]
	) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
		for (const child of children) if (child !== null && child !== undefined) node.append(child);
		return node;
	}
	function icon(name: string) {
		const ns = "http://www.w3.org/2000/svg",
			svg = document.createElementNS(ns, "svg"),
			path = document.createElementNS(ns, "path");
		svg.setAttribute("class", "i");
		svg.setAttribute("viewBox", "0 0 24 24");
		svg.setAttribute("aria-hidden", "true");
		path.setAttribute("d", paths[name] ?? paths.doc);
		svg.append(path);
		return svg;
	}
	function button(
		label: string,
		image: string,
		action: () => void,
		options: { iconOnly?: boolean; key?: string; className?: string } = {},
	) {
		const b = element("button", {
			type: "button",
			class: options.className ?? (options.iconOnly ? "btn-i" : "link"),
			"aria-label": label,
		});
		if (image) b.append(icon(image));
		if (options.iconOnly) {
			b.dataset.tip = label;
			if (options.key) b.dataset.key = options.key;
		} else b.append(element("span", {}, label));
		b.addEventListener("click", action);
		return b;
	}
	/** Writes a key combination such as "cmd+shift+C" in the Mac menu form "⇧⌘C". */
	function keys(combination: string) {
		const glyphs: Record<string, string> = { ctrl: "⌃", option: "⌥", shift: "⇧", cmd: "⌘" };
		const parts = combination.split("+");
		const key = parts.pop() ?? "";
		const named: Record<string, string> = { esc: "esc", return: "↩", enter: "↩", up: "↑", down: "↓" };
		return (
			["ctrl", "option", "shift", "cmd"]
				.filter((modifier) => parts.includes(modifier))
				.map((modifier) => glyphs[modifier])
				.join("") + (named[key.toLowerCase()] ?? key.toUpperCase())
		);
	}
	api.uiDOM = {
		keys,
		element,
		icon,
		button,
		clear: (el) => el.replaceChildren(),
		get: <T extends HTMLElement = HTMLElement>(selector: string) => {
			const el = document.querySelector<T>(selector);
			if (!el) throw new Error(`Missing reader element: ${selector}`);
			return el;
		},
	};
})();
