(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	type Row = { ref: string; kind: string; title: string; subtitle?: string; age?: string; excerpt?: string };
	type Library = {
		rows: Row[];
		cursor?: string;
		limited?: boolean;
		store?: { label: string };
		coverage?: { searched: number; total: number; stopped: boolean; reason?: string };
	};
	const kindIcon = (kind: string) =>
		({ draft: "pen", response: "response", file: "file", localFile: "file", published: "doc" })[kind] ?? "doc";
	const kindName = (kind: string) =>
		({
			draft: "Draft",
			response: "Agent response",
			file: "File snapshot",
			localFile: "Local file",
			published: "Published document",
		})[kind] ?? "Document";
	api.createViewsUI = (ctx, navigation) => {
		const { controller, host, app } = ctx,
			menu = get("#docmenu"),
			panel = get("#viewpanel"),
			palette = get<HTMLDialogElement>("#palette"),
			overlay = get("#overlay");
		let sequence = 0,
			openSequence = 0,
			kind: string | null = null,
			imageMode = "fit",
			imageIndex = 0,
			openIndex = 0,
			items: ({ row: Row } | { heading: ReaderHeading })[] = [],
			zoom = 1;
		const off: (() => void)[] = [];
		function item(label: string, image: string, run: () => void, key = "", attributes: Record<string, string> = {}) {
			const b = button(
				"",
				image,
				() => {
					menu.hidePopover();
					run();
				},
				{ className: "item" },
			);
			b.setAttribute("role", "menuitem");
			for (const [k, v] of Object.entries(attributes)) b.setAttribute(k, v);
			b.append(el("span", { class: "lbl" }, label));
			if (key) b.append(el("kbd", {}, key));
			return b;
		}
		function age(value: unknown) {
			const time = typeof value === "string" ? Date.parse(value) : Number(value);
			if (!Number.isFinite(time)) return "";
			const minutes = Math.max(0, Math.floor((Date.now() - time) / 60000));
			return minutes < 1
				? "now"
				: minutes < 60
					? `${minutes} min ago`
					: minutes < 1440
						? `${Math.floor(minutes / 60)} h ago`
						: `${Math.floor(minutes / 1440)} d ago`;
		}
		function menuKeys(event: KeyboardEvent) {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
			if (!buttons.length) return;
			event.preventDefault();
			let index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			index =
				event.key === "Home"
					? 0
					: event.key === "End"
						? buttons.length - 1
						: (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
			buttons[index].focus();
		}
		menu.addEventListener("keydown", menuKeys);
		off.push(() => menu.removeEventListener("keydown", menuKeys));
		function applySettings(patch: Record<string, unknown>) {
			if (typeof patch.textSize === "number") {
				zoom = patch.textSize;
				document.documentElement.style.setProperty("--zoom", String(zoom));
			}
			if (typeof patch.appearance === "string") document.documentElement.dataset.theme = patch.appearance;
			if (typeof patch.codeWrap === "boolean") app.toggleAttribute("data-wrap", patch.codeWrap);
		}
		function size(next: number) {
			zoom = Math.max(0.8, Math.min(1.6, Math.round(next * 20) / 20));
			applySettings({ textSize: zoom });
			void ctx.hostCommand("saveSettings", { patch: { textSize: zoom } });
			ctx.toast(`Text size ${Math.round(zoom * 100)}%`);
			views.appearance();
		}
		function openRow(row: Row) {
			palette.close();
			void ctx.hostCommand("open", { ref: row.ref });
		}
		async function fillOpen(query: string) {
			const token = ++openSequence,
				list = get("#pal-list");
			openIndex = 0;
			if (query.startsWith("#")) {
				items = ctx
					.headings()
					.filter((h) => h.text.toLocaleLowerCase().includes(query.slice(1).trim().toLocaleLowerCase()))
					.map((heading) => ({ heading }));
				drawOpen();
				return;
			}
			list.replaceChildren(el("div", { class: "grp" }, "Reading your documents…"));
			try {
				const collections = ["drafts", "recent", "published"];
				const results = await Promise.all(
					collections.map(
						(collection) => host.request("query", { kind: "library", collection, query }) as Promise<Library>,
					),
				);
				if (token !== openSequence) return;
				items = results.flatMap((result) => result.rows.map((row) => ({ row })));
				list.replaceChildren();
				let offset = 0;
				results.forEach((result, i) => {
					if (result.rows.length) list.append(el("div", { class: "grp" }, ["Drafts", "Recent", "Published"][i]));
					for (const row of result.rows) list.append(openOption({ row }, offset++));
					if (result.limited)
						list.append(el("p", { class: "query-limit" }, "More documents are available in the library."));
				});
				if (!items.length)
					list.append(el("p", { class: "empty" }, "No documents match. Search document text from the library."));
			} catch (error) {
				if (token === openSequence)
					list.replaceChildren(el("p", { class: "query-error" }, `The open list is unavailable: ${String(error)}`));
			}
		}
		function openOption(item: { row: Row } | { heading: ReaderHeading }, index: number) {
			const b = el("button", {
				class: "opt",
				role: "option",
				"aria-selected": String(index === openIndex),
				id: `open-option-${index}`,
				type: "button",
			});
			if ("heading" in item)
				b.append(
					el("span", { class: "hd" }, `H${item.heading.level}`),
					el("span", { class: "lbl" }, item.heading.text),
				);
			else
				b.append(
					el("span", { class: "kind", "data-kind": item.row.kind }, icon(kindIcon(item.row.kind))),
					el("span", { class: "lbl" }, item.row.title),
					el("span", { class: "meta" }, item.row.age ?? ""),
				);
			b.addEventListener("click", () => chooseOpen(index));
			return b;
		}
		function drawOpen() {
			const list = get("#pal-list");
			list.replaceChildren(el("div", { class: "grp" }, "Headings in this document"));
			items.forEach((item, index) => list.append(openOption(item, index)));
			if (!items.length) list.append(el("p", { class: "empty" }, "No matching headings"));
		}
		function chooseOpen(index: number) {
			const item = items[index];
			if (!item) return;
			if ("row" in item) openRow(item.row);
			else {
				palette.close();
				navigation.jump(item.heading.start);
			}
		}
		function moveOpen(delta: number) {
			if (!items.length) return;
			openIndex = (openIndex + delta + items.length) % items.length;
			for (const [i, b] of [...get("#pal-list").querySelectorAll<HTMLElement>(".opt")].entries())
				b.setAttribute("aria-selected", String(i === openIndex));
			get(`#open-option-${openIndex}`).scrollIntoView({ block: "nearest" });
			get("#pal-q").setAttribute("aria-activedescendant", `open-option-${openIndex}`);
		}
		function header(title: string) {
			return el(
				"header",
				{ class: "overlay-head" },
				el("h2", {}, title),
				el("span", { class: "spacer" }),
				button("Done", "", () => views.close(), { className: "view-done" }),
			);
		}
		function facts(rows: { label: string; value: string }[]) {
			const list = el("dl", { class: "facts" });
			for (const row of rows) list.append(el("dt", {}, row.label), el("dd", {}, row.value));
			return list;
		}
		async function libraryView(container: HTMLElement) {
			let collection = "drafts",
				match = "title",
				query = "",
				cursor: string | undefined,
				request = 0;
			const field = el("input", { placeholder: "Search documents", "aria-label": "Search library", type: "search" }),
				tabs = el("div", { class: "library-filters" }),
				results = el("div", { class: "library-results" }),
				store = el("span", { class: "store-label" }, "Library"),
				coverage = el("p", { class: "query-limit" });
			const searchMode = el(
				"select",
				{ "aria-label": "Search in" },
				el("option", { value: "title" }, "Titles"),
				el("option", { value: "source" }, "Source text"),
			);
			const next = button("Read next documents", "", () => void load(true), { className: "view-done" });
			next.hidden = true;
			for (const value of ["drafts", "recent", "published"]) {
				const b = button(
					value[0].toUpperCase() + value.slice(1),
					"",
					() => {
						collection = value;
						tabs.querySelectorAll("button").forEach((node) => node.setAttribute("aria-pressed", String(node === b)));
						void load();
					},
					{ className: "filter-button" },
				);
				b.setAttribute("aria-pressed", String(collection === value));
				tabs.append(b);
			}
			container.append(
				el(
					"div",
					{ class: "library-tools" },
					store,
					host.capabilities.filePanels
						? button("Choose store", "open", () => void ctx.hostCommand("chooseStore").then(() => load()), {
								className: "view-done",
							})
						: null,
				),
				el(
					"div",
					{ class: "library-search" },
					field,
					searchMode,
					button(
						"Search",
						"search",
						() => {
							query = field.value;
							match = searchMode.value;
							void load();
						},
						{ className: "view-done" },
					),
				),
				tabs,
				coverage,
				results,
				next,
			);
			field.addEventListener("keydown", (event) => {
				if (event.key === "Enter" && !event.isComposing) {
					query = field.value;
					match = searchMode.value;
					void load();
				}
			});
			async function load(append = false) {
				const token = ++request;
				next.disabled = true;
				if (!append) {
					cursor = undefined;
					results.replaceChildren();
					coverage.textContent = "Reading the library…";
				}
				try {
					const result = (await host.request("query", {
						kind: "library",
						collection,
						query,
						match,
						...(cursor ? { cursor } : {}),
					})) as Library;
					if (token !== request || kind !== "library") return;
					store.textContent = result.store?.label ?? "Library";
					if (!append) results.replaceChildren();
					for (const row of result.rows) {
						const b = button("", kindIcon(row.kind), () => openRow(row), { className: "library-row" });
						b.append(
							el(
								"span",
								{ class: "library-row-text" },
								el("b", {}, row.title),
								el("span", {}, row.excerpt ?? row.subtitle ?? kindName(row.kind)),
							),
							el("span", { class: "meta" }, row.age ?? ""),
						);
						results.append(b);
					}
					if (!results.children.length) results.append(el("p", { class: "empty" }, "No documents match."));
					cursor = result.cursor;
					next.hidden = !cursor;
					next.disabled = false;
					coverage.textContent = result.coverage
						? `Source search: ${result.coverage.searched} of ${result.coverage.total} documents checked.${result.coverage.stopped ? " Search stopped at its limit." : ""}${result.coverage.reason ? ` ${result.coverage.reason}` : ""}`
						: result.limited
							? "The library shows a bounded set of documents. Read the next documents to continue."
							: "";
				} catch (error) {
					if (token === request) coverage.textContent = `The library is unavailable: ${String(error)}`;
				}
			}
			await load();
		}
		async function content(view: string, args: Record<string, unknown>) {
			const body = el("div", { class: `overlay-body ${view}-view` });
			if (view === "source") {
				body.append(el("pre", { class: "source-text" }, controller.doc?.source ?? ""));
				return body;
			}
			if (view === "library") {
				void libraryView(body);
				return body;
			}
			const result = (await host.request("query", { kind: view, ...args })) as Record<string, unknown>;
			if (view === "review") {
				if (result.summary) body.append(el("p", { class: "review-summary" }, String(result.summary)));
				const rendered = el("article", { class: "doc review-doc" });
				api.setRenderedHTML(rendered, String(result.html ?? ""));
				body.append(rendered);
			}
			if (view === "details") {
				body.append(facts((result.rows as { label: string; value: string }[]) ?? []));
				for (const image of (result.images as { index: number; state: string; reason?: string }[]) ?? [])
					body.append(
						button(
							`Image ${image.index} · ${image.state}${image.reason ? `: ${image.reason}` : ""}`,
							"image",
							() => views.show("image", { index: image.index }),
							{ className: "library-row" },
						),
					);
			}
			if (view === "image") {
				imageIndex = Number(args.index ?? 0);
				imageMode = String(args.zoom ?? "fit");
				const stage = el("div", { class: "image-stage", "data-zoom": imageMode });
				const address = String(result.address ?? "");
				if (address.startsWith("reader-asset:") || address.startsWith("data:image/"))
					stage.append(
						el("img", {
							src: address,
							alt: String(result.alt ?? "Image inspection"),
							width: String(result.width ?? 0),
							height: String(result.height ?? 0),
						}),
					);
				else stage.append(el("p", {}, "This image is not available for display."));
				body.append(
					el(
						"div",
						{ class: "image-controls" },
						button("Previous", "back", () => views.show("image", { index: Math.max(0, imageIndex - 1) })),
						button("Next", "forward", () => views.show("image", { index: imageIndex + 1 })),
						button("Fit", "", () => views.imageZoom("fit")),
						button("Actual size", "", () => views.imageZoom("actual")),
						button("Copy reference", "copy", () => {
							void ctx.hostCommand("copy", { text: address });
						}),
					),
					stage,
					facts((result.facts as { label: string; value: string }[]) ?? []),
				);
			}
			return body;
		}
		const views: ReaderViewsUI = {
			menu() {
				const meta = controller.payload?.meta ?? { capturedSource: false },
					kind = String(meta.kind ?? "published");
				menu.replaceChildren(
					el("div", { class: "sec" }, `${kindName(kind)} · ${String(meta.shortId ?? meta.documentId ?? "")}`),
					item(controller.lock === "writing" ? "Done" : "Edit", "pen", () => ctx.command("toggleLock"), "⌘E"),
				);
				for (const revision of (meta.revisions as { n: number; createdAt: unknown; current: boolean }[]) ?? []) {
					const b = item(
						`Revision ${revision.n}${revision.current ? " · current" : ""}`,
						"check",
						() => {
							void ctx.hostCommand("showRevision", { n: revision.n });
						},
						"",
						{ role: "menuitemradio", "aria-checked": String(revision.current) },
					);
					b.append(el("span", { class: "meta" }, age(revision.createdAt)));
					menu.append(b);
				}
				menu.append(
					item("Review changes", "compare", () => views.show("review", { against: "previous" }), "⌘D"),
					el("div", { class: "sep" }),
					item("Copy Markdown", "copy", () => ctx.command("copyMarkdown"), "⇧⌘C"),
					item("Copy passage with source", "quote", () => ctx.command("copyPassage"), "⌥⌘C"),
					el("div", { class: "sec" }, "Export"),
				);
				for (const [format, label] of [
					["archive", "Revision archive"],
					["sharing", "Sharing copy"],
					["pdf", "Current page PDF"],
				])
					menu.append(
						item(label, "export", () => {
							void ctx.hostCommand("export", { format });
						}),
					);
				menu.append(
					el("div", { class: "sep" }),
					item("Details", "info", () => views.show("details"), "⌘I"),
					item("Markdown source", "code", () => views.show("source")),
					item("Text and appearance", "text", () => panel.showPopover()),
					el(
						"div",
						{ class: "sec" },
						`${(controller.doc?.source.match(/\S+/gu) ?? []).length.toLocaleString("en-AU")} words`,
					),
					el("div", { class: "sep" }),
					item("Open", "open", () => views.open(), "⌘O"),
					item("New draft", "new", () => {
						void ctx.hostCommand("newDraft");
					}),
				);
				if (host.capabilities.returnFocus)
					menu.append(
						el("div", { class: "sep" }),
						item(
							"Return to terminal",
							"terminal",
							() => {
								void ctx.hostCommand("returnFocus");
							},
							"esc",
						),
					);
			},
			appearance() {
				panel.replaceChildren();
				const out = el("output", {}, `${Math.round(zoom * 100)}%`),
					stepper = el(
						"span",
						{ class: "stepper" },
						button("Smaller text", "minus", () => size(zoom - 0.05), { iconOnly: true }),
						out,
						button("Bigger text", "plus", () => size(zoom + 0.05), { iconOnly: true }),
					);
				const wrap = el("input", { type: "checkbox", class: "switch", "aria-label": "Wrap code lines" });
				wrap.checked = app.hasAttribute("data-wrap");
				wrap.addEventListener("change", () => {
					applySettings({ codeWrap: wrap.checked });
					void ctx.hostCommand("saveSettings", { patch: { codeWrap: wrap.checked } });
				});
				const appearance = el("span", { class: "seg" });
				for (const mode of ["system", "light", "dark"]) {
					const b = button(mode[0].toUpperCase() + mode.slice(1), "", () => {
						applySettings({ appearance: mode });
						void ctx.hostCommand("saveSettings", { patch: { appearance: mode } });
						views.appearance();
					});
					b.setAttribute("aria-pressed", String((document.documentElement.dataset.theme ?? "system") === mode));
					appearance.append(b);
				}
				panel.append(
					el("div", { class: "row" }, el("span", { class: "lbl" }, "Text size"), stepper),
					el("div", { class: "row" }, el("span", { class: "lbl" }, "Wrap code lines"), wrap),
					el("div", { class: "row" }, el("span", { class: "lbl" }, "Appearance"), appearance),
				);
			},
			open() {
				palette.replaceChildren();
				const query = el("input", {
					id: "pal-q",
					placeholder: "Open a document, draft or heading",
					"aria-label": "Search documents",
					autocomplete: "off",
					role: "combobox",
					"aria-expanded": "true",
					"aria-controls": "pal-list",
				});
				query.addEventListener("input", () => void fillOpen(query.value));
				query.addEventListener("keydown", (event) => {
					if (event.isComposing) return;
					if (event.key === "ArrowDown" || event.key === "ArrowUp") {
						event.preventDefault();
						moveOpen(event.key === "ArrowDown" ? 1 : -1);
					}
					if (event.key === "Enter") {
						event.preventDefault();
						chooseOpen(openIndex);
					}
				});
				palette.append(
					el("div", { class: "q" }, icon("search"), query),
					el("div", { class: "list", id: "pal-list", role: "listbox" }),
					el(
						"div",
						{ class: "foot" },
						el("span", {}, "↑↓ choose · ↩ open · # headings"),
						button(
							"Full library",
							"open",
							() => {
								palette.close();
								views.show("library");
							},
							{ className: "link" },
						),
					),
				);
				if (!palette.open) palette.showModal();
				query.focus();
				void fillOpen("");
			},
			show(view, args = {}) {
				const token = ++sequence;
				controller.state({ overlay: view });
				void content(view, args)
					.then((body) => {
						if (token !== sequence) return;
						kind = view;
						overlay.replaceChildren(
							header(
								{
									review: "Review changes",
									details: "Document details",
									image: "Image",
									source: "Markdown source",
									library: "Library",
								}[view] ?? view,
							),
							body,
						);
						overlay.hidden = false;
						app.dataset.overlay = view;
					})
					.catch((error) => {
						if (token !== sequence) return;
						controller.state({ overlay: kind });
						ctx.notice(`This view did not open: ${String(error)}`, "warn");
					});
			},
			close() {
				if (palette.open) {
					palette.close();
					return true;
				}
				if (!kind) return false;
				sequence++;
				kind = null;
				overlay.hidden = true;
				overlay.replaceChildren();
				delete app.dataset.overlay;
				controller.state({ overlay: null });
				return true;
			},
			imageZoom(mode) {
				if (kind !== "image") return;
				imageMode = mode;
				const stage = overlay.querySelector<HTMLElement>(".image-stage");
				if (stage) stage.dataset.zoom = mode;
			},
			dispose() {
				sequence++;
				for (const fn of off) fn();
			},
		};
		off.push(
			controller.on("document", (payload) => {
				views.close();
				applySettings(payload.settings);
				views.appearance();
			}),
			controller.on("settings", (patch) => {
				applySettings(patch);
				views.appearance();
			}),
			controller.on("command", (command) => {
				if (command.name === "zoomIn") size(zoom + 0.05);
				if (command.name === "zoomOut") size(zoom - 0.05);
				if (command.name === "zoomReset") size(1);
			}),
		);
		const toggle = (event: Event) => {
			if ((event as Event & { newState: string }).newState === "open") views.menu();
		};
		menu.addEventListener("beforetoggle", toggle);
		off.push(() => menu.removeEventListener("beforetoggle", toggle));
		views.appearance();
		return views;
	};
})();
