(() => {
	const root = globalThis as unknown as { reader: ReaderCoreAPI; readerDeferBoot?: boolean };
	const api = root.reader;
	api.boot = (provided) => {
		const host = provided ?? api.createNativeHost(),
			column = document.querySelector<HTMLElement>('[data-role="document"]'),
			scroll = document.querySelector<HTMLElement>("#page");
		if (!column || !scroll) throw new Error("The reader page has no document surface.");
		const controller = api.createController(host),
			editor = api.createEditor(controller, column, { scroll }),
			ui = api.createUI(host, controller, editor);
		host.send("ready", { version: "web-1", capabilities: { lock: true, claims: true, inlineChanges: true } });
		return {
			host,
			controller,
			editor,
			ui,
			dispose() {
				ui.dispose();
				editor.dispose();
				controller.dispose();
				host.dispose();
			},
		};
	};
	if (!root.readerDeferBoot) api.boot();
})();
