(() => {
	const maxRows = 12;
	interface Extents {
		draft: number; editorPadding: number; line: number; chrome: number;
		queue: number; images: number; gap: number;
	}
	function rows(count: number): number {
		return Math.min(maxRows, Math.max(1, count));
	}
	function stack({ draft, editorPadding, line, chrome, queue, images, gap }: Extents, viewport: number) {
		const fixed = chrome + editorPadding + (images ? images + gap : 0);
		// The queue follows run state. It consumes space in the pane, not in the native fit request.
		const usable = viewport - fixed - (queue ? queue + gap : 0);
		const draftRows = rows(Math.round((draft - editorPadding) / line));
		return {
			height: Math.ceil(fixed + draftRows * line),
			visibleRows: rows(Math.floor(usable / line)),
			tight: usable < line,
		};
	}
	function element<T extends HTMLElement>(selector: string): T {
		const node = document.querySelector<T>(selector);
		if (!node) throw Error(`Missing composer element: ${selector}`);
		return node;
	}
	function mount(input: HTMLTextAreaElement, report: (height: number) => void) {
		const panel = element<HTMLElement>(".composer");
		const area = element<HTMLElement>(".edit-area");
		const measure = element<HTMLTextAreaElement>("#measure");
		const inset = element<HTMLElement>(".panel");
		const writer = element<HTMLElement>(".writer");
		const shelf = element<HTMLElement>(".shelf");
		const footer = element<HTMLElement>("footer.status");
		const queue = element<HTMLElement>(".queued");
		const images = element<HTMLElement>(".images");
		let last: number | undefined;
		const block = (el: HTMLElement) => el.getBoundingClientRect().height;
		const px = (value: string) => Number.parseFloat(value) || 0;
		const padding = (style: CSSStyleDeclaration) => px(style.paddingTop) + px(style.paddingBottom);
		const edges = (style: CSSStyleDeclaration) => padding(style) + px(style.borderTopWidth) + px(style.borderBottomWidth);
		function extents(): Extents {
			const style = getComputedStyle(measure), writerStyle = getComputedStyle(writer), insetStyle = getComputedStyle(inset);
			const gap = px(writerStyle.rowGap);
			const chrome = edges(writerStyle) + edges(insetStyle) + px(insetStyle.rowGap) + block(footer) + block(shelf) + gap;
			return { draft: block(measure), chrome, gap, editorPadding: padding(style), line: px(style.lineHeight), queue: block(queue), images: block(images) };
		}
		function reportFit(natural: number, hasDraft: boolean) {
			const height = hasDraft ? Math.max(last ?? 0, natural) : natural;
			if (last === height) return;
			last = height;
			report(height);
		}
		function updateFades() {
			area.toggleAttribute("data-clipped-top", input.scrollTop > 1);
			area.toggleAttribute("data-clipped-bottom", input.scrollHeight - input.clientHeight - input.scrollTop > 1);
		}
		input.addEventListener("scroll", updateFades, { passive: true });
		function sync() {
			const text = input.value;
			if (measure.value !== text) measure.value = text;
			// Measure the request in normal spacing, even if the current pane is too short.
			panel.removeAttribute("data-tight");
			const parts = extents(), viewport = block(panel);
			if (!parts.draft || !parts.line) return;
			const normal = stack(parts, viewport);
			panel.toggleAttribute("data-tight", normal.tight);
			const visible = normal.tight ? stack(extents(), viewport) : normal;
			panel.style.setProperty("--visible-rows", String(visible.visibleRows));
			updateFades();
			// The image tray may still show the old draft when an edit clears the field.
			const natural = text ? normal.height : stack({ ...parts, images: 0 }, viewport).height;
			reportFit(natural, text.length > 0);
		}
		const observer = new ResizeObserver(sync);
		for (const el of [panel, queue, images]) observer.observe(el);
		return sync;
	}
	Object.assign(globalThis, { composerLayout: { mount, stack } });
})();
