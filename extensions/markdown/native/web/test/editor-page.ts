(() => {
	interface FixtureHost extends ReaderCoreHost {
		source: string;
		generation: number;
		emit(type: string, fields: Record<string, unknown>): void;
		messages: Record<string, unknown>[];
	}
	interface FixtureAPI {
		fixtures: {
			render(source: string): ReaderMappedBlock[];
			document(source?: string): ReaderCoreDocument;
			large(bytes?: number): string;
		};
		createMemoryHost(
			payload: ReaderCoreDocument,
			render: (source: string, generation: number) => ReaderMappedBlock[],
		): FixtureHost;
	}
	const api = (globalThis as unknown as { reader: ReaderCoreAPI & FixtureAPI }).reader;
	function required<T>(value: T | null | undefined): T {
		if (value === null || value === undefined) throw new Error("Missing test surface.");
		return value;
	}
	const root = required(document.querySelector<HTMLElement>("#document"));
	let controller: ReaderController, editor: ReaderEditor, host: FixtureHost;
	const errors: string[] = [];
	addEventListener("error", (e) => errors.push(e.message));
	function load(source = api.fixtures.large()) {
		editor?.dispose();
		controller?.dispose();
		root.replaceChildren();
		const payload = api.fixtures.document(source);
		host = api.createMemoryHost(payload, api.fixtures.render);
		controller = api.createController(host, { document: payload });
		editor = api.createEditor(controller, root);
		controller.on("error", (e) => errors.push(String(e)));
		controller.setLock("writing");
		scrollTo(0, 0);
		return { bytes: new TextEncoder().encode(source).length, blocks: controller.blocks.length };
	}
	const openElement = () => required(root.querySelector<HTMLElement>('[data-role="block-editor"]'));
	function select(a: number, b = a) {
		const el = openElement(),
			x = api.sourceModel.point(el, a),
			y = api.sourceModel.point(el, b);
		getSelection()?.setBaseAndExtent(x.node, x.offset, y.node, y.offset);
	}
	function bodyNode(node: Text) {
		return (
			node.length > 0 &&
			!node.parentElement?.classList.contains("mark") &&
			!node.parentElement?.classList.contains("prefix")
		);
	}
	function firstRect(el: HTMLElement) {
		const n = api.sourceModel.textNodes(el).find(bodyNode);
		if (!n) return new DOMRect();
		const r = new Range();
		r.setStart(n, 0);
		r.setEnd(n, 1);
		return r.getBoundingClientRect();
	}
	function alignment() {
		return controller.blocks.slice(0, 3).map((b) => {
			editor.close();
			const el = required(root.querySelector<HTMLElement>(`[data-block="${b.key}"]`)),
				rect = firstRect(el),
				before = rect.x;
			const opened = editor.open(b.key, { x: rect.x + 2, y: rect.y + rect.height / 2 }),
				after = firstRect(el).x;
			return { type: b.type, opened, before, after, shift: after - before };
		});
	}
	async function frames() {
		await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
	}
	function check() {
		const doc = required(controller.doc);
		if (doc.source !== host.source) throw new Error("Mirror differs from page.");
		const el = root.querySelector<HTMLElement>('[data-role="block-editor"]'),
			active = doc.active;
		if (el && active) {
			const expected = new api.exact.LineMap(doc.source.slice(active.start, active.end)).display;
			if (el.textContent !== expected) throw new Error("Editor differs from exact source.");
		}
		return true;
	}
	function typeCommand(structural: boolean, index: number, el: HTMLElement) {
		if (structural) {
			const p = (el.textContent ?? "").indexOf("**");
			select(p + (index % 2 ? 2 : 1));
		}
		return { name: structural && index % 2 ? "delete" : "insertText", value: structural ? "*" : "x" };
	}
	function benchmark(structural = false) {
		editor.close();
		editor.open(controller.blocks[0].key, 0);
		const el = openElement();
		select((el.textContent ?? "").indexOf("bold words") + 4);
		const before = editor.restyles,
			times: number[] = [];
		let accepted = 0;
		for (let i = 0; i < 200; i++) {
			const command = typeCommand(structural, i, el),
				start = performance.now();
			if (document.execCommand(command.name, false, command.value)) accepted++;
			el.getBoundingClientRect();
			times.push(performance.now() - start);
			check();
		}
		times.sort((a, b) => a - b);
		return {
			accepted,
			mean: times.reduce((a, b) => a + b, 0) / times.length,
			median: times[100],
			p90: times[180],
			max: times[199],
			restyles: editor.restyles - before,
		};
	}
	const test = {
		load,
		select,
		alignment,
		frames,
		check,
		benchmark,
		get controller() {
			return controller;
		},
		get editor() {
			return editor;
		},
		get host() {
			return host;
		},
		errors,
	};
	(globalThis as unknown as { editorTest: typeof test }).editorTest = test;
	load();
})();
