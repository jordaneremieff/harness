(() => {
	const api = (globalThis as unknown as { reader: ReaderCoreAPI }).reader;
	const { element: el, button, get, icon } = api.uiDOM;
	type Row = { ref: string; kind: string; title: string; subtitle?: string; age?: string; excerpt?: string };
	type Library = {
		rows: Row[];
		cursor?: string;
		limited?: boolean;
		store?: { label: string };
		coverage?: { searched: number; total: number | null; stopped: boolean; reason?: string };
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
			zoom = 1,
			textSizeSteps = [1];
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
			if (minutes < 1) return "now";
			if (minutes < 60) return `${minutes} min ago`;
			if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
			return `${Math.floor(minutes / 1440)} d ago`;
		}
		function menuIndex(key: string, index: number, length: number) {
			if (key === "Home") return 0;
			if (key === "End") return length - 1;
			if (key === "ArrowDown") return (index + 1) % length;
			return (Math.max(index, 0) + length - 1) % length;
		}
		function menuKeys(event: KeyboardEvent) {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			const buttons = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
			if (!buttons.length) return;
			event.preventDefault();
			let index = buttons.indexOf(document.activeElement as HTMLButtonElement);
			index = menuIndex(event.key, index, buttons.length);
			buttons[index].focus();
		}
		menu.addEventListener("keydown", menuKeys);
		off.push(() => menu.removeEventListener("keydown", menuKeys));
		function positiveNumber(value: unknown): value is number {
			return typeof value === "number" && Number.isFinite(value) && value > 0;
		}
		function applyTextSize(value: unknown) {
			zoom = positiveNumber(value) ? value : 1;
			document.documentElement.style.setProperty("--zoom", String(zoom));
		}
		function applySettings(patch: Record<string, unknown>) {
			if (Array.isArray(patch.textSizeSteps)) textSizeSteps = patch.textSizeSteps.filter(positiveNumber);
			if ("textSize" in patch) applyTextSize(patch.textSize);
			if (typeof patch.appearance === "string") document.documentElement.dataset.theme = patch.appearance;
			if (typeof patch.codeWrap === "boolean") app.toggleAttribute("data-wrap", patch.codeWrap);
		}
		function size(direction: number | null) {
			zoom = api.uiLogic.zoomStep(zoom, textSizeSteps, direction);
			applySettings({ textSize: zoom });
			void ctx.hostCommand("saveSettings", { patch: { textSize: zoom } });
			ctx.toast(`Text size ${Math.round(zoom * 100)}%`);
			views.appearance();
		}
		function openRow(row: Row) {
			palette.close();
			void ctx.hostCommand("open", { ref: row.ref });
		}
		function fillHeadings(query: string) {
			items = ctx
				.headings()
				.filter((h) => h.text.toLocaleLowerCase().includes(query.slice(1).trim().toLocaleLowerCase()))
				.map((heading) => ({ heading }));
			drawOpen();
		}
		function openError(token: number, list: HTMLElement, error: unknown) {
			if (token === openSequence)
				list.replaceChildren(el("p", { class: "query-error" }, `The open list is unavailable: ${String(error)}`));
		}
		async function fillOpen(query: string) {
			const token = ++openSequence,
				list = get("#pal-list");
			items = [];
			openIndex = 0;
			get("#pal-q").removeAttribute("aria-activedescendant");
			if (query.startsWith("#")) {
				fillHeadings(query);
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
				appendOpenResults(results, list);
				if (!items.length)
					list.append(el("p", { class: "empty" }, "No documents match. Search document text from the library."));
			} catch (error) {
				openError(token, list, error);
			}
		}
		function appendOpenResults(results: Library[], list: HTMLElement) {
			let offset = 0;
			results.forEach((result, i) => {
				if (result.rows.length) list.append(el("div", { class: "grp" }, ["Drafts", "Recent", "Published"][i]));
				for (const row of result.rows) list.append(openOption({ row }, offset++));
				if (result.limited)
					list.append(el("p", { class: "query-limit" }, "More documents are available in the library."));
			});
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
			items.forEach((item, index) => {
				list.append(openOption(item, index));
			});
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
		function openKeys(event: KeyboardEvent) {
			if (event.isComposing) return;
			const delta = { ArrowDown: 1, ArrowUp: -1 }[event.key];
			if (delta) {
				event.preventDefault();
				moveOpen(delta);
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				chooseOpen(openIndex);
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
		function libraryRow(row: Row) {
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
			return b;
		}
		function coverageText(result: Library) {
			const c = result.coverage;
			if (!c)
				return result.limited
					? "The library shows a bounded set of documents. Read the next documents to continue."
					: "";
			const scope =
				c.total === null
					? `Source search: searched ${c.searched} documents.`
					: `Source search: ${c.searched} of ${c.total} documents checked.`;
			return [scope, c.stopped ? "Search stopped at its limit." : "", c.reason ?? ""].filter(Boolean).join(" ");
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
						tabs.querySelectorAll("button").forEach((node) => {
							node.setAttribute("aria-pressed", String(node === b));
						});
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
			function beginLoad(append: boolean) {
				next.disabled = true;
				if (append) return;
				cursor = undefined;
				results.replaceChildren();
				coverage.textContent = "Reading the library…";
			}
			function showLibrary(result: Library, append: boolean) {
				store.textContent = result.store?.label ?? "Library";
				if (!append) results.replaceChildren();
				for (const row of result.rows) results.append(libraryRow(row));
				if (!results.children.length) results.append(el("p", { class: "empty" }, "No documents match."));
				cursor = result.cursor;
				next.hidden = !cursor;
				next.disabled = false;
				coverage.textContent = coverageText(result);
			}
			function libraryCurrent(token: number) {
				return token === request && kind === "library";
			}
			function libraryError(token: number, error: unknown) {
				if (token === request) coverage.textContent = `The library is unavailable: ${String(error)}`;
			}
			async function load(append = false) {
				const token = ++request;
				beginLoad(append);
				try {
					const result = (await host.request("query", {
						kind: "library",
						collection,
						query,
						match,
						...(cursor ? { cursor } : {}),
					})) as Library;
					if (!libraryCurrent(token)) return;
					showLibrary(result, append);
				} catch (error) {
					libraryError(token, error);
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
			return resultContent(view, body, result, args);
		}
		function reviewContent(body: HTMLElement, result: Record<string, unknown>) {
			if (result.summary)
				body.append(
					reviewSummary(
						result.summary as {
							base: number;
							target: number | null;
							changedRegions: number;
							addedLines: number;
							removedLines: number;
							partial: boolean;
						},
					),
				);
			const rendered = el("article", { class: "doc review-doc" });
			api.setRenderedHTML(rendered, String(result.html ?? ""));
			body.append(rendered);
			return body;
		}
		function reviewSummary(summary: {
			base: number;
			target: number | null;
			changedRegions: number;
			addedLines: number;
			removedLines: number;
			partial: boolean;
		}) {
			const target = summary.target === null ? "Your draft" : `Revision ${summary.target}`;
			return el(
				"div",
				{ class: "review-summary" },
				el("h3", {}, `Revision ${summary.base} → ${target}`),
				el(
					"p",
					{},
					`${summary.changedRegions} changed ${summary.changedRegions === 1 ? "passage" : "passages"}, ${summary.addedLines} ${summary.addedLines === 1 ? "line" : "lines"} added, ${summary.removedLines} removed.`,
				),
				summary.partial ? el("p", {}, "This comparison covers part of the source.") : null,
			);
		}
		function detailsContent(body: HTMLElement, result: Record<string, unknown>) {
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
			return body;
		}
		function imageContent(body: HTMLElement, result: Record<string, unknown>, args: Record<string, unknown>) {
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
			return body;
		}
		function resultContent(
			view: string,
			body: HTMLElement,
			result: Record<string, unknown>,
			args: Record<string, unknown>,
		) {
			if (view === "review") return reviewContent(body, result);
			if (view === "details") return detailsContent(body, result);
			if (view === "image") return imageContent(body, result, args);
			return body;
		}
		function reviewAgainst() {
			const meta = controller.payload?.meta;
			return meta?.kind === "draft" || meta?.capturedSource ? "base" : "previous";
		}
		type Revision = { n: number; createdAt: unknown; current: boolean };
		// The shown revision and the five newest, newest first; the check marks the shown one.
		function revisionItems(revisions: Revision[]) {
			const latest = Math.max(...revisions.map((revision) => revision.n));
			return [...revisions]
				.sort((a, b) => b.n - a.n)
				.filter((revision, index) => index < 5 || revision.current)
				.map((revision) => {
					const b = item(
						`Revision ${revision.n}`,
						"check",
						() => {
							void ctx.hostCommand("showRevision", { n: revision.n });
						},
						"",
						{ role: "menuitemradio", "aria-checked": String(revision.current) },
					);
					b.querySelector("svg")?.classList.add("tick");
					const when = [revision.n === latest ? "latest" : "", age(revision.createdAt)].filter(Boolean).join(" · ");
					if (when) b.append(el("span", { class: "meta" }, when));
					return b;
				});
		}
		function revisionFact(shown: unknown, revisions: Revision[]) {
			if (typeof shown !== "number") return "";
			return revisions.length > 1
				? `Revision ${shown} of ${Math.max(...revisions.map((r) => r.n))}`
				: `Revision ${shown}`;
		}
		function wordFact() {
			const words = (controller.doc?.source.match(/\S+/gu) ?? []).length;
			return `${words.toLocaleString("en-AU")} ${words === 1 ? "word" : "words"}`;
		}
		// What the document is, in one block: kind, revision, length and its ID on a line of its own.
		function menuHead(meta: Record<string, unknown>, revisions: Revision[]) {
			const shown = revisions.find((revision) => revision.current)?.n ?? meta.revision,
				id = String(meta.shortId ?? meta.documentId ?? "");
			const facts = [revisionFact(shown, revisions), wordFact()].filter(Boolean);
			return el(
				"div",
				{ class: "menu-head" },
				el("div", { class: "kind-name" }, kindName(String(meta.kind ?? "published"))),
				el("div", { class: "facts" }, facts.join(" · ")),
				...(id ? [el("div", { class: "doc-id" }, id)] : []),
			);
		}
		function hasPassage() {
			const selection = getSelection();
			return (
				!!selection && !selection.isCollapsed && !!selection.anchorNode && get("#doc").contains(selection.anchorNode)
			);
		}
		const unavailable = (available: boolean): Record<string, string> => (available ? {} : { disabled: "" });
		function exportItem(label: string, image: string, format: string, available: boolean) {
			return item(
				label,
				image,
				() => {
					void ctx.hostCommand("export", { format });
				},
				"",
				unavailable(available),
			);
		}
		const views: ReaderViewsUI = {
			// Grouped by use, most frequent first. Unavailable commands stay in place, disabled, and
			// commands that ask for more input before they act end with an ellipsis.
			menu() {
				const meta = controller.payload?.meta ?? { capturedSource: false },
					revisions = (meta.revisions as Revision[] | undefined) ?? [],
					stored = typeof meta.revision === "number";
				menu.replaceChildren(
					menuHead(meta, revisions),
					item(controller.lock === "writing" ? "Done" : "Edit", "pen", () => ctx.command("toggleLock"), "⌘E"),
					item(
						"Review changes",
						"compare",
						() => views.show("review", { against: reviewAgainst() }),
						"⌘D",
						unavailable(reviewAgainst() === "base" || revisions.length > 1),
					),
				);
				if (revisions.length > 1)
					menu.append(
						el("div", { class: "sep" }),
						el("div", { class: "sec" }, "Revisions"),
						...revisionItems(revisions),
					);
				menu.append(
					el("div", { class: "sep" }),
					item("Copy Markdown", "copy", () => ctx.command("copyMarkdown"), "⇧⌘C"),
					item("Copy passage with source", "quote", () => ctx.command("copyPassage"), "⌥⌘C", unavailable(hasPassage())),
					el("div", { class: "sep" }),
					el("div", { class: "sec" }, "Export"),
					exportItem("PDF…", "doc", "pdf", true),
					exportItem("Markdown and images…", "image", "sharing", stored),
					exportItem("Archive with records…", "archive", "archive", stored),
					el("div", { class: "sep" }),
					item("Details", "info", () => views.show("details"), "⌘I"),
					item("Markdown source", "code", () => views.show("source")),
					item("Text and appearance…", "text", () => panel.showPopover()),
					el("div", { class: "sep" }),
					item("Open…", "open", () => views.open(), "⌘O"),
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
						button("Smaller text", "minus", () => size(-1), { iconOnly: true }),
						out,
						button("Bigger text", "plus", () => size(1), { iconOnly: true }),
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
				query.addEventListener("keydown", openKeys);
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
				const token = ++sequence,
					previousKind = kind;
				kind = view;
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
						navigation.refreshFind();
					})
					.catch((error) => {
						if (token !== sequence) return;
						kind = previousKind;
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
				navigation.refreshFind();
				return true;
			},
			textZoom(delta) {
				size(delta);
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
				applySettings({ textSize: 1, textSizeSteps: [1], ...payload.settings });
				views.appearance();
			}),
			controller.on("settings", (patch) => {
				applySettings(patch);
				views.appearance();
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
