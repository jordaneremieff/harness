(() => {
	const { el, get, icon, glyph } = window.explorer.dom;
	const modes = [
		["system", "System", "system"],
		["light", "Light", "sun"],
		["dark", "Dark", "moon"],
	] as const;
	const flavours = [
		["frappe", "Frappé"],
		["macchiato", "Macchiato"],
		["mocha", "Mocha"],
	] as const;

	/** The Appearance panel: the machine's shared pane appearance. */
	function appearance(save: (patch: Partial<ExplorerAppearance>) => void): ExplorerAppearanceView {
		const root = document.documentElement;
		const panel = get("appearance-panel");
		glyph(get("appearance"), "appearance");
		let current: ExplorerAppearance = { appearance: "system", darkTheme: "frappe" };

		function choose(patch: Partial<ExplorerAppearance>) {
			apply({ ...current, ...patch });
			save(patch);
		}
		function section(title: string, ...children: Node[]) {
			const node = el("section", "set-sec");
			node.append(el("h3", "set-head", title), ...children);
			return node;
		}
		const group = el("div", "seg set-seg");
		group.setAttribute("role", "group");
		group.setAttribute("aria-label", "Appearance");
		const modeButtons = modes.map(([mode, label, image]) => {
			const node = el("button", "seg-b");
			node.type = "button";
			node.append(icon(image), el("span", "", label));
			node.addEventListener("click", () => choose({ appearance: mode }));
			group.append(node);
			return [mode, node] as const;
		});
		const swatches = el("div", "swatches");
		swatches.setAttribute("role", "radiogroup");
		swatches.setAttribute("aria-label", "Dark theme");
		const flavourButtons = flavours.map(([flavour, name]) => {
			const node = el("button", "swatch");
			node.type = "button";
			node.dataset.flavour = flavour;
			node.dataset.ctpDark = flavour;
			node.setAttribute("role", "radio");
			const preview = el("span", "sw-preview");
			preview.setAttribute("aria-hidden", "true");
			const dots = el("span", "sw-dots");
			dots.append(el("i"), el("i"), el("i"));
			preview.append(el("span", "sw-aa", "Aa"), dots);
			node.append(preview, el("span", "sw-name", name));
			node.addEventListener("click", () => choose({ darkTheme: flavour }));
			swatches.append(node);
			return [flavour, node] as const;
		});
		panel.replaceChildren(
			section("Appearance", group),
			section("Dark theme", swatches, el("p", "set-note", "Light appearance uses Latte.")),
		);
		function apply(value: ExplorerAppearance) {
			current = { appearance: value.appearance, darkTheme: value.darkTheme };
			root.dataset.theme = current.appearance;
			root.dataset.dark = current.darkTheme;
			for (const [mode, node] of modeButtons) node.setAttribute("aria-pressed", String(current.appearance === mode));
			for (const [flavour, node] of flavourButtons)
				node.setAttribute("aria-checked", String(current.darkTheme === flavour));
		}
		apply(current);
		return { apply };
	}
	window.explorer.appearance = appearance;
})();
