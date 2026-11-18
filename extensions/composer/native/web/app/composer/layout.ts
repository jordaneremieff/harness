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
	function mount(input: HTMLTextAreaElement, report: (height: number) => Promise<Record<string, unknown>>) {
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
		let visibleRows = 1, growthAbove = 0, revision = 0;
		let predicted = 0, before: number | undefined;
		let hold: { top: number; caret: number; timer: ReturnType<typeof setTimeout> } | undefined;
		function updateFades() {
			const top = input.scrollTop, bottom = input.scrollHeight - input.clientHeight - top;
			area.toggleAttribute("data-clipped-top", top > 1);
			area.toggleAttribute("data-clipped-bottom", bottom > 1);
		}
		function anchorScroll() {
			if (!hold) return;
			const top = input.scrollTop;
			if (top !== hold.top) { hold.caret = top; input.scrollTop = hold.top; }
		}
		function release(fallback: boolean) {
			if (!hold) return;
			clearTimeout(hold.timer);
			const top = fallback ? hold.caret : hold.top;
			hold = undefined;
			input.scrollTop = top;
		}
		function growth(above: number) {
			growthAbove = above;
			predicted = 0;
			release(above === 0);
			measureLayout();
		}
		function reportFit(natural: number, viewport: number, text: string) {
			const height = text ? Math.max(last ?? 0, natural) : natural;
			if (last === height) return;
			const id = ++revision, base = viewport - growthAbove;
			last = height;
			if (!text) release(false);
			else if (height > viewport && !hold && before !== undefined) {
				const top = before;
				hold = { top, caret: input.scrollTop, timer: setTimeout(() => { release(true); measureLayout(); }, 300) };
				anchorScroll();
			}
			void report(height).then(reply => {
				if (id !== revision || typeof reply.above !== "number" || !Number.isFinite(reply.above) || reply.above < 0) return;
				growthAbove = reply.above;
				predicted = reply.above ? base + reply.above : 0;
				release(reply.above === 0);
				measureLayout();
			}, () => { /* Keep the native scroll fallback deadline. */ });
		}
		input.addEventListener("beforeinput", () => { before = hold?.top ?? input.scrollTop; });
		input.addEventListener("scroll", () => { anchorScroll(); updateFades(); }, { passive: true });
		function measureLayout() {
			const text = input.value;
			// Measurement runs after layout on box size changes, not in the input listener.
			panel.removeAttribute("data-tight");
			const parts = extents(), actual = block(panel);
			if (!parts.draft) return;
			if (actual >= predicted) predicted = 0;
			const viewport = Math.max(actual, predicted), normal = stack(parts, viewport);
			const natural = text ? normal.height : stack({ ...parts, images: 0 }, viewport).height;
			reportFit(natural, actual, text);
			before = undefined;
			panel.toggleAttribute("data-tight", normal.tight);
			const visible = normal.tight ? stack(extents(), viewport) : normal;
			if (!hold) visibleRows = visible.visibleRows;
			panel.style.setProperty("--visible-rows", String(visibleRows));
			updateFades();
		}
		const observer = new ResizeObserver(measureLayout);
		for (const el of [panel, queue, images, measure, footer, shelf, input]) observer.observe(el);
		function sync() {
			if (measure.value !== input.value) measure.value = input.value;
			// Clearing a short draft can leave the measuring field at the same size.
			if (!input.value && last !== undefined) measureLayout();
		}
		return Object.assign(sync, { growth });
	}
	Object.assign(globalThis, { composerLayout: { mount, stack } });
})();
