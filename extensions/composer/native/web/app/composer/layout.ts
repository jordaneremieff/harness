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
	function mount(input: HTMLTextAreaElement, report: (height: number) => Promise<Record<string, unknown>>, revealCaret?: () => void) {
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
		let pane = 0, growth = 0, predicted = 0, revision = 0;
		function updateFades() {
			const top = input.scrollTop, bottom = input.scrollHeight - input.clientHeight - top;
			area.toggleAttribute("data-clipped-top", top > 1);
			area.toggleAttribute("data-clipped-bottom", bottom > 1);
		}
		input.addEventListener("scroll", updateFades, { passive: true });
		function viewport(nextPane: number, nextGrowth: number) {
			if (pane === nextPane && growth === nextGrowth) return;
			pane = nextPane;
			growth = nextGrowth;
			measureLayout();
		}
		function settle(id: number, above: unknown) {
			if (id !== revision) return;
			const requested = predicted;
			predicted = 0;
			if (typeof above === "number" && Number.isFinite(above) && above >= 0) growth = above;
			measureLayout();
			if (requested > pane + growth) revealCaret?.();
		}
		function paintPaper(parts: Extents) {
			const paper = Math.max(pane + growth, predicted);
			panel.style.setProperty("--paper-height", `${paper}px`);
			const normal = stack(parts, paper);
			panel.toggleAttribute("data-tight", normal.tight);
			const visible = normal.tight ? stack(extents(), paper) : normal;
			panel.style.setProperty("--visible-rows", String(visible.visibleRows));
			updateFades();
		}
		function requestedHeight(text: string, parts: Extents, confirmed: number) {
			const natural = stack(text ? parts : { ...parts, images: 0 }, confirmed).height;
			return text ? Math.max(last ?? 0, natural) : natural;
		}
		function measureLayout() {
			if (!pane) return;
			const text = input.value;
			panel.removeAttribute("data-tight");
			const parts = extents(), confirmed = pane + growth;
			const height = requestedHeight(text, parts, confirmed);
			const changed = height !== last;
			if (changed) predicted = text && height > confirmed ? height : 0;
			paintPaper(parts);
			if (!changed) return;
			last = height;
			const id = ++revision;
			void report(height).then(reply => settle(id, reply.above), () => settle(id, growth));
		}
		const observer = new ResizeObserver(measureLayout);
		for (const el of [panel, queue, images, measure, footer, shelf, input]) observer.observe(el);
		function sync() {
			if (measure.value !== input.value) measure.value = input.value;
			// Clearing a short draft can leave the measuring field at the same size.
			if (!input.value && last !== undefined) measureLayout();
		}
		return Object.assign(sync, { viewport });
	}
	Object.assign(globalThis, { composerLayout: { mount, stack } });
})();
