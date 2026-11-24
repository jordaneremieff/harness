(() => {
	const app = window.explorer;
	const { el, get, icon, button, glyph, iconButton, noteMarker } = app.dom;
	const { request, model } = app;
	const shell = get("app"),
		body = get("view-body"),
		sidebar = get("sidebar"),
		list = get("sidebar-list"),
		heading = get("sidebar-heading");
	const float = get("floating"),
		overlay = get("overlay"),
		status = get("notice");
	const isWide = matchMedia("(min-width: 1200px)");
	// A pane narrower than 760 points shows the sidebar as a sheet. Zooming in keeps the sidebar until the page
	// itself is too narrow for it and the code beside it.
	const isNarrow = { matches: false };
	const source = app.code(body);
	const preview = app.preview(body, followMarkdownLink);
	let code: ExplorerCodeView = source;
	let root: ExplorerRoot = {
		path: "",
		name: "Repository",
		kind: "folder",
		branch: null,
		head: null,
		defaultBranch: null,
		onDefaultBranch: false,
	};
	let base: ExplorerBase;
	let settings: ExplorerSettings = {
		textSize: 16,
		wrap: false,
		preview: true,
		diff: "auto",
		sidebar: { width: 245, open: true },
		tab: "files",
		zoom: 1,
	};
	let live: ExplorerLive = { connected: false };
	let scope: ExplorerScope | undefined,
		scopes: ExplorerScopeOption[] = [];
	let review: ExplorerReview | null = null,
		reviewError = "",
		notesError = "";
	let viewed = new Set<string>();
	const sentReviews = new Set<string>();
	const draftWrites = new Set<Promise<void>>();
	let viewedWrite = Promise.resolve();
	let targetRange: ExplorerRange | null = null;
	let anchoredLine: number | null = null;
	app.flushDraft = async () => {
		await Promise.all([...draftWrites, editor.flush()]);
	};
	let notes: ExplorerNote[] = [];
	let latestNotes: Promise<void> | undefined;
	let showOtherNotes = true;
	let reviewIntent = 0;
	let launchStamp = 0;
	let editedPaths = new Set<string>();
	type PathIndex = ExplorerRequests["files.list"][1];
	let index: PathIndex | undefined;
	let indexedPaths: { path: string; lower: string }[] = [];
	let indexPending: Promise<void> | undefined;
	let indexVersion = 0;
	let loadedIndexVersion = -1;
	let indexError = "";
	let updateQuickOpen: (() => void) | undefined;
	let filter = "";
	let path = "",
		view: "file" | "changes" = "file",
		file: ExplorerFile | null = null,
		diff: ExplorerDiff | null = null;
	let previewHTML: string | undefined;
	let fileError = "",
		loadingFile = false;
	let headLines: string[] = [],
		baseLines: string[] = [];
	let sheet = false,
		openStamp = 0,
		reviewStamp = 0,
		notesStamp = 0,
		rootStamp = 0;
	let lineRange: ExplorerRange | null = null,
		latestLine = 1;
	let history: (ExplorerLaunch & { path: string })[] = [],
		historyAt = -1;
	let stateTimer = 0,
		noticeTimer = 0;
	let mode: "quick" | "search" | "line" | "scope" | "new-file" | null = null;
	let previousFocus: HTMLElement | null = null;
	let pendingOpen: Extract<ExplorerEvent, { type: "open" }> | undefined;
	let booted = false;
	const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
	const pressed = (node: HTMLElement, value: boolean) => node.setAttribute("aria-pressed", String(value));
	const disabled = (id: string, value: boolean) => {
		get<HTMLButtonElement>(id).disabled = value;
	};
	const basename = (value: string) => value.split("/").at(-1) ?? "";
	const dirname = (value: string) => value.slice(0, Math.max(0, value.lastIndexOf("/")));
	const sha = (value?: string | null) => (typeof value === "string" ? value.slice(0, 7) : "");
	const report = (p: Promise<unknown>) => {
		void p.catch((error) => notice(errorText(error)));
	};
	const sameScope = (a?: ExplorerScope, b?: ExplorerScope) => JSON.stringify(a) === JSON.stringify(b);
	const inReview = () => view === "changes" && root.kind === "git";
	const showsNote = (note: ExplorerNote) => showOtherNotes || note.author === "operator";
	const atReview = (note: ExplorerNote) => !note.reviewKey || note.reviewKey === review?.resolved.key;
	const reviewNotes = () => notes.filter((note) => showsNote(note) && atReview(note));
	const fileNotes = () => notes.filter((note) => showsNote(note) && !note.reviewKey);
	const changePath = (change: ExplorerChange, side?: ExplorerSide) =>
		side === "base" ? (change.oldPath ?? change.path) : change.path;
	type FileNote = ExplorerTargetNote & { target: Extract<ExplorerNoteTarget, { kind: "file" }> };
	const fileTargets = (pool: ExplorerNote[], item: string, change?: ExplorerChange) =>
		pool.filter((note): note is FileNote => {
			const target = note.target;
			return (
				target?.kind === "file" &&
				(change ? target.path === changePath(change, target.side) : target.side !== "base" && target.path === item)
			);
		});
	const lineNotes = (pool: ExplorerNote[], item: string, change?: ExplorerChange) =>
		pool
			.filter(
				(note): note is ExplorerLineNote =>
					note.target === undefined &&
					(change ? note.path === changePath(change, note.side) : note.side === "head" && note.path === item),
			)
			.sort((a, b) => (a.side === b.side ? a.start - b.start || a.end - b.end : a.side === "base" ? -1 : 1));
	const currentChange = () => review?.files.find((item) => item.path === path);
	function activeNotes() {
		if (!inReview()) return lineNotes(fileNotes(), path);
		const change = currentChange();
		return change ? lineNotes(reviewNotes(), path, change) : [];
	}
	function reviewTargets(pool: ExplorerNote[], resolved: ExplorerResolved) {
		return pool.filter(({ target, reviewKey }) => {
			if (target?.kind !== "review") return false;
			const pinned = target.review;
			if (pinned.kind === "uncommitted") return resolved.head === "worktree" && reviewKey === resolved.key;
			if (pinned.kind === "range") return pinned.base === resolved.base && pinned.head === resolved.head;
			return pinned.kind === "commit" && resolved.scope.kind === "commit" && pinned.commit === resolved.head;
		});
	}
	const commitTargets = (pool: ExplorerNote[], commit: string) =>
		pool.filter(({ target }) => target?.kind === "commit" && target.commit === commit);
	function changedFileSequence(pool: ExplorerNote[], item: ExplorerChange) {
		const files = fileTargets(pool, item.path, item);
		const lines = lineNotes(pool, item.path, item);
		return [
			...files.filter(({ target }) => target.side === undefined),
			...files.filter(({ target }) => target.side === "base"),
			...lines.filter(({ side }) => side === "base"),
			...files.filter(({ target }) => target.side === "head"),
			...lines.filter(({ side }) => side === "head"),
		];
	}
	function noteSequence() {
		if (!inReview()) {
			const pool = fileNotes();
			return [...fileTargets(pool, path), ...lineNotes(pool, path)];
		}
		if (!review) return [];
		const pool = reviewNotes();
		const ordered = [
			...reviewTargets(pool, review.resolved),
			...review.commits.flatMap(({ commit }) => commitTargets(pool, commit)),
			...review.files.flatMap((item) => changedFileSequence(pool, item)),
		];
		return [...new Set(ordered)];
	}
	// The context menu matches the lines or rendered block under its pointer.
	function notesOn(range: ExplorerRange) {
		return activeNotes().filter((note) => {
			const spot = locateNote(note);
			return spot?.side === range.side && spot.start <= range.end && range.start <= spot.end;
		});
	}
	const openLabel = (marked: ExplorerNote[]) => {
		if (marked.length > 1) return `Open ${marked.length} notes`;
		return marked[0].state === "draft" ? "Open review comment" : "Open note";
	};
	const scopeLabel = () =>
		review?.resolved.label ?? scopes.find((item) => sameScope(scope, item.scope))?.label ?? "Working files";
	const narrowClose = () => {
		sheet = false;
		renderSidebarState();
	};

	function notice(text: string) {
		status.textContent = text;
		status.title = text;
		clearTimeout(noticeTimer);
		noticeTimer = window.setTimeout(() => {
			status.textContent = "";
			status.title = "";
		}, 5600);
	}
	function renderSidebarState() {
		shell.classList.toggle("sidebar-hidden", !settings.sidebar.open && !isNarrow.matches);
		shell.classList.toggle("sb-open-mobile", sheet);
		get("sheet-shade").hidden = !(sheet && isNarrow.matches);
		get("sidebar-toggle").setAttribute("aria-expanded", String(isNarrow.matches ? sheet : settings.sidebar.open));
		shell.style.setProperty("--sidebar-width", `${settings.sidebar.width}px`);
		get("resize").setAttribute("aria-valuenow", String(settings.sidebar.width));
	}
	function saveSettings() {
		report(request("settings.save", { settings }));
	}
	// The host applies the zoom; the page shows a level other than actual size and offers the reset.
	function renderZoom() {
		const node = get("zoom-level");
		const percent = Math.round(settings.zoom * 100);
		node.hidden = percent === 100;
		node.textContent = `${percent}%`;
	}
	// The host sends the level before it applies it; the resize that follows re-measures the layout.
	function zoomChanged(level: number) {
		settings.zoom = level;
		renderZoom();
		notice(`Zoom ${Math.round(level * 100)}%`);
	}
	function updateNarrow() {
		const narrow = innerWidth * settings.zoom < 760 || innerWidth < 625;
		shell.classList.toggle("narrow", narrow);
		if (narrow === isNarrow.matches) return;
		isNarrow.matches = narrow;
		sheet = false;
		renderSidebarState();
		reviewUI.reposition();
	}
	function savePosition(immediately = false) {
		clearTimeout(stateTimer);
		const write = () => {
			const data: ExplorerLaunch = {
				path: path || undefined,
				line: path ? latestLine : undefined,
				view: settings.tab === "notes" ? "notes" : view,
				review: scope,
			};
			void request("state.save", data).catch(() => {});
		};
		if (immediately) write();
		else stateTimer = window.setTimeout(write, 220);
	}
	function toggleSidebar() {
		if (isNarrow.matches) sheet = !sheet;
		else {
			settings.sidebar.open = !settings.sidebar.open;
			saveSettings();
		}
		renderSidebarState();
		placeStrip();
	}

	const reviewUI = app.review({
		root: () => root,
		scope: scopeLabel,
		live: () => live,
		drafts: () =>
			reviewNotes().filter((note): note is ExplorerLineNote => note.target === undefined && note.state === "draft"),
		notes: () => notes,
		shows: showsNote,
		sequence: noteSequence,
		inReview,
		excerpt: selectionExcerpt,
		bounds: (range) => code.anchor(range),
		highlight: (range) => {
			code.highlight(range);
			setAnchorLine(range?.start ?? null);
		},
		go: goNote,
		follow: followTarget,
		refresh: refreshNotes,
		finish: () => {
			const key = review?.resolved.key;
			const origin = rootStamp;
			return async () => {
				if (origin !== rootStamp || !key) return;
				await setViewed([...viewed], true, key, true);
			};
		},
		saveDraft(draftPath, draft) {
			const location = draftStatePath(draftPath, draft);
			const fields = draft && location === path ? { view, line: anchoredLine ?? latestLine, review: scope } : {};
			const write = request("state.save", { ...fields, path: location, draft }).then(() => {});
			draftWrites.add(write);
			void write.then(
				() => draftWrites.delete(write),
				() => draftWrites.delete(write),
			);
			return write;
		},
		notice,
	});
	const editor = app.editor(body, get("editor-toolbar"), {
		notice,
		change(identity, dirty) {
			if (identity.root !== root.path || editedPaths.has(identity.path) === dirty) return;
			if (dirty) editedPaths.add(identity.path);
			else editedPaths.delete(identity.path);
			if (settings.tab === "files") {
				const row = list.querySelector<HTMLElement>(`[data-path="${CSS.escape(identity.path)}"]:not([aria-expanded])`);
				if (row) markEdited(row, dirty);
			}
		},
		saved(identity, text, base) {
			if (identity.root !== root.path) return;
			if (identity.path === path && view === "file" && editor.active()) {
				file = { ...file, path, kind: "text", text, size: app.editing.byteLength(text), editBase: base };
				headLines = model.lines(text);
				renderFileFacts();
			}
			notice("File saved");
		},
		closed(identity) {
			if (identity.root !== root.path || identity.path !== path || view !== "file") return;
			previewHTML = undefined;
			renderHeader();
			renderCode();
			get("edit-file").focus({ preventScroll: true });
			report(navigate({ path, view }, { refresh: true }));
		},
	});
	function editable() {
		return view === "file" && !loadingFile && !!file?.editBase;
	}
	function openEditor(draft?: ExplorerEditDraft) {
		if (!draft && !editedPaths.has(path) && editedPaths.size >= 32) {
			notice("Explorer holds 32 edited files for this folder. Save or discard one first.");
			return;
		}
		clearNavigationSelection();
		closeMenu(false);
		editor.open({ root: root.path, path }, file, draft);
		renderHeader();
		renderCode();
		editor.focus();
	}
	function toggleEditor() {
		if (editor.active()) editor.toggle();
		else if (editable()) openEditor();
	}
	async function refreshEditedPaths() {
		const origin = rootStamp;
		const result = await request("edit.paths", { root: root.path });
		if (origin !== rootStamp) return;
		editedPaths = new Set(result.paths);
		if (settings.tab === "files") renderSidebar();
	}
	function draftStatePath(draftPath: string, draft: ExplorerCardDraft | null) {
		if (inReview() && diff?.oldPath === draftPath && (!draft || draft.range?.side === "base")) return path;
		return draftPath;
	}
	function excerptCommit(side?: ExplorerSide) {
		if (view !== "changes") return null;
		if (side === "base") return review?.resolved.base ?? null;
		const head = review?.resolved.head;
		return head === "worktree" ? null : (head ?? null);
	}
	function selectionExcerpt(range: ExplorerRange | null): ExplorerExcerpt | null {
		if (editor.active() || !path || !file || file.kind === "directory" || (file.kind === "missing" && !diff))
			return null;
		const lines = range?.side === "base" ? baseLines : headLines;
		const commit = excerptCommit(range?.side);
		if (!range) return { path, commit, text: "" };
		const start = Math.max(1, range.start),
			end = Math.min(lines.length, range.end);
		if (end < start) return null;
		return {
			path: range.side === "base" ? (diff?.oldPath ?? path) : path,
			start,
			end,
			quote: lines.slice(start - 1, end).join("\n"),
			commit,
			text: "",
		};
	}
	function liveChrome() {
		const node = get("connection");
		node.textContent = live.connected ? "Agent connected" : "Local notes only";
		node.title = live.connected ? (live.label ?? "Connected") : (live.reason ?? "No live conversation");
		sidebar.classList.toggle("disconnected", !live.connected);
		reviewUI.refresh();
	}
	function openAbsoluteRoot(path: string) {
		const origin = rootStamp;
		report(
			app.flushDraft().then(() => {
				if (origin === rootStamp) return request("root.open", { path });
			}),
		);
	}
	function openRelativeRoot(path: string) {
		openAbsoluteRoot(root.path === "/" ? `${root.path}${path}` : `${root.path}/${path}`);
	}
	function appendTrailSegment(trail: HTMLElement, path: string, name: string) {
		if (path === root.path) {
			const item = el("span", "root-segment", root.name);
			item.title = path;
			item.setAttribute("aria-current", "location");
			trail.append(item);
		} else {
			const item = button(name, () => openAbsoluteRoot(path), "root-segment");
			item.title = path;
			const divider = el("span", "slash", "/");
			divider.setAttribute("aria-hidden", "true");
			trail.append(item, divider);
		}
	}
	function rootTrail() {
		const trail = get("repo-name");
		const prefix = base.path.endsWith("/") ? base.path : `${base.path}/`;
		const parts = root.path.startsWith(prefix) ? root.path.slice(prefix.length).split("/").filter(Boolean) : [];
		trail.replaceChildren();
		appendTrailSegment(trail, parts.length ? base.path : root.path, base.name);
		for (const [index, part] of parts.entries()) {
			appendTrailSegment(trail, prefix + parts.slice(0, index + 1).join("/"), part);
		}
		trail.scrollLeft = trail.scrollWidth;
	}
	function rootChrome() {
		get("head-sha").textContent = sha(root.head);
		get("head-sha").hidden = !root.head;
		get("capture-short").textContent = root.branch ?? "";
		document.title = `Explorer · ${root.name}`;
	}
	function empty(title: string, detail: string, glyphName = "file", action?: HTMLElement) {
		const node = el("div", "empty-view");
		node.append(icon(glyphName), el("strong", "", title), el("p", "", detail));
		if (action) node.append(action);
		body.replaceChildren(node);
	}

	const tree = app.fileTree((path) => request("files.folder", { path }), scheduleTree);
	const treeCanvas = el("div", "tree-canvas");
	const rowHeight = 29;
	const pathQueryDelay = 80;
	treeCanvas.style.setProperty("--tree-row-height", `${rowHeight}px`);
	let treeFrame = 0;
	let scrollFrame = 0;
	let filterTimer = 0;
	let filteredRows: ExplorerTreeRow[] | undefined;
	let displayedRows: ExplorerTreeRow[] = [];
	const pathIndices = new Map<string, number>();
	let focusPath: string | undefined;
	let focusIndex = -1;
	const mountedRows = new Map<number, { node: HTMLElement; button?: HTMLButtonElement }>();

	function scheduleTree() {
		filteredRows = undefined;
		if (settings.tab !== "files" || treeFrame) return;
		treeFrame = requestAnimationFrame(() => {
			treeFrame = 0;
			if (settings.tab === "files") renderTree();
		});
	}
	function revealPath(value: string, self = false) {
		const target = self ? value : dirname(value);
		return target ? tree.reveal(target) : Promise.resolve();
	}
	function fileRowIcon(item: string, folder: boolean) {
		if (folder) return icon(tree.isExpanded(item) ? "open" : "folder");
		const language = model.language(item);
		if (!language.mark) return icon("file");
		return el("span", `language-mark lang-${language.id}`, language.mark);
	}
	function toggleFolder(item: string) {
		if (filter) {
			const origin = rootStamp;
			clearTimeout(filterTimer);
			filter = filterInput.value = "";
			filteredRows = undefined;
			report(
				tree.reveal(item).then(() => {
					if (origin === rootStamp && settings.tab === "files" && !filter) renderTree(item);
				}),
			);
			return;
		}
		void tree.setExpanded(item, !tree.isExpanded(item));
		renderTree(item);
	}
	function markEdited(row: HTMLElement, dirty: boolean) {
		row.querySelector(".edited-mark")?.remove();
		if (dirty) row.append(el("span", "edited-mark", "Edited"));
	}
	function branchPill(repo: ExplorerRepository) {
		const name = repo.branch ?? sha(repo.head);
		const pill = el("span", "branch-pill", name || "Git");
		pill.title = repo.branch ?? (repo.head ? `Detached HEAD at ${repo.head}` : "Git repository");
		return pill;
	}
	function treeRow(row: ExplorerTreeRow) {
		const node = el("div", "tree-slot");
		node.style.setProperty("--depth", String(row.depth));
		if (row.kind === "status") {
			if (row.retry) {
				const retry = button(row.message, () => void tree.load(row.folder), "folder-list-status");
				retry.title = "Try again";
				retry.dataset.retryFolder = row.folder;
				node.append(retry);
			} else node.append(el("p", "folder-list-status", row.message));
			return { node };
		}
		const entry = row.entry;
		const item = entry.path;
		const folder = entry.kind === "folder";
		const open = button(
			"",
			() => {
				if (folder) toggleFolder(item);
				else report(navigate({ path: item, view: "file" }));
			},
			entry.ignored ? "list-row is-ignored" : "list-row",
		);
		open.dataset.path = item;
		open.title = item;
		if (folder) open.setAttribute("aria-expanded", String(tree.isExpanded(item)));
		else if (item === path && view === "file") open.setAttribute("aria-current", "true");
		open.append(fileRowIcon(item, folder), el("span", "row-title", entry.name));
		if (entry.repo) open.append(branchPill(entry.repo));
		if (!folder && editedPaths.has(item)) markEdited(open, true);
		node.append(open);
		if (entry.repo) {
			const promote = iconButton("promote-root", "Open as Root", () => openRelativeRoot(item));
			promote.classList.add("promote-root");
			node.append(promote);
		}
		return { node, button: open };
	}
	function filterRows() {
		if (filteredRows) return filteredRows;
		const loaded = new Map(Array.from(tree.entries(), (entry) => [entry.path, entry]));
		function* candidates() {
			yield* loaded.values();
			for (const entry of indexedPaths) if (!loaded.has(entry.path)) yield entry;
		}
		const rows: ExplorerTreeRow[] = model.fuzzy(candidates(), filter, Infinity).map(({ path }) => ({
			kind: "entry",
			depth: 0,
			entry: loaded.get(path) ?? { path, name: basename(path), kind: "file", lower: "" },
		}));
		if (!rows.length && !indexPending && !indexError)
			rows.push({ kind: "status", folder: "", depth: 0, message: "No paths match this filter." });
		filteredRows = rows;
		return rows;
	}
	function activeTreeButton() {
		const active = document.activeElement;
		return active instanceof HTMLElement && treeCanvas.contains(active)
			? active.closest<HTMLElement>(".tree-slot")?.querySelector<HTMLButtonElement>("[data-path]")
			: undefined;
	}
	function treeWindow(pin: boolean) {
		const first = Math.max(0, Math.floor(list.scrollTop / rowHeight) - 8);
		const end = Math.min(displayedRows.length, Math.ceil((list.scrollTop + list.clientHeight) / rowHeight) + 8);
		const wanted = new Set<number>();
		for (let i = first; i < end; i++) wanted.add(i);
		if (pin && focusIndex >= 0) wanted.add(focusIndex);
		return wanted;
	}
	function treeTabStop(wanted: Set<number>) {
		if (wanted.has(focusIndex)) return focusIndex;
		for (const i of wanted) if (pathAt(i) !== undefined) return i;
		return -1;
	}
	function mountTreeRows(wanted: Set<number>, tabStop: number) {
		for (const [index, row] of mountedRows) {
			if (wanted.has(index)) continue;
			row.node.remove();
			mountedRows.delete(index);
		}
		let before: HTMLElement | null = null;
		for (const index of [...wanted].sort((a, b) => b - a)) {
			let row = mountedRows.get(index);
			if (!row) {
				row = treeRow(displayedRows[index]);
				row.node.style.top = `${index * rowHeight}px`;
				mountedRows.set(index, row);
				treeCanvas.insertBefore(row.node, before);
			}
			if (row.button) row.button.tabIndex = Number(index === tabStop) - 1;
			before = row.node;
		}
	}
	function paintTree(keepFocus = false) {
		if (!treeCanvas.isConnected) return;
		const wanted = treeWindow(keepFocus || !!activeTreeButton());
		mountTreeRows(wanted, treeTabStop(wanted));
	}
	function pathAt(index: number) {
		const row = displayedRows[index];
		return row?.kind === "entry" ? row.entry.path : undefined;
	}
	function rowIndex(item?: string) {
		return item ? (pathIndices.get(item) ?? -1) : -1;
	}
	function scrollTreeRow(index: number) {
		const top = index * rowHeight;
		if (top < list.scrollTop) list.scrollTop = top;
		else if (top + rowHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + rowHeight - list.clientHeight;
	}
	function focusTreeRow(index: number) {
		if (pathAt(index) === undefined) return;
		focusIndex = index;
		focusPath = pathAt(index);
		scrollTreeRow(index);
		paintTree(true);
		mountedRows.get(index)?.button?.focus({ preventScroll: true });
	}
	function updateDisplayedRows(rows: ExplorerTreeRow[]) {
		if (rows === displayedRows) return;
		displayedRows = rows;
		pathIndices.clear();
		for (const [index, row] of rows.entries()) if (row.kind === "entry") pathIndices.set(row.entry.path, index);
	}
	function nextFocusIndex(key: string | undefined, preserve: boolean) {
		for (let item = key; item; item = dirname(item)) {
			const index = rowIndex(item);
			if (index >= 0) return index;
		}
		if (!preserve) return -1;
		for (let i = Math.max(0, Math.min(focusIndex, displayedRows.length - 1)); i >= 0; i--) {
			if (pathAt(i) !== undefined) return i;
		}
		return -1;
	}
	function restoreTreeFocus(refocus: boolean, promote: boolean) {
		if (focusIndex < 0) filterInput.focus({ preventScroll: true });
		else if (refocus) focusTreeRow(focusIndex);
		else {
			const row = mountedRows.get(focusIndex);
			const tool = promote ? row?.node.querySelector<HTMLButtonElement>(".promote-root") : null;
			(tool ?? row?.button)?.focus({ preventScroll: true });
		}
	}
	function restoreRetryFocus(folder: string) {
		const retry = treeCanvas.querySelector<HTMLElement>(`[data-retry-folder="${CSS.escape(folder)}"]`);
		if (retry) retry.focus({ preventScroll: true });
		else if (rowIndex(folder) >= 0) focusTreeRow(rowIndex(folder));
		else filterInput.focus({ preventScroll: true });
	}
	function filterMessage() {
		if (!filter) return "";
		if (indexPending) return "Indexing paths…";
		if (indexError) return indexError;
		return index?.truncated ? "The path index is partial." : "";
	}
	function renderTree(refocus?: string) {
		cancelAnimationFrame(treeFrame);
		treeFrame = 0;
		const focused = activeTreeButton();
		const promote = focused !== document.activeElement;
		const key = refocus ?? focused?.dataset.path ?? focusPath;
		const active = document.activeElement;
		const retrying =
			active instanceof HTMLElement && treeCanvas.contains(active) ? active.dataset.retryFolder : undefined;
		if (!list.contains(treeCanvas)) list.replaceChildren(treeCanvas);
		const scroll = list.scrollTop;
		filterStatus.textContent = filterMessage();
		filterStatus.hidden = !filterStatus.textContent;
		updateDisplayedRows(filter ? filterRows() : tree.rows());
		focusIndex = nextFocusIndex(key, !!focused);
		focusPath = pathAt(focusIndex);
		mountedRows.clear();
		treeCanvas.replaceChildren();
		treeCanvas.style.height = `${displayedRows.length * rowHeight}px`;
		list.scrollTop = scroll;
		paintTree(!!focused);
		if (refocus || focused) restoreTreeFocus(!!refocus, promote);
		else if (retrying !== undefined) restoreRetryFocus(retrying);
	}
	list.addEventListener(
		"scroll",
		() => {
			if (scrollFrame || settings.tab !== "files") return;
			scrollFrame = requestAnimationFrame(() => {
				scrollFrame = 0;
				if (settings.tab === "files") paintTree();
			});
		},
		{ passive: true },
	);
	new ResizeObserver(() => {
		if (settings.tab === "files") paintTree();
	}).observe(list);
	treeCanvas.addEventListener("focusin", () => {
		const item = activeTreeButton()?.dataset.path;
		if (item && item !== focusPath) {
			focusPath = item;
			focusIndex = rowIndex(item);
			paintTree();
		}
	});
	function stepTreeRow(start: number, step: number) {
		for (let i = start; i >= 0 && i < displayedRows.length; i += step) {
			if (pathAt(i) === undefined) continue;
			focusTreeRow(i);
			break;
		}
	}
	function expandOrEnter(row: ExplorerTreeEntry) {
		if (row.kind !== "folder") return;
		const item = row.path;
		if (filter || !tree.isExpanded(item)) toggleFolder(item);
		else if (pathAt(focusIndex + 1)?.startsWith(`${item}/`)) focusTreeRow(focusIndex + 1);
	}
	function collapseOrLeave(row: ExplorerTreeEntry) {
		if (row.kind === "folder" && !filter && tree.isExpanded(row.path)) toggleFolder(row.path);
		else focusTreeRow(rowIndex(dirname(row.path)));
	}
	const treeKeys: Record<string, (row: ExplorerTreeEntry) => void> = {
		ArrowUp: () => stepTreeRow(focusIndex - 1, -1),
		ArrowDown: () => stepTreeRow(focusIndex + 1, 1),
		Home: () => stepTreeRow(0, 1),
		End: () => stepTreeRow(displayedRows.length - 1, -1),
		Enter: () => mountedRows.get(focusIndex)?.button?.click(),
		ArrowRight: expandOrEnter,
		ArrowLeft: collapseOrLeave,
	};
	treeCanvas.addEventListener("keydown", (event) => {
		if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
		if (!(event.target instanceof HTMLButtonElement)) return;
		const row = displayedRows[focusIndex];
		if (row?.kind !== "entry" || row.entry.path !== event.target.dataset.path) return;
		if (!Object.hasOwn(treeKeys, event.key)) return;
		event.preventDefault();
		treeKeys[event.key](row.entry);
	});
	const filterLabel = el("label", "filter");
	const filterInput = el("input");
	filterInput.type = "search";
	filterInput.placeholder = "Filter files";
	filterInput.setAttribute("aria-label", "Filter files");
	filterInput.addEventListener("input", () => {
		clearTimeout(filterTimer);
		filterTimer = window.setTimeout(() => {
			filter = filterInput.value.trim();
			filteredRows = undefined;
			list.scrollTop = 0;
			if (settings.tab !== "files") return;
			if (filter) void ensureIndex();
			renderTree();
		}, pathQueryDelay);
	});
	filterLabel.append(icon("search"), filterInput);
	const filterStatus = el("p", "filter-status");
	filterStatus.setAttribute("role", "status");
	filterStatus.hidden = true;
	const filesHead = el("div");
	const filesTools = el("div", "files-tools");
	const newFileButton = iconButton("new-file", "New file", () =>
		command("new-file", file?.kind === "directory" ? path : dirname(path)),
	);
	filesTools.append(filterLabel, newFileButton);
	filesHead.append(filesTools, filterStatus);

	function appendScopeOptions(choices: HTMLSelectElement) {
		for (const [position, item] of scopes.entries()) {
			const option = el("option", "", item.available || !item.reason ? item.label : `${item.label} (${item.reason})`);
			option.value = String(position);
			option.disabled = !item.available;
			choices.append(option);
		}
		for (const [value, text] of [
			["enter-commit", "Choose a commit…"],
			["enter-range", "Choose a commit range…"],
		]) {
			const item = el("option", "", text);
			item.value = value;
			choices.append(item);
		}
	}
	function chooseScope(value: string) {
		if (value === "current") return;
		if (value === "enter-range" || value === "enter-commit") {
			command("scope", value === "enter-range" ? "range" : "commit");
			return;
		}
		const item = scopes[Number(value)];
		if (item?.available) report(selectScope(item.scope));
	}
	function makeScopeControl(inSidebar: boolean) {
		const choices = el("select", "scope-menu");
		choices.dataset.part = "scope-menu";
		choices.setAttribute("aria-label", inSidebar ? "Review scope in sidebar" : "Review scope");
		const index = scopes.findIndex((item) => sameScope(item.scope, scope));
		if (index < 0 || !inSidebar) {
			const item = el("option", "", scopeLabel());
			item.value = "current";
			choices.append(item);
		}
		appendScopeOptions(choices);
		const selected = inSidebar && index >= 0 ? String(index) : "current";
		choices.value = selected;
		choices.onchange = () => {
			const value = choices.value;
			choices.value = selected;
			chooseScope(value);
		};
		return choices;
	}
	function viewedButton(item: ExplorerChange) {
		const check = button(
			"",
			() => {
				const next = new Set(viewed);
				if (next.has(item.path)) next.delete(item.path);
				else next.add(item.path);
				report(setViewed([...next], !!review?.files.length && review.files.every((file) => next.has(file.path))));
			},
			"viewed",
		);
		check.setAttribute("aria-label", `Viewed: ${item.path}`);
		pressed(check, viewed.has(item.path));
		if (viewed.has(item.path)) check.append(icon("check"));
		return check;
	}
	function targetMarker(marked: ExplorerNote[], label: string, destination?: string) {
		if (!marked.length) return null;
		return noteMarker(marked, label, () => report(openNote(marked, destination)));
	}
	function changeRow(item: ExplorerChange, pool: ExplorerNote[]) {
		const row = el("div", `change-row${item.path === path ? " current" : ""}`);
		const open = button("", () => report(navigate({ path: item.path, view: "changes" })), "changed-open");
		const kind = el(
			"span",
			`git-status ${item.status}`,
			item.status === "typechange" ? "T" : item.status.at(0)?.toUpperCase(),
		);
		kind.setAttribute("aria-label", item.status);
		const description = el("span", "change-text");
		description.append(el("strong", "", basename(item.path)), el("small", "", dirname(item.path) || root.name));
		const count = el("span", "numstat");
		if (item.binary) count.append("Binary");
		else count.append(el("span", "added", `+${item.additions}`), el("span", "deleted", `−${item.deletions}`));
		open.append(kind, description, count);
		open.dataset.path = item.path;
		if (item.path === path) open.setAttribute("aria-current", "true");
		row.append(open);
		const marker = targetMarker(fileTargets(pool, item.path, item), `on ${item.path}`, item.path);
		if (marker) row.append(marker);
		row.append(viewedButton(item));
		return row;
	}
	function appendReviewSummary(summary: HTMLElement) {
		if (review) {
			const ref = el("div", "range-id");
			const { base, head } = review.resolved;
			ref.append(
				el("code", "", `${sha(base) || "empty"}..${head === "worktree" ? "worktree" : sha(head)}`),
				` · ${review.commits.length} commit${review.commits.length === 1 ? "" : "s"}`,
			);
			const count = review.files.filter((item) => viewed.has(item.path)).length;
			const outcome = sentReviews.has(review.resolved.key) ? " · Review sent" : "";
			summary.append(ref, el("p", "", `${count} of ${review.files.length} viewed${outcome}`));
		} else summary.append(el("p", "", reviewError || "Reading review…"));
	}
	let commitsExpanded = false;
	function commitList(entries: ExplorerReview["commits"], pool: ExplorerNote[]) {
		const details = el("details");
		details.open = commitsExpanded;
		details.addEventListener("toggle", () => {
			if (details.isConnected) commitsExpanded = details.open;
		});
		details.append(el("summary", "", `${entries.length} commit${entries.length === 1 ? "" : "s"} in this range`));
		const commits = el("ol");
		for (const commit of entries) {
			const item = el("li");
			const label = el("span", "commit-label");
			label.append(el("code", "", commit.short), ` ${commit.subject}`);
			item.append(label);
			const marker = targetMarker(commitTargets(pool, commit.commit), `on commit ${commit.short}`);
			if (marker) item.append(marker);
			commits.append(item);
		}
		details.append(commits);
		return details;
	}
	function renderChangedFiles(pool: ExplorerNote[]) {
		if (review?.files.length) list.append(el("div", "list-label", "CHANGED FILES"));
		for (const item of review?.files ?? []) {
			list.append(changeRow(item, pool));
		}
		if (review && !review.files.length) list.append(el("p", "empty-list", "No files changed in this scope."));
	}
	function repositoryListStatus() {
		if (indexPending || (!index && !indexError)) return "Indexing repositories…";
		if (indexError) return indexError;
		if (index?.repositoriesTruncated) return "The repository list is partial.";
		return index?.repositories.length ? "" : "No nested repositories found.";
	}
	function renderRepositories() {
		list.append(el("div", "list-label", "REPOSITORIES"));
		for (const repo of index?.repositories ?? []) {
			const item = button("", () => openRelativeRoot(repo.path), "list-row repository-open");
			item.title = repo.path;
			item.setAttribute("aria-label", `Open ${repo.path} as Root`);
			item.append(icon("branch"), el("span", "row-title", repo.path), branchPill(repo), icon("promote-root"));
			list.append(item);
		}
		const message = repositoryListStatus();
		if (message) list.append(el("p", "empty-list", message));
	}
	function renderChanges() {
		if (root.kind !== "git") {
			renderRepositories();
			return;
		}
		const summary = el("div", "range-box");
		const kicker = el("div", "range-kicker", "REVIEW RANGE");
		kicker.prepend(icon("branch"));
		const pool = reviewNotes();
		if (review) {
			const marker = targetMarker(reviewTargets(pool, review.resolved), "on this review");
			if (marker) kicker.append(marker);
		}
		summary.append(kicker, makeScopeControl(true));
		appendReviewSummary(summary);
		if (review?.commits.length) summary.append(commitList(review.commits, pool));
		heading.append(summary);
		renderChangedFiles(pool);
	}
	// A note anchored at the open review's own commit keeps its lines in that review.
	function anchoredInReview(note: ExplorerLineNote) {
		const resolved = review?.resolved;
		const commit = note.side === "base" ? resolved?.base : resolved?.head;
		return !!commit && note.anchor.commit === commit;
	}
	function targetLocation(target: ExplorerNoteTarget) {
		if (target.kind === "commit") return `Commit ${sha(target.commit)}`;
		if (target.kind === "review") return "Review";
		return target.side === "base" ? "Old file" : "File";
	}
	function noteLocation(note: ExplorerNote) {
		if (note.target !== undefined) return targetLocation(note.target);
		if (note.location === "outdated" && anchoredInReview(note)) return `L${note.anchor.start} · in this review`;
		if (note.location === "outdated") return `Outdated · was L${note.anchor.start}`;
		if (note.location === "moved") return `L${note.start} · moved from L${note.movedFrom ?? note.anchor.start}`;
		return `L${note.start}`;
	}
	function noteRow(note: ExplorerNote) {
		const row = el("div", "note-list-row");
		const open = button("", () => report(openNote([note])), "note-open");
		open.dataset.path = note.id;
		const kind = el("span", `note-kind ${note.author}`);
		kind.append(icon(note.author === "operator" ? "note" : note.author === "agent" ? "ask" : "comment-remote"));
		const preview = el("span", "note-preview");
		const loc = noteLocation(note);
		preview.append(
			el("strong", "", note.title || note.text.split("\n")[0]),
			el(
				"small",
				note.target === undefined && note.location === "moved" ? "moved-fact" : "",
				`${loc} · ${note.author === "remote" ? (note.by ?? "Reviewer") : note.author === "agent" ? "Agent" : "You"} · ${note.state}`,
			),
		);
		open.append(kind, preview);
		row.append(open);
		return row;
	}
	function renderNotes() {
		const intro = el("div", "notes-heading");
		intro.append(el("strong", "", "Repository notes"));
		heading.append(intro);
		if (notesError) {
			list.append(
				el("p", "empty-list", notesError),
				button("Try again", () => report(refreshNotes()), "quiet"),
			);
			return;
		}
		const indexed = reviewNotes();
		if (!indexed.length) {
			list.append(el("p", "empty-list", "No notes to show."));
			return;
		}
		for (const { label, folder, entries } of groupNotes(indexed)) {
			const group = el("section", "note-group");
			const header = el("header");
			header.append(el("strong", "", label), el("small", "", folder));
			group.append(header);
			for (const note of entries) group.append(noteRow(note));
			list.append(group);
		}
	}
	function noteGroupKey(note: ExplorerNote): { kind: "file"; path: string } | { kind: "commit" | "review" } {
		if (note.target === undefined) return { kind: "file", path: note.path };
		return note.target.kind === "file" ? { kind: "file", path: note.target.path } : { kind: note.target.kind };
	}
	function groupNotes(items: ExplorerNote[]) {
		const groups = new Map<string, { label: string; folder: string; entries: ExplorerNote[] }>();
		for (const note of items) {
			const target = noteGroupKey(note);
			const key = JSON.stringify(target);
			let group = groups.get(key);
			if (!group) {
				group = { ...noteGroupLabel(target), entries: [] };
				groups.set(key, group);
			}
			group.entries.push(note);
		}
		return groups.values();
	}
	function noteGroupLabel(target: ReturnType<typeof noteGroupKey>) {
		if (target.kind === "file") return { label: basename(target.path), folder: dirname(target.path) || root.name };
		return { label: target.kind === "commit" ? "Commits" : "Reviews", folder: root.name };
	}
	function prepareSidebarHeading() {
		if (settings.tab === "files") {
			if (!heading.contains(filesHead)) heading.replaceChildren(filesHead);
		} else heading.replaceChildren();
	}
	function focusedPath(active: HTMLElement | null) {
		return active && list.contains(active) ? active.dataset.path : undefined;
	}
	let sidebarTab: ExplorerTab | undefined;
	function renderSidebar() {
		sidebarTab = settings.tab;
		const active = document.activeElement as HTMLElement | null;
		const key = focusedPath(active);
		const scroll = list.scrollTop;
		prepareSidebarHeading();
		if (settings.tab !== "files") list.replaceChildren();
		const tabs = get("note-tabs");
		for (const tab of tabs.querySelectorAll<HTMLElement>("[data-tab]")) pressed(tab, tab.dataset.tab === settings.tab);
		get("change-count").textContent = review ? String(review.files.length) : "";
		const noteCount = reviewNotes().length;
		get("note-count").textContent = noteCount ? String(noteCount) : "";
		if (settings.tab === "files") {
			renderTree();
			return;
		}
		if (settings.tab === "changes") renderChanges();
		else renderNotes();
		if (key) list.querySelector<HTMLElement>(`[data-path="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
		list.scrollTop = scroll;
	}
	function markCurrentFile(item: string) {
		const row = mountedRows.get(rowIndex(item))?.button;
		if (!row || row.hasAttribute("aria-expanded")) return;
		if (item === path && view === "file") row.setAttribute("aria-current", "true");
		else row.removeAttribute("aria-current");
	}
	function markCurrentChange(item: string) {
		const row = list.querySelector(`.changed-open[data-path="${CSS.escape(item)}"]`);
		if (item === path) row?.setAttribute("aria-current", "true");
		else row?.removeAttribute("aria-current");
		row?.parentElement?.classList.toggle("current", item === path);
	}
	function syncNavigationSidebar(previous: string) {
		if (sidebarTab !== settings.tab) {
			renderSidebar();
			return;
		}
		const mark =
			settings.tab === "files" ? markCurrentFile : settings.tab === "changes" ? markCurrentChange : undefined;
		mark?.(previous);
		if (path !== previous) mark?.(path);
	}
	function tabUsesIndex(tab: ExplorerTab) {
		return (tab === "files" && !!filter) || (tab === "changes" && root.kind === "folder");
	}
	async function setTab(tab: ExplorerTab, switchView = false) {
		settings.tab = tab;
		if (tabUsesIndex(tab)) void ensureIndex();
		renderSidebar();
		saveSettings();
		savePosition();
		if (tab === "changes" && root.kind === "git") return showChangesTab(switchView);
		if (tab === "files" && switchView && view === "changes")
			await navigate({ path, view: "file" }, { keepSheet: true, keepTab: true });
	}
	async function showChangesTab(switchView: boolean) {
		if (!review) await refreshReview();
		if (settings.tab !== "changes") return;
		if (switchView && review && !inReview()) {
			const candidate = currentChange() ?? review.files[0];
			await navigate({ path: candidate?.path ?? "", view: "changes" }, { keepSheet: true, keepTab: true });
		} else renderHeader();
	}
	function indexInUse() {
		return mode === "quick" || tabUsesIndex(settings.tab);
	}
	function indexUpdated() {
		updateQuickOpen?.();
		if (settings.tab === "files" && filter) scheduleTree();
		else if (settings.tab === "changes" && root.kind === "folder") renderSidebar();
	}
	// File events rebuild an index in use no more often than a few times its last build time, so a large folder
	// that changes constantly does not keep the host listing it. Opening Quick Open, typing a filter or selecting
	// a tab still rebuilds a stale index at once.
	let indexBuilt = { at: 0, took: 0 };
	let indexRefreshTimer = 0;
	function scheduleIndexRefresh() {
		if (indexRefreshTimer || indexPending) return;
		const origin = rootStamp;
		const wait = indexBuilt.at + Math.max(5000, 3 * indexBuilt.took) - performance.now();
		indexRefreshTimer = window.setTimeout(
			() => {
				indexRefreshTimer = 0;
				if (origin === rootStamp && indexInUse()) void ensureIndex();
			},
			Math.max(0, wait),
		);
	}
	function ensureIndex() {
		if (indexPending || loadedIndexVersion === indexVersion) return indexPending;
		clearTimeout(indexRefreshTimer);
		indexRefreshTimer = 0;
		const origin = rootStamp;
		const version = indexVersion;
		const started = performance.now();
		indexError = "";
		indexPending = request("files.list")
			.then((result) => {
				if (origin !== rootStamp) return;
				index = result;
				indexedPaths = result.paths.map((path) => ({ path, lower: path.toLowerCase() }));
				loadedIndexVersion = version;
			})
			.catch((error) => {
				if (origin === rootStamp) indexError = errorText(error);
			})
			.finally(() => {
				if (origin !== rootStamp) return;
				indexPending = undefined;
				indexBuilt = { at: performance.now(), took: performance.now() - started };
				indexUpdated();
				if (version !== indexVersion && indexInUse()) scheduleIndexRefresh();
			});
		indexUpdated();
		return indexPending;
	}
	async function loadRootListing() {
		const origin = rootStamp;
		await tree.load("");
		if (origin !== rootStamp) return;
		if (settings.tab === "files") renderTree();
		requestAnimationFrame(() =>
			requestAnimationFrame(() => {
				if (origin === rootStamp) void ensureIndex();
			}),
		);
	}
	function renderNotePresentation() {
		renderSidebar();
		renderFileMarkers();
		renderOutdated();
		code.updateNotes(activeNotes());
		reviewUI.refresh();
	}
	function refreshNotes() {
		const stamp = ++notesStamp;
		const origin = rootStamp;
		latestNotes = loadNotes(stamp, origin);
		return latestNotes;
	}
	async function loadNotes(stamp: number, origin: number): Promise<void> {
		try {
			const result = await request("notes.list");
			if (stamp === notesStamp) {
				notes = result.notes;
				notesError = "";
			}
		} catch (error) {
			if (stamp === notesStamp) notesError = errorText(error);
		}
		if (origin !== rootStamp) return;
		if (stamp !== notesStamp) return latestNotes;
		renderNotePresentation();
	}
	async function refreshScopes() {
		if (root.kind !== "git") return;
		const stamp = rootStamp;
		try {
			const data = await request("review.scopes");
			if (stamp !== rootStamp) return;
			scopes = data.scopes;
			scope ??=
				scopes.find((item) => item.id === data.defaultId && item.available)?.scope ??
				scopes.find((item) => item.available)?.scope;
			if (settings.tab === "changes") renderSidebar();
		} catch (error) {
			if (stamp === rootStamp) reviewError = errorText(error);
		}
	}
	function staleReview(stamp: number, requested: ExplorerScope) {
		return stamp !== reviewStamp || !sameScope(requested, scope);
	}
	async function refreshReview(confirmed?: ExplorerReview) {
		const origin = rootStamp;
		if (!scope) await refreshScopes();
		if (origin !== rootStamp || !scope || root.kind !== "git") return;
		const stamp = ++reviewStamp;
		const requested = scope;
		try {
			const result = confirmed ?? (await request("review.files", { scope: requested }));
			if (staleReview(stamp, requested)) return;
			const state = await request("review.state", { op: "get", key: result.resolved.key });
			if (staleReview(stamp, requested)) return;
			review = result;
			reviewError = "";
			viewed = new Set(state.viewed);
		} catch (error) {
			if (staleReview(stamp, requested)) return;
			reviewError = errorText(error);
			review = null;
			viewed.clear();
		}
		renderHeader();
		renderNotePresentation();
	}
	function writeReviewState(key: string, viewed: string[], finish: boolean, sent: boolean) {
		return request("review.state", {
			op: "set",
			key,
			viewed: sent ? undefined : viewed,
			finished: finish || undefined,
		});
	}
	async function setViewed(next: string[], finish: boolean, key = review?.resolved.key, sent = false) {
		if (!key) return;
		const savedRoot = rootStamp;
		const previous = viewed;
		const candidate = new Set(next);
		if (key === review?.resolved.key && !sent) {
			viewed = candidate;
			renderSidebar();
		}
		const write = viewedWrite.then(async () => {
			if (savedRoot !== rootStamp) return;
			await writeReviewState(key, next, finish, sent);
			if (savedRoot !== rootStamp) return;
			if (sent) sentReviews.add(key);
			if (key === review?.resolved.key) renderSidebar();
		});
		viewedWrite = write.catch(() => {});
		try {
			await write;
		} catch (error) {
			if (viewed === candidate) viewed = previous;
			renderSidebar();
			throw error;
		}
	}

	function renderCrumbs() {
		const crumbs = get("crumbs");
		crumbs.replaceChildren();
		const parts = path.split("/");
		crumbs.append(button(root.name, () => report(navigate({ path: "", view: "file" }, { keepSheet: true }))));
		for (let index = 0; index + 1 < parts.length; index++) {
			const folder = parts.slice(0, index + 1).join("/");
			crumbs.append(
				el("span", "dot", "/"),
				button(parts[index], () => report(navigate({ path: folder, view: "file" }, { keepSheet: true }))),
			);
		}
		if (path) crumbs.append(el("span", "dot", "/"));
	}
	function fileFacts(file: ExplorerFile) {
		const pieces: string[] = [];
		if (file.kind === "text")
			pieces.push(
				`${(view === "file" ? headLines : model.lines(file.text)).length.toLocaleString()}${file.truncated ? "+" : ""} lines`,
			);
		if (file.kind !== "directory" && file.kind !== "missing") pieces.push(model.size(file.size));
		if (file.kind === "text") pieces.push(model.language(path, file.text?.slice(0, 8192).split("\n", 1)[0]).label);
		else if (file.mediaType) pieces.push(file.mediaType);
		return pieces;
	}
	function renderFileFacts() {
		const facts = get("file-facts");
		facts.replaceChildren();
		if (file) {
			facts.append(fileFacts(file).join(" · "));
			if (file.lastCommit) {
				const commit = el("span", "last-touch");
				commit.append(" · ", el("code", "", sha(file.lastCommit.commit)), el("span", "", file.lastCommit.subject));
				facts.append(commit);
			}
		} else if (path && loadingFile) facts.append("Reading file…");
	}
	function diffModes() {
		const modes = el("div", "seg diff-modes");
		modes.setAttribute("aria-label", "Diff layout");
		for (const value of ["auto", "unified", "split"] as const) {
			const control = button(value[0].toUpperCase() + value.slice(1), () => {
				const saved = code.place();
				settings.diff = value;
				saveSettings();
				renderHeader();
				renderCode(saved);
			});
			pressed(control, settings.diff === value);
			modes.append(control);
		}
		return modes;
	}
	function renderDiffHeader(change: ExplorerChange | undefined) {
		const toolbar = get("diff-header");
		toolbar.hidden = view !== "changes" || !path;
		if (toolbar.hidden) return;
		const info = el("div", "compare-info");
		info.append(el("strong", "", "Changes"));
		if (review) {
			const { base, head } = review.resolved;
			info.append(el("code", "", `${sha(base) || "empty"}..${head === "worktree" ? "worktree" : sha(head)}`));
		}
		if (change && !change.binary)
			info.append(el("span", "added", `+${change.additions}`), el("span", "deleted", `−${change.deletions}`));
		if (change?.oldPath) info.append(el("span", "rename-caption", `From ${change.oldPath}`));
		toolbar.replaceChildren(info, diffModes());
	}
	const fileMarkers = el("span", "file-note-markers");
	get("file-title").after(fileMarkers);
	const otherNotesToggle = iconButton("note", "Show agent and remote notes", () => {
		showOtherNotes = !showOtherNotes;
		pressed(otherNotesToggle, showOtherNotes);
		renderNotePresentation();
	});
	otherNotesToggle.classList.add("notes-visibility");
	pressed(otherNotesToggle, showOtherNotes);
	get("ask-file").after(otherNotesToggle);
	function renderFileMarkers() {
		const change = inReview() ? currentChange() : undefined;
		const pool = inReview() ? (change ? reviewNotes() : []) : fileNotes();
		const marker = path ? targetMarker(fileTargets(pool, path, change), `on ${path}`, change?.path) : null;
		const focused = fileMarkers.contains(document.activeElement);
		fileMarkers.replaceChildren(...(marker ? [marker] : []));
		fileMarkers.hidden = !marker;
		if (focused) (marker ?? otherNotesToggle).focus({ preventScroll: true });
	}
	function renderHeader() {
		const editing = editor.active();
		shell.classList.toggle("editing", editing);
		const pencil = get("edit-file");
		pencil.hidden = !editing && !editable();
		pencil.title = editing ? "End editing" : "Edit file";
		pencil.setAttribute("aria-label", pencil.title);
		pressed(pencil, editing);
		renderCrumbs();
		get("file-title").textContent = basename(path) || root.name;
		renderFileMarkers();
		pressed(get("file-view"), view === "file");
		pressed(get("diff-view"), view === "changes");
		pressed(get("wrap-lines"), settings.wrap);
		const previewShown = !editing && wantsPreview() && (loadingFile || previewHTML !== undefined);
		get("wrap-lines").hidden = previewShown;
		const previewToggle = get("preview-mode");
		previewToggle.hidden = editing || !markdownFile();
		pressed(previewToggle, previewShown);
		const change = review?.files.find((item) => item.path === path);
		disabled("diff-view", !path || !change);
		disabled("copy-path", !path);
		disabled("ask-file", !selectionExcerpt(null));
		const section = get("main-scope");
		section.hidden = root.kind !== "git" || !(view === "changes" || settings.tab === "changes");
		if (!section.hidden) section.replaceChildren(makeScopeControl(false));
		renderFileFacts();
		renderDiffHeader(change);
		renderOutdated();
	}
	function renderOutdated() {
		const anchor = get("anchor-notice");
		anchor.replaceChildren();
		// A note outdated in the working tree is not outdated where the shown review still holds its quote.
		const old = activeNotes().filter((note) => note.location === "outdated" && !locateNote(note));
		anchor.hidden = editor.active() || !old.length;
		if (anchor.hidden) return;
		for (const note of old) {
			const display = button("", () => reviewUI.thread([note], null));
			display.append(
				el("strong", "", "Outdated note"),
				` · ${note.title || note.text.split("\n")[0]} · was L${note.anchor.start}`,
			);
			anchor.append(display);
		}
	}
	function useSplit() {
		if (settings.diff !== "auto") return settings.diff === "split";
		const counts = diff?.hunks.reduce(
			(total, hunk) => ({ base: total.base + hunk.baseCount, head: total.head + hunk.headCount }),
			{ base: 0, head: 0 },
		);
		return (
			isWide.matches &&
			!!counts &&
			Math.min(counts.base, counts.head) / Math.max(1, Math.max(counts.base, counts.head)) >= 0.12
		);
	}
	function renderImage(file: ExplorerFile, url: string) {
		const asset = el("div", "asset-view");
		const image = el("img");
		image.alt = basename(path);
		image.src = url;
		image.addEventListener("error", () => {
			if (asset.isConnected) empty("Image not available", "Explorer could not read this image.", "image");
		});
		asset.append(image, el("p", "", `${model.size(file.size)} · ${file.mediaType ?? "Image"}`));
		body.append(asset);
	}
	function renderDiffPlaceholder() {
		if (diff?.binary)
			return empty("Binary file changed", "A line-by-line comparison is not available for this file.", "binary");
		empty(
			"No text changes",
			diff?.truncated
				? "This comparison is larger than the available preview."
				: "The file has no line changes in this review.",
			"branch",
		);
	}
	function renderCodePlaceholder() {
		if (fileError)
			return empty(
				"File not available",
				fileError,
				"error",
				button("Try again", () => report(navigate({ path, view }, { replace: true })), "secondary"),
			);
		if (loadingFile)
			return empty(
				view === "changes" ? "Reading changes…" : "Reading file…",
				"Explorer is waiting for the local file.",
			);
		if (!path || file?.kind === "directory")
			return empty(
				path ? basename(path) : root.name,
				"Pick a file from the sidebar or use Quick open (cmd+P).",
				"folder",
				button("Quick open", () => command("quick"), "secondary"),
			);
		if (view === "changes") return renderDiffPlaceholder();
		renderFilePlaceholder();
	}
	function renderFilePlaceholder() {
		if (file?.kind === "image" && file.url) return renderImage(file, file.url);
		if (file?.kind === "binary")
			return empty("Binary file", `${model.size(file.size)} · ${file.mediaType ?? "Unknown type"}`, "binary");
		empty("File not found", "This path is not present in the selected version.", "error");
	}
	function showsCode() {
		if (!path || fileError || loadingFile) return false;
		if (view === "file") return file?.kind === "text";
		return !!diff && !diff.binary && diff.hunks.length > 0;
	}
	function markdownFile() {
		return view === "file" && app.markdown.isMarkdown(path) && (!file || file.kind === "text");
	}
	function wantsPreview() {
		return markdownFile() && settings.preview;
	}
	function restoreCodeView(saved?: ReturnType<ExplorerCodeView["place"]>) {
		if (saved) code.restore(saved);
		code.highlight(lineRange ?? reviewUI.range() ?? (code === preview ? null : targetRange));
		if (findQuery.value) computeFind(false);
		get("file-annotation").textContent = fileAnnotation();
	}
	function fileAnnotation() {
		if (wantsPreview() && previewHTML === undefined) return "Rendered preview unavailable · source shown";
		return file?.truncated || diff?.truncated ? "Large file · partial preview" : "";
	}
	function renderCode(saved?: ReturnType<ExplorerCodeView["place"]>) {
		if (editor.active()) {
			renderEditor();
			return;
		}
		renderReadingView(saved);
	}
	function renderEditor() {
		if (!body.querySelector(".edit-surface")) code.clear();
		editor.mount(settings, latestLine);
	}
	function renderReadingView(saved?: ReturnType<ExplorerCodeView["place"]>) {
		if (!showsCode()) {
			code.clear();
			renderCodePlaceholder();
			return;
		}
		const next = wantsPreview() && previewHTML !== undefined ? preview : source;
		if (code !== next) {
			code.clear();
			code = next;
			if (saved) saved = { ...saved, offset: 0, left: 0 };
		}
		body.setAttribute("aria-label", next === preview ? "Markdown preview" : "Source code");
		const options = codeOptions();
		if (next === preview) preview.show({ ...options, html: previewHTML });
		else source.show(options);
		restoreCodeView(saved);
	}
	function codeOptions(): ExplorerCodeOptions {
		return {
			path,
			base: baseLines,
			head: headLines,
			diff: view === "changes" ? diff : null,
			split: view === "changes" && useSplit(),
			wrap: settings.wrap,
			size: settings.textSize,
			notes: activeNotes(),
			onNote: openLineMarker,
			onRange: changeRange,
			onScroll: (line) => {
				if (line !== latestLine) {
					latestLine = line;
					renderLocation();
					if (!loadingFile) savePosition();
				}
				placeStrip();
				reviewUI.reposition();
			},
		};
	}
	type NavigationOptions = {
		replace?: boolean;
		keepSheet?: boolean;
		keepTab?: boolean;
		refresh?: boolean;
		side?: ExplorerSide;
		noHistory?: boolean;
		keepCard?: boolean;
	};
	function recordNavigation(target: ExplorerLaunch, replace?: boolean) {
		const nav = { path, view: target.view ?? view, line: target.line, review: scope };
		if (replace && historyAt >= 0) history[historyAt] = nav;
		else if (
			history[historyAt]?.path !== path ||
			history[historyAt]?.view !== nav.view ||
			!sameScope(history[historyAt]?.review, nav.review) ||
			target.line !== undefined
		) {
			history = history.slice(0, historyAt + 1);
			history.push(nav);
			historyAt = history.length - 1;
		}
	}
	function clearNavigationSelection(keepCard = false) {
		if (!keepCard) reviewUI.escape();
		window.getSelection()?.removeAllRanges();
		lineRange = null;
		placeStrip();
		closeFind();
	}
	function leavesView(
		target: ExplorerLaunch,
		options: NavigationOptions,
		candidatePath: string,
		requestedView: "file" | "changes",
	) {
		return path !== candidatePath || view !== requestedView || (!options.keepTab && target.view === "notes");
	}
	function prepareNavigation(
		target: ExplorerLaunch,
		options: NavigationOptions,
		candidatePath: string,
		requestedView: "file" | "changes",
	) {
		lineRange = null;
		targetRange = null;
		anchoredLine = null;
		if (historyAt >= 0 && !options.noHistory) history[historyAt].line = latestLine;
		if (leavesView(target, options, candidatePath, requestedView)) clearNavigationSelection(options.keepCard);
		if (!options.keepSheet) narrowClose();
		if (!options.keepTab && target.view) settings.tab = target.view === "file" ? "files" : target.view;
		path = candidatePath;
		view = requestedView;
		if (!options.noHistory) recordNavigation(target, options.replace);
		disabled("back", historyAt <= 0);
		disabled("forward", historyAt >= history.length - 1);
	}
	function showTargetLines(line: number, last: number | undefined, preferred?: ExplorerSide) {
		const side = preferred ?? (view === "changes" && !headLines.length ? "base" : "head");
		const maxLine = (side === "base" ? baseLines : headLines).length;
		if (!maxLine) return;
		const start = Math.min(line, maxLine);
		const end = Math.max(start, Math.min(last ?? start, maxLine));
		targetRange = { side, start, end };
		code.jump(end, side, true);
		code.jump(start, side, true);
		if (code !== preview) code.highlight(targetRange);
		setAnchorLine(start);
	}
	function showDirectory(keepSheet?: boolean) {
		void revealPath(path, true);
		if (isNarrow.matches && keepSheet) sheet = true;
		renderSidebarState();
	}
	async function followFileLink(link: Extract<ExplorerMarkdownLink, { kind: "file" }>) {
		const stamp = openStamp + 1;
		await navigate({ path: link.path, view: "file" });
		if (stamp === openStamp && code === preview && link.fragment) preview.fragment(link.fragment);
	}
	function followMarkdownLink(link: ExplorerMarkdownLink) {
		if (link.kind === "fragment") preview.fragment(link.fragment);
		else if (link.kind === "external") report(request("link.open", { url: link.url }));
		else report(followFileLink(link));
	}
	function readNavigation(change: boolean) {
		const selectedScope = scope;
		const at =
			change && review?.resolved.head && review.resolved.head !== "worktree" ? review.resolved.head : undefined;
		return Promise.all([
			!change && settings.preview && app.markdown.isMarkdown(path)
				? request("markdown.render", { path, at })
				: request("file.read", { path, at }).then((file) => ({ file, html: undefined })),
			change && selectedScope ? request("review.diff", { path, scope: selectedScope }) : Promise.resolve(null),
		]);
	}
	function clearFileData() {
		file = null;
		diff = null;
		previewHTML = undefined;
		headLines = [];
		baseLines = [];
	}
	function showRootDirectory() {
		file = null;
		diff = null;
		loadingFile = false;
		renderHeader();
		renderCode();
		savePosition();
	}
	function showFileLoading(line?: number) {
		loadingFile = true;
		get("file-annotation").textContent = "";
		latestLine = line ?? 1;
		renderHeader();
		renderCode();
	}
	function applyNavigation(next: ExplorerFile, patch: ExplorerDiff | null, change: boolean, keepSheet?: boolean) {
		file = next;
		diff = patch ?? null;
		headLines = model.lines(change ? diff?.head : next.text);
		baseLines = model.lines(diff?.base);
		if (next.kind === "directory") showDirectory(keepSheet);
	}
	function finishNavigation(
		target: ExplorerLaunch,
		options: NavigationOptions,
		previous: ReturnType<ExplorerCodeView["place"]>,
	) {
		loadingFile = false;
		if (!options.refresh && settings.tab === "files" && !filter && !activeTreeButton()) {
			const index = rowIndex(path);
			if (index >= 0) scrollTreeRow(index);
		}
		renderHeader();
		renderCode(options.refresh ? previous : undefined);
		if (!options.refresh && target.line !== undefined) showTargetLines(target.line, target.end, options.side);
		renderLocation();
		savePosition();
		reviewUI.refresh();
		reviewUI.reposition();
	}
	function prepareFileRead(refresh: boolean | undefined, line?: number) {
		if (!refresh) clearFileData();
		if (!path) {
			showRootDirectory();
			return false;
		}
		if (!refresh) showFileLoading(line);
		return true;
	}
	async function applyFileRead(stamp: number, keepSheet?: boolean) {
		const change = view === "changes";
		try {
			const [{ file: next, html }, patch] = await readNavigation(change);
			if (stamp !== openStamp) return;
			previewHTML = html;
			applyNavigation(next, patch, change, keepSheet);
		} catch (error) {
			if (stamp === openStamp) fileError = errorText(error);
		}
	}
	function loadEditDraft(stamp: number) {
		return request("edit.draft", { root: root.path, path }).catch((error) => {
			if (stamp === openStamp) notice(errorText(error));
			return undefined;
		});
	}
	async function navigationRead(stamp: number, options: NavigationOptions) {
		if (!options.refresh) await editor.flush();
		if (stamp !== openStamp) return;
		const draft = !options.refresh && view === "file" ? loadEditDraft(stamp) : undefined;
		await applyFileRead(stamp, options.keepSheet);
		return draft;
	}
	function navigationKeepsEditor(candidate: string, requested: typeof view) {
		return editor.active() && candidate === path && requested === view;
	}
	function revealOnNavigate(options: NavigationOptions) {
		if (!options.refresh && view === "file") return revealPath(path);
	}
	async function navigate(target: ExplorerLaunch, options: NavigationOptions = {}) {
		const candidatePath = target.path ?? path;
		const requestedView = target.view === "changes" ? "changes" : "file";
		if (navigationKeepsEditor(candidatePath, requestedView)) return true;
		editor.detach();
		const stamp = ++openStamp;
		const previous = code.place();
		if (!options.refresh) {
			const previousPath = path;
			prepareNavigation(target, options, candidatePath, requestedView);
			syncNavigationSidebar(previousPath);
		}
		fileError = "";
		if (!prepareFileRead(options.refresh, target.line)) return true;
		const reveal = revealOnNavigate(options);
		const result = await navigationRead(stamp, options);
		await reveal;
		if (stamp !== openStamp) return false;
		finishNavigation(target, options, previous);
		if (result?.draft) openEditor(result.draft);
		return true;
	}
	async function moveHistory(delta: number) {
		const next = historyAt + delta;
		if (!history[next]) return;
		history[historyAt].line = latestLine;
		historyAt = next;
		const target = history[next];
		const origin = openStamp;
		const intent = ++reviewIntent;
		if (target.review && !sameScope(target.review, scope)) {
			setScope(target.review);
			await refreshReview();
		}
		if (origin === openStamp && intent === reviewIntent) await navigate(target, { noHistory: true });
	}
	function setScope(next: ExplorerScope) {
		if (sameScope(next, scope)) return;
		scope = next;
		review = null;
		reviewError = "";
		viewed.clear();
		reviewStamp++;
	}
	async function selectScope(next: ExplorerScope, keepCard = false, confirmed?: ExplorerReview) {
		const origin = openStamp;
		const intent = ++reviewIntent;
		if (!keepCard) clearNavigationSelection();
		setScope(next);
		settings.tab = "changes";
		saveSettings();
		renderNotePresentation();
		await refreshReview(confirmed);
		if (origin !== openStamp || intent !== reviewIntent || !sameScope(next, scope)) return false;
		const candidate = currentChange() ?? review?.files[0];
		const opened = await navigate(
			{ path: candidate?.path ?? "", view: "changes" },
			{ keepSheet: true, keepTab: true, keepCard },
		);
		if (opened && reviewError) notice(reviewError);
		return opened && !!review;
	}
	// Leave the current review intact if a reference in a note does not resolve.
	async function followScope(next: ExplorerScope) {
		const origin = openStamp;
		const intent = ++reviewIntent;
		try {
			const result = await request("review.files", { scope: next });
			if (origin === openStamp && intent === reviewIntent) await selectScope(next, true, result);
		} catch (error) {
			if (origin === openStamp && intent === reviewIntent) notice(errorText(error));
		}
	}
	async function followTarget(target: ExplorerRichTarget, side: ExplorerSide | null) {
		if (target.kind === "url") {
			await request("link.open", { url: target.url });
			return;
		}
		if (target.kind === "commit") return followScope({ kind: "commit", commit: target.commit });
		if (target.kind === "range") return followScope({ kind: "range", base: target.base, head: target.head });
		await followFileTarget(target, side ?? undefined);
	}
	async function followFileTarget(
		target: Extract<ExplorerRichTarget, { kind: "file" | "lines" }>,
		side?: ExplorerSide,
	) {
		const change = noteChange(target.path, side);
		const lines = target.kind === "lines" ? target : undefined;
		const useDiff = !!change && (inReview() || side === "base");
		await navigate(
			{
				path: useDiff ? change.path : target.path,
				line: lines?.start,
				end: lines?.end,
				view: useDiff ? "changes" : "file",
			},
			{ keepTab: true, side: useDiff ? side : "head", keepCard: true },
		);
	}
	function noteChange(item: string, side?: ExplorerSide, preferred?: string) {
		const matches = (change: ExplorerChange) => changePath(change, side) === item;
		const preferredChange = review?.files.find((change) => change.path === (preferred ?? path) && matches(change));
		return preferredChange ?? review?.files.find(matches);
	}
	function locateNote(note: ExplorerLineNote): ExplorerRange | null {
		const { side } = note;
		if (!inReview() && (side === "base" || note.location === "outdated")) return null;
		const lines = side === "base" ? baseLines : headLines;
		const spots = note.location === "outdated" ? [note.anchor] : [note, note.anchor];
		const ranges = spots.map(({ start, end }) => ({ side, start, end }));
		return ranges.find((range) => range.end <= lines.length && quoteMatches(note, range)) ?? null;
	}
	function quoteMatches(note: ExplorerLineNote, range: ExplorerRange) {
		const shown = selectionExcerpt(range);
		return shown?.path === note.path && shown.quote === note.anchor.quote;
	}
	function openLineMarker(marked: ExplorerNote[]) {
		strip.hidden = true;
		reviewUI.thread(marked);
	}
	function alignNote(note: ExplorerLineNote) {
		const range = locateNote(note);
		targetRange = null;
		if (range) {
			code.jump(range.end, range.side, true);
			code.jump(range.start, range.side, true);
		}
		code.highlight(range);
		setAnchorLine(range?.start ?? null);
		return range;
	}
	function isReviewTargetHere(note: ExplorerNote, target: Exclude<ExplorerNoteTarget, { kind: "file" }>) {
		if (!inReview() || !review) return false;
		return target.kind === "review"
			? reviewTargets([note], review.resolved).length > 0
			: review.commits.some(({ commit }) => commit === target.commit);
	}
	async function navigateReviewNote(note: ExplorerNote, target: Exclude<ExplorerNoteTarget, { kind: "file" }>) {
		const next = target.kind === "review" ? target.review : { kind: "commit" as const, commit: target.commit };
		if (isReviewTargetHere(note, target) || (await selectScope(next, true))) return { range: null };
	}
	async function noteReviewReady(side?: ExplorerSide) {
		if (review || side !== "base" || root.kind !== "git") return true;
		const origin = openStamp;
		await refreshReview();
		return origin === openStamp;
	}
	async function navigateNoteFile(item: string, side: ExplorerSide | undefined, scoped: boolean, preferred?: string) {
		if (!(await noteReviewReady(side))) return false;
		const change = noteChange(item, side, preferred);
		const useDiff = !!change && (inReview() || side === "base" || scoped || !!preferred);
		const destination = useDiff ? change.path : item;
		const nextView = useDiff ? "changes" : "file";
		if (!loadingFile && destination === path && nextView === view) return true;
		return navigate({ path: destination, view: nextView }, { keepTab: true, keepCard: true, side });
	}
	async function navigateNote(
		note: ExplorerNote,
		preferred?: string,
	): Promise<{ range: ExplorerRange | null } | undefined> {
		if (!showsNote(note) || !atReview(note)) return;
		const target = note.target;
		if (target?.kind === "commit" || target?.kind === "review") return navigateReviewNote(note, target);
		const location = note.target === undefined ? note : target;
		if (!location) return;
		if (await navigateNoteFile(location.path, location.side, !!note.reviewKey, preferred))
			return { range: note.target === undefined ? alignNote(note) : null };
	}
	async function goNote(note: ExplorerNote) {
		return (await navigateNote(note))?.range ?? null;
	}
	async function openNote(marked: ExplorerNote[], preferred?: string) {
		const origin = rootStamp;
		const [first] = marked;
		const opened = first && (await navigateNote(first, preferred));
		if (!opened || origin !== rootStamp) return;
		const ids = new Set(marked.map(({ id }) => id));
		const fresh = notes.filter((note) => ids.has(note.id) && showsNote(note) && atReview(note));
		if (!fresh.length) return;
		if (sheet) narrowClose();
		reviewUI.thread(fresh, opened.range);
	}

	const findSlot = get("find-slot");
	const findQuery = el("input");
	findQuery.type = "search";
	findQuery.placeholder = "Find in file";
	findQuery.setAttribute("aria-label", "Find in file");
	const findResult = el("span", "find-count");
	findResult.setAttribute("aria-live", "polite");
	let matches: ExplorerMatch[] = [],
		hit = -1;
	const findBack = iconButton("up", "Previous match (shift+return)", () => stepFind(-1));
	const findNext = iconButton("down", "Next match (return)", () => stepFind(1));
	findSlot.append(
		findQuery,
		findResult,
		findBack,
		findNext,
		iconButton("close", "Close Find (Esc)", () => {
			closeFind();
			body.focus({ preventScroll: true });
		}),
	);
	function findInFile() {
		if (!headLines.length && !baseLines.length) return;
		findSlot.hidden = false;
		const selected = code.selection()?.text;
		if (selected && !selected.includes("\n")) {
			findQuery.value = selected;
			computeFind(false);
		}
		findQuery.focus({ preventScroll: true });
		findQuery.select();
	}
	function computeFind(jump: boolean) {
		matches = code === preview ? preview.find(findQuery.value) : model.find(headLines, findQuery.value, "head");
		if (view === "changes" && matches.length < 10000 && diff)
			matches.push(
				...model
					.find(baseLines, findQuery.value, "base", 10000 - matches.length)
					.filter((match) =>
						diff?.hunks.some((hunk) => hunk.baseStart <= match.line && match.line < hunk.baseStart + hunk.baseCount),
					),
			);
		if (code !== preview)
			matches.sort((a, b) => a.line - b.line || (a.side === b.side ? a.start - b.start : a.side === "base" ? -1 : 1));
		if (jump) {
			const first = matches.findIndex((match) => match.line >= latestLine);
			hit = first < 0 ? 0 : first;
		}
		hit = matches.length ? Math.min(Math.max(hit, 0), matches.length - 1) : -1;
		drawFind(jump);
	}
	function drawFind(jump: boolean) {
		findResult.textContent = !findQuery.value
			? ""
			: matches.length
				? `${hit + 1} of ${matches.length.toLocaleString()}${matches.length === 10000 ? "+" : ""}`
				: "No matches";
		findBack.disabled = findNext.disabled = !matches.length;
		const current = matches[hit];
		code.marks(matches, current);
		if (!current || !jump) return;
		if (code === preview) preview.focusMatch(current);
		else code.jump(current.line, current.side);
	}
	function stepFind(delta: number) {
		if (matches.length) {
			hit = (hit + delta + matches.length) % matches.length;
			drawFind(true);
		}
	}
	function closeFind() {
		if (findSlot.hidden) return;
		findSlot.hidden = true;
		findQuery.value = "";
		matches = [];
		hit = -1;
		code.marks([], undefined);
	}
	findQuery.oninput = () => computeFind(true);
	findQuery.onkeydown = (event) => {
		if (event.key === "Enter" && !event.isComposing) {
			event.preventDefault();
			stepFind(event.shiftKey ? -1 : 1);
		}
	};

	const strip = el("div", "selection-strip");
	strip.hidden = true;
	const stripAsk = button("Ask", () => askAt(activeRange(), "ask"));
	const stripComment = button("Comment", () => askAt(activeRange(), "comment"));
	const stripNote = button("Note", () => askAt(activeRange(), "note"));
	const stripCopy = button("Copy", () => {
		const range = activeRange();
		const text = code.selection()?.text ?? (range ? selectionExcerpt(range)?.quote : undefined);
		if (text) copy(text);
	});
	stripAsk.prepend(icon("ask"));
	stripComment.prepend(icon("note"));
	stripNote.prepend(icon("bookmark"));
	stripCopy.prepend(icon("copy"));
	strip.append(stripAsk, stripComment, stripNote, stripCopy);
	float.append(strip);
	strip.addEventListener("mousedown", (event) => event.preventDefault());
	function activeRange() {
		return code.selection()?.range ?? lineRange;
	}
	function renderLocation() {
		const line = anchoredLine ?? latestLine;
		get("location-status").textContent = path
			? headLines.length || baseLines.length
				? `Line ${line.toLocaleString()}`
				: basename(path)
			: "No file selected";
	}
	function setAnchorLine(line: number | null) {
		anchoredLine = line;
		renderLocation();
	}
	function changeRange(range: ExplorerRange | null) {
		lineRange = range;
		targetRange = null;
		setAnchorLine(range?.start ?? null);
		placeStrip();
	}
	function askAt(range: ExplorerRange | null, mode: "ask" | "comment" | "note") {
		strip.hidden = true;
		if (!selectionExcerpt(range)) return;
		reviewUI.ask(range, mode);
	}
	function placeStrip() {
		if (
			editor.active() ||
			sheet ||
			!menu.hidden ||
			!overlay.hidden ||
			document.querySelector(".float-card") ||
			!activeRange()
		) {
			strip.hidden = true;
			return;
		}
		const rect = code.selection()?.rect ?? code.anchor(lineRange);
		const safe = body.getBoundingClientRect();
		if (!rect || rect.bottom < safe.top || rect.top > safe.bottom) {
			strip.hidden = true;
			return;
		}
		strip.hidden = false;
		const left = Math.min(
			safe.right - strip.offsetWidth - 6,
			Math.max(safe.left + 6, rect.x + (rect.width - strip.offsetWidth) * 0.5),
		);
		const top =
			rect.top - strip.offsetHeight - 5 < safe.top
				? Math.min(rect.bottom + 5, safe.bottom - strip.offsetHeight)
				: rect.top - strip.offsetHeight - 5;
		strip.style.left = `${left}px`;
		strip.style.top = `${top}px`;
	}
	document.addEventListener("selectionchange", () => {
		const selection = code.selection();
		if (selection) setAnchorLine(selection.range.start);
		placeStrip();
	});
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (event.button === 0 && !event.ctrlKey && targetRange) {
				targetRange = null;
				setAnchorLine(null);
				code.highlight(lineRange);
			}
		},
		true,
	);
	body.addEventListener("pointerdown", (event) => {
		if (event.button !== 0 || event.ctrlKey || (event.target instanceof Element && event.target.closest("button")))
			return;
		lineRange = null;
		setAnchorLine(reviewUI.range()?.start ?? null);
		code.highlight(reviewUI.range());
		strip.hidden = true;
	});

	function copy(text: string, feedback = "Copied") {
		report(request("clipboard.write", { text }).then(() => notice(feedback)));
	}
	function lineReference(range: ExplorerRange) {
		return `${path}:${range.start}${range.end === range.start ? "" : `–${range.end}`}`;
	}
	function togglePreview() {
		if (!markdownFile()) return;
		settings.preview = !settings.preview;
		saveSettings();
		if (settings.preview || fileError) report(navigate({ path, view }, { refresh: true }));
		else {
			const saved = code.place();
			renderHeader();
			renderCode(saved);
		}
	}
	function toggleWrap() {
		if (code === preview) return;
		const saved = code.place();
		settings.wrap = !settings.wrap;
		saveSettings();
		renderHeader();
		renderCode(saved);
	}
	function toggleView() {
		if (!path || !review?.files.some((item) => item.path === path)) return;
		report(navigate({ path, view: view === "file" ? "changes" : "file", line: latestLine }, { keepTab: true }));
	}
	type Action = { label: string; key: string; glyph: string; run: () => void; disabled?: boolean; divide?: boolean };
	function appendCodeActions(result: Action[]) {
		if (!headLines.length && !baseLines.length) return;
		result.push(
			{ label: "Find in file", key: "cmd+F", glyph: "search", divide: true, run: findInFile },
			{ label: "Go to line", key: "control+G", glyph: "list", run: () => command("line") },
		);
		if (review?.files.some((item) => item.path === path))
			result.push({
				label: view === "file" ? "Show changes" : "Show file",
				key: "cmd+option+D",
				glyph: "branch",
				run: toggleView,
			});
		if (code !== preview)
			result.push({
				label: settings.wrap ? "Turn wrap off" : "Wrap lines",
				key: "option+Z",
				glyph: "file",
				run: toggleWrap,
			});
	}
	function appendReviewActions(
		result: Action[],
		range: ExplorerRange | null,
		source: ExplorerExcerpt | null,
		fileHere: boolean,
	) {
		const marked = range ? notesOn(range) : [];
		if (marked.length)
			result.push({
				label: openLabel(marked),
				key: "",
				glyph: marked.some((note) => note.state === "draft") ? "note" : "bookmark",
				run: () => openLineMarker(marked),
			});
		if (fileHere)
			result.push({
				label: "Ask about this",
				key: "cmd+D",
				glyph: "ask",
				divide: result.length > 0,
				run: () => askAt(range, "ask"),
			});
		if (source)
			result.push(
				{ label: "Add review comment", key: "cmd+shift+L", glyph: "note", run: () => askAt(range, "comment") },
				{ label: "Add note", key: "cmd+option+N", glyph: "bookmark", run: () => askAt(range, "note") },
			);
	}
	// Text fields keep the usual editing actions; review actions apply to code, not to typed text.
	function textField(target: EventTarget | null) {
		if (target instanceof HTMLTextAreaElement) return target;
		if (target instanceof HTMLInputElement && ["text", "search", "url", "email", ""].includes(target.type))
			return target;
		return null;
	}
	function editorActions(input: HTMLTextAreaElement | HTMLInputElement, text?: string): Action[] {
		return [
			{
				label: "Cut",
				key: "cmd+X",
				glyph: "copy",
				disabled: !text || input.readOnly,
				run: () => {
					const selected = text ?? "";
					const start = input.selectionStart ?? 0,
						end = input.selectionEnd ?? 0;
					report(
						request("clipboard.write", { text: selected }).then(() => {
							if (
								document.activeElement !== input ||
								input.selectionStart !== start ||
								input.selectionEnd !== end ||
								input.value.slice(start, end) !== selected
							)
								return;
							document.execCommand("delete");
						}),
					);
				},
			},
			{
				label: "Copy",
				key: "cmd+C",
				glyph: "copy",
				disabled: !text,
				run: () => {
					if (text) copy(text);
				},
			},
			{
				label: "Paste",
				key: "cmd+V",
				glyph: "copy",
				disabled: input.readOnly,
				run: () => {
					const start = input.selectionStart,
						end = input.selectionEnd;
					report(
						request("clipboard.read").then(({ text: value }) => {
							if (document.activeElement === input && input.selectionStart === start && input.selectionEnd === end)
								document.execCommand("insertText", false, value);
						}),
					);
				},
			},
			{
				label: "Select All",
				key: "cmd+A",
				glyph: "list",
				disabled: !input.value,
				divide: true,
				run: () => {
					input.focus({ preventScroll: true });
					input.select();
				},
			},
		];
	}
	function actions(range: ExplorerRange | null, text?: string): Action[] {
		const source = range ? selectionExcerpt(range) : null;
		const fileHere = !!selectionExcerpt(null);
		const result: Action[] = [];
		appendReviewActions(result, range, source, fileHere);
		result.push(
			{
				label: "Copy",
				key: "cmd+C",
				glyph: "copy",
				disabled: !text,
				divide: result.length > 0,
				run: () => {
					if (text) copy(text);
				},
			},
			{
				label: "Copy with source",
				key: "cmd+shift+C",
				glyph: "copy",
				disabled: !source,
				run: () => {
					if (source) copy(model.source(source), "Copied with source");
				},
			},
		);
		if (path)
			result.push({ label: "Copy path", key: "cmd+option+C", glyph: "file", run: () => copy(path, "Path copied") });
		if (range)
			result.push({
				label: "Copy line reference",
				key: "cmd+option+L",
				glyph: "list",
				run: () => copy(lineReference(range), "Line reference copied"),
			});
		if (path)
			result.push({
				label: "Reveal in Finder",
				key: "cmd+option+R",
				glyph: "folder",
				run: () => report(request("finder.reveal", { path })),
			});
		if (editable() && !editor.active())
			result.push({ label: "Edit file", key: "", glyph: "edit", divide: true, run: toggleEditor });
		if (!editor.active()) appendCodeActions(result);
		return result;
	}
	const menu = el("div", "context-menu");
	menu.hidden = true;
	menu.tabIndex = -1;
	menu.setAttribute("role", "menu");
	menu.setAttribute("aria-label", "Explorer actions");
	float.append(menu);
	let menuFocus: HTMLElement | null = null,
		menuActive = 0;
	function closeMenu(restore = true) {
		menu.hidden = true;
		if (restore) menuFocus?.focus({ preventScroll: true });
	}
	function showMenu(x: number, y: number, range: ExplorerRange | null, items: Action[]) {
		menuFocus = document.activeElement as HTMLElement | null;
		const layer = overlay.hidden ? float : overlay;
		if (menu.parentElement !== layer) layer.append(menu);
		if (range) setAnchorLine(range.start);
		menu.replaceChildren();
		strip.hidden = true;
		for (const action of items) {
			const node = button(
				"",
				() => {
					closeMenu();
					action.run();
				},
				"menu-item",
			);
			node.append(icon(action.glyph), el("span", "", action.label), el("kbd", "", action.key));
			node.setAttribute("role", "menuitem");
			node.disabled = !!action.disabled;
			node.tabIndex = -1;
			if (action.divide) node.classList.add("menu-divider");
			menu.append(node);
		}
		menu.hidden = false;
		menu.style.left = `${Math.max(6, Math.min(x, innerWidth - menu.offsetWidth - 7))}px`;
		menu.style.top = `${Math.max(6, Math.min(y, innerHeight - menu.offsetHeight - 7))}px`;
		menuActive = 0;
		(menu.querySelector<HTMLElement>("button:not(:disabled)") ?? menu).focus({ preventScroll: true });
	}
	function selectionAt(
		selection: NonNullable<ReturnType<ExplorerCodeView["selection"]>>,
		clicked: ExplorerRange | null,
		x: number,
		y: number,
	) {
		const { range, rect } = selection;
		if (clicked && range.side === clicked.side && clicked.start >= range.start && clicked.end <= range.end) return true;
		return rect.x <= x && x <= rect.right && rect.y <= y && y <= rect.bottom;
	}
	function menuText(target: EventTarget | null, selected: string | undefined, range: ExplorerRange | null) {
		if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)
			return target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
		return selected ?? (range && lineRange === range ? selectionExcerpt(range)?.quote : undefined);
	}
	function menuActions(target: EventTarget | null, text: string | undefined, range: ExplorerRange | null) {
		const folder = target instanceof Element && target.closest<HTMLElement>("[aria-expanded][data-path]");
		const folderPath = folder && list.contains(folder) ? folder.dataset.path : undefined;
		if (folderPath)
			return [
				{ label: "Open as Root", key: "", glyph: "promote-root", run: () => openRelativeRoot(folderPath) },
				{ label: "New file…", key: "", glyph: "new-file", run: () => command("new-file", folderPath) },
			];
		const field = textField(target);
		if (field) return editorActions(field, text);
		return actions(range, text);
	}
	document.addEventListener(
		"contextmenu",
		(event) => {
			event.preventDefault();
			if (!overlay.hidden) {
				const field = textField(event.target);
				if (!field || !overlay.contains(field)) return;
				closeMenu(false);
				showMenu(event.clientX, event.clientY, null, editorActions(field, menuText(field, undefined, null)));
				return;
			}
			const selection = code.selection();
			const clicked = code.rowAt(event.target instanceof Node ? event.target : null);
			const chosen = selection && selectionAt(selection, clicked, event.clientX, event.clientY) ? selection : null;
			const range = chosen?.range ?? clicked ?? (body.contains(event.target as Node) ? lineRange : null);
			const text = menuText(event.target, chosen?.text, range);
			closeMenu(false);
			showMenu(event.clientX, event.clientY, range, menuActions(event.target, text, range));
		},
		true,
	);
	document.addEventListener(
		"pointerdown",
		(event) => {
			if (!menu.hidden && event.target instanceof Node && !menu.contains(event.target)) closeMenu(false);
		},
		true,
	);
	menu.addEventListener("keydown", (event) => {
		const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
		if (event.key === "Escape" || event.key === "Tab") {
			event.preventDefault();
			event.stopPropagation();
			closeMenu();
			placeStrip();
		} else if (items.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
			event.preventDefault();
			const active = items.indexOf(document.activeElement as HTMLButtonElement);
			menuActive = (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
			items[menuActive].focus();
		}
	});

	let commandStamp = 0,
		searchTimer = 0,
		quickTimer = 0;
	function closeCommand() {
		commandStamp++;
		clearTimeout(searchTimer);
		clearTimeout(quickTimer);
		quickTimer = 0;
		updateQuickOpen = undefined;
		mode = null;
		overlay.hidden = true;
		overlay.replaceChildren();
		previousFocus?.focus({ preventScroll: true });
		previousFocus = null;
		placeStrip();
	}
	function arrowStep(key: string) {
		if (key === "ArrowDown") return 1;
		return key === "ArrowUp" ? -1 : 0;
	}
	function commandPlaceholder(next: NonNullable<typeof mode>, detail?: string) {
		if (next === "quick") return "Type any part of a path";
		if (next === "search") return "Find text across this repository";
		if (next === "line") return "Line number";
		return detail === "range" ? "Base and head, for example main..HEAD" : "Commit or ref, for example HEAD~2";
	}
	async function openNewFile(destination: string) {
		closeCommand();
		filterInput.value = filter = "";
		await navigate({ path: destination, view: "file" });
		if (path === destination && editable() && !editor.active()) openEditor();
	}
	async function validateNewFile(destination: string) {
		if (!app.editing.validNewPath(destination))
			throw new Error("Enter a relative text file path without empty components, parent references or .git.");
		if (editedPaths.size >= 32 && !editedPaths.has(destination))
			throw new Error("Save or discard one of your 32 edited files first.");
		if (
			indexedPaths.some((entry) => entry.path === destination) &&
			(await request("file.read", { path: destination })).kind !== "missing"
		)
			throw new Error("That path already exists.");
	}
	async function createInRoot(destination: string, dialog: HTMLElement, origin: number) {
		await validateNewFile(destination);
		if (!dialog.isConnected || origin !== rootStamp) return;
		await request("file.create", { root: root.path, path: destination });
		if (origin !== rootStamp) return;
		tree.invalidate([destination]);
		indexVersion++;
		if (dialog.isConnected) await openNewFile(destination);
	}
	function newFileCommand(dialog: HTMLElement, folder: string) {
		const input = el("input");
		input.id = "quick-input";
		input.setAttribute("aria-label", "New file path");
		input.placeholder = "Path relative to this folder's root";
		input.value = folder ? `${folder}/` : "";
		input.autocomplete = "off";
		input.spellcheck = false;
		const summary = el("div", "command-summary", "Enter a relative path for a new text file.");
		summary.setAttribute("role", "status");
		const controls = el("div", "card-actions");
		const origin = rootStamp;
		const create = button("Create file", () => report(submit()), "primary");
		async function submit() {
			if (create.disabled) return;
			const destination = input.value;
			create.disabled = input.disabled = true;
			try {
				await createInRoot(destination, dialog, origin);
			} catch (error) {
				if (dialog.isConnected) summary.textContent = errorText(error);
				else if (origin === rootStamp) notice(errorText(error));
			} finally {
				create.disabled = input.disabled = false;
			}
		}
		controls.append(button("Cancel", closeCommand, "quiet"), create);
		dialog.append(input, summary, controls);
		dialog.onkeydown = (event) => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeCommand();
			} else if (event.key === "Enter" && event.target === input) {
				event.preventDefault();
				report(submit());
			}
		};
		overlay.replaceChildren(dialog);
		overlay.hidden = false;
		input.focus({ preventScroll: true });
		input.setSelectionRange(input.value.length, input.value.length);
	}
	function quickCaption(items: number) {
		if (indexPending && !index) return "Indexing paths…";
		if (!items) return indexError || (index?.truncated ? "No matching paths · Partial index" : "No matching paths.");
		let qualifier = "";
		if (indexPending) qualifier = " · Updating index…";
		else if (index?.truncated) qualifier = " · Partial index";
		return `${indexedPaths.length.toLocaleString()} indexed paths${qualifier} · ↑ ↓ to move · return to open`;
	}
	function queueQuickQuery(query: () => void) {
		clearTimeout(quickTimer);
		quickTimer = window.setTimeout(() => {
			quickTimer = 0;
			query();
		}, pathQueryDelay);
	}
	function flushQuickQuery(query: () => void) {
		if (!quickTimer) return;
		clearTimeout(quickTimer);
		quickTimer = 0;
		query();
	}
	function appendCommandActions(dialog: HTMLElement, next: NonNullable<typeof mode>, submit: () => void) {
		if (next !== "line" && next !== "scope") return;
		const controls = el("div", "card-actions");
		controls.append(
			button("Cancel", closeCommand, "quiet"),
			button(next === "line" ? "Go to line" : "Open review", submit, "primary"),
		);
		dialog.append(controls);
	}
	function openQuickIndex(next: NonNullable<typeof mode>, update: () => void) {
		if (next !== "quick") return;
		updateQuickOpen = update;
		void ensureIndex();
	}
	function command(next: NonNullable<typeof mode>, detail?: string) {
		clearTimeout(searchTimer);
		commandStamp++;
		mode = next;
		previousFocus ??= document.activeElement as HTMLElement | null;
		strip.hidden = true;
		closeMenu(false);
		const dialog = el("section", "dialog command");
		dialog.setAttribute("role", "dialog");
		dialog.setAttribute("aria-modal", "true");
		const titles = {
			quick: "Quick open",
			search: "Search repository",
			line: "Go to line",
			"new-file": "New file",
			scope: detail === "range" ? "Choose a commit range" : "Choose a commit",
		};
		dialog.setAttribute("aria-label", titles[next]);
		const header = el("header");
		header.append(el("strong", "", titles[next]), iconButton("close", "Close (Esc)", closeCommand));
		dialog.append(header);
		if (next === "new-file") return newFileCommand(dialog, detail ?? "");
		const input = el("input");
		input.id = "quick-input";
		input.setAttribute("aria-label", titles[next]);
		input.autocomplete = "off";
		input.spellcheck = false;
		input.placeholder = commandPlaceholder(next, detail);
		if (next === "line") input.inputMode = "numeric";
		dialog.append(input);
		const summary = el("div", "command-summary");
		summary.setAttribute("role", "status");
		const results = el("div", "command-results");
		let picked = 0;
		let entries: { title: string; hint: string; path: string; line?: number }[] = [];
		function openPicked(index: number) {
			if (!entries[index]) return;
			const item = entries[index];
			closeCommand();
			report(navigate({ path: item.path, line: item.line, view: "file" }));
		}
		function selectPicked(index: number) {
			picked = Math.max(0, Math.min(entries.length - 1, index));
			for (const [row, node] of [...results.children].entries()) node.classList.toggle("picked", row === picked);
			results.children[picked]?.scrollIntoView({ block: "nearest" });
		}
		function showResult(items: typeof entries, caption: string) {
			entries = items;
			picked = 0;
			results.replaceChildren();
			summary.textContent = caption;
			for (const [index, item] of entries.entries()) {
				const node = button("", () => openPicked(index), "command-result");
				const title = el("strong", "", item.title);
				const subtitle = el("small", "", item.hint);
				node.append(title, subtitle);
				node.classList.toggle("picked", index === picked);
				results.append(node);
			}
		}
		const flags = el("div", "search-options");
		function flag(text: string) {
			const label = el("label");
			const field = el("input");
			field.type = "checkbox";
			label.append(field, text);
			flags.append(label);
			return field;
		}
		const regex = flag("Regular expression"),
			sensitive = flag("Match case");
		function queryPaths(value: string, preservePick = false) {
			const current = preservePick ? entries[picked]?.path : undefined;
			const items = model.fuzzy(indexedPaths, value).map(({ path }) => ({
				title: basename(path),
				hint: dirname(path) || root.name,
				path,
			}));
			showResult(items, quickCaption(items.length));
			const selected = items.findIndex((item) => item.path === current);
			if (selected > 0) selectPicked(selected);
		}
		function showSearchResult(data: ExplorerRequests["search"][1]) {
			showResult(
				data.results.map((item) => ({
					title: `${item.path}:${item.line}`,
					hint: item.preview,
					path: item.path,
					line: item.line,
				})),
				data.results.length
					? `${data.results.length.toLocaleString()} results${data.truncated ? " · list truncated" : ""} · return to open`
					: "No matches.",
			);
		}
		function queryContents(value: string, stamp: number) {
			if (!value) {
				showResult([], "Search file contents in the opened root.");
				return;
			}
			showResult([], "Searching…");
			searchTimer = window.setTimeout(() => {
				void request("search", { query: value, regex: regex.checked, caseSensitive: sensitive.checked, limit: 2000 })
					.then((data) => {
						if (commandStamp === stamp) showSearchResult(data);
					})
					.catch((error) => {
						if (commandStamp === stamp) showResult([], errorText(error));
					});
			}, 140);
		}
		function query() {
			const value = input.value.trim();
			const stamp = ++commandStamp;
			clearTimeout(searchTimer);
			if (next === "quick") queryPaths(value);
			else if (next === "search") queryContents(value, stamp);
		}
		function submitLine() {
			const line = Number(input.value.trim());
			const side = activeRange()?.side ?? (headLines.length ? "head" : "base");
			const total = side === "head" ? headLines.length : baseLines.length;
			if (!Number.isSafeInteger(line) || line < 1 || line > total) {
				summary.textContent = `Enter a line from 1 to ${total.toLocaleString()}.`;
				return;
			}
			closeCommand();
			if (code === preview) togglePreview();
			code.jump(line, side, true);
			changeRange({ side, start: line, end: line });
			code.highlight(lineRange);
			body.focus({ preventScroll: true });
		}
		function submitScope() {
			const value = input.value.trim();
			const pair = /^(.+?)\.\.([^.].*)$/.exec(value);
			if (!value || (detail === "range" && !pair)) {
				summary.textContent = detail === "range" ? "Enter a range such as main..HEAD." : "Enter a commit or ref.";
				return;
			}
			closeCommand();
			report(
				selectScope(
					detail === "range" && pair
						? { kind: "range", base: pair[1], head: pair[2] }
						: { kind: "commit", commit: value },
				),
			);
		}
		function submit() {
			if (next === "line") submitLine();
			else if (next === "scope") submitScope();
			else openPicked(picked);
		}
		input.oninput = next === "quick" ? () => queueQuickQuery(query) : query;
		regex.onchange = sensitive.onchange = query;
		dialog.onkeydown = (event) => {
			if (event.isComposing) return;
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				closeCommand();
				return;
			}
			if (event.target === input && event.key === "Enter") {
				event.preventDefault();
				flushQuickQuery(query);
				submit();
				return;
			}
			if (arrowStep(event.key) !== 0) {
				event.preventDefault();
				selectPicked(picked + arrowStep(event.key));
			}
		};
		if (next === "search") dialog.append(flags);
		dialog.append(summary, results);
		appendCommandActions(dialog, next, submit);
		overlay.replaceChildren(dialog);
		overlay.hidden = false;
		input.focus({ preventScroll: true });
		openQuickIndex(next, () => queryPaths(input.value.trim(), true));
		query();
	}
	overlay.onclick = (event) => {
		if (event.target === overlay) closeCommand();
	};

	function restoreLaunchDraft(target: ExplorerLaunch, candidate: string | undefined, stamp: number) {
		if (!editor.active() && target.draft && candidate === path && stamp === rootStamp) {
			targetRange = null;
			const sourcePath = target.draft.range?.side === "base" ? (diff?.oldPath ?? path) : path;
			reviewUI.restore(sourcePath, target.draft);
		}
	}
	async function openPath(target: ExplorerLaunch, requested: ExplorerLaunch["view"], stamp: number) {
		const candidate = target.path ?? (requested === "changes" ? review?.files[0]?.path : "");
		const anchor = target.draft?.range;
		const opened = await navigate(
			{
				...target,
				path: candidate ?? "",
				view: requested,
				line: anchor?.start ?? target.line,
				end: anchor?.end ?? target.end,
			},
			{ keepTab: !requested, keepSheet: true, side: anchor?.side },
		);
		if (opened) restoreLaunchDraft(target, candidate, stamp);
	}
	function launchNoteFile(note: ExplorerNote, requested: ExplorerLaunch["view"]) {
		if (requested !== "changes") return;
		const location = note.target ?? note;
		if ("path" in location) return noteChange(location.path, location.side)?.path;
	}
	async function openLaunchNote(id: string, requested: ExplorerLaunch["view"]) {
		const note = notes.find((item) => item.id === id && showsNote(item) && atReview(item));
		if (!note) {
			notice("That note is not available.");
			return false;
		}
		const destination = launchNoteFile(note, requested);
		if (destination) settings.tab = "changes";
		await openNote([note], destination);
		return true;
	}
	function requestedLaunchView(target: ExplorerLaunch) {
		return target.view ?? (target.review ? "changes" : undefined);
	}
	async function prepareLaunchReview(target: ExplorerLaunch, requested: ExplorerLaunch["view"]) {
		if (target.review) setScope(target.review);
		if (root.kind === "git" && (requested === "changes" || target.review)) await refreshReview();
	}
	async function open(target: ExplorerLaunch) {
		const stamp = ++launchStamp;
		const origin = rootStamp;
		const navOrigin = openStamp;
		const current = () => stamp === launchStamp && origin === rootStamp && navOrigin === openStamp;
		const requested = requestedLaunchView(target);
		await prepareLaunchReview(target, requested);
		if (!current()) return;
		if (target.note) {
			await refreshNotes();
			if (!current() || (await openLaunchNote(target.note, requested))) return;
		}
		if (current()) await openPath(target, requested, origin);
	}
	function resetRoot(next: ExplorerRoot) {
		editor.detach();
		editedPaths.clear();
		clearTimeout(stateTimer);
		closeCommand();
		closeMenu(false);
		closeFind();
		reviewUI.escape();
		reviewUI.escape();
		openStamp++;
		reviewStamp++;
		notesStamp++;
		rootStamp++;
		root = next;
		scope = undefined;
		scopes = [];
		review = null;
		notes = [];
		latestNotes = undefined;
		commitsExpanded = false;
		index = undefined;
		indexedPaths = [];
		indexPending = undefined;
		clearTimeout(indexRefreshTimer);
		indexRefreshTimer = 0;
		indexBuilt = { at: 0, took: 0 };
		indexVersion = 0;
		loadedIndexVersion = -1;
		indexError = "";
		tree.reset();
		focusPath = undefined;
		focusIndex = -1;
		queuedFileChanges = undefined;
		clearTimeout(fileChangeTimer);
		fileChangeTimer = undefined;
		viewed.clear();
		path = "";
		lineRange = null;
		file = null;
		diff = null;
		baseLines = [];
		headLines = [];
		fileError = "";
		reviewError = "";
		notesError = "";
		sentReviews.clear();
		targetRange = null;
		anchoredLine = null;
		history = [];
		historyAt = -1;
		clearTimeout(filterTimer);
		filter = filterInput.value = "";
		filteredRows = undefined;
		list.scrollTop = 0;
		code.clear();
		rootChrome();
		renderSidebar();
		reviewUI.refresh();
		report(refreshEditedPaths());
		report(loadRootListing());
		report(refreshNotes());
		report(refreshScopes());
	}
	function hostOpen(event: Extract<ExplorerEvent, { type: "open" }>) {
		if (!booted) {
			pendingOpen = event;
			return;
		}
		if (event.root) base = event.base;
		if (event.root && root.path !== event.root.path) resetRoot(event.root);
		else if (event.root) {
			root = event.root;
			rootChrome();
		}
		if (event.root) rootTrail();
		report(open(event));
	}
	type FileChanges = Extract<ExplorerEvent, { type: "files.changed" }>;
	type QueuedFileChanges = {
		paths: Set<string> | null;
		structural: Set<string>;
		review: boolean;
		head?: FileChanges["head"];
	};
	let queuedFileChanges: QueuedFileChanges | undefined;
	let fileChangeTimer: number | undefined;
	let refreshingFileChanges = false;
	function scheduleFileChanges() {
		if (!queuedFileChanges || refreshingFileChanges || fileChangeTimer !== undefined) return;
		fileChangeTimer = window.setTimeout(() => {
			fileChangeTimer = undefined;
			report(flushFileChanges());
		}, 500);
	}
	function collectPaths(pending: QueuedFileChanges, paths: string[], structural: string[]) {
		if (!pending.paths) return;
		for (const item of paths) {
			pending.paths.add(item);
			if (pending.paths.size > 512) break;
		}
		if (!paths.length || pending.paths.size > 512) {
			pending.paths = null;
			pending.structural.clear();
		} else {
			for (const item of structural) pending.structural.add(item);
		}
	}
	function filesChanged(event: FileChanges) {
		queuedFileChanges ??= { paths: new Set<string>(), structural: new Set<string>(), review: false };
		const pending = queuedFileChanges;
		if (event.head) pending.head = event.head;
		const outside = new Set(event.outside);
		pending.review ||= !event.paths.length || event.paths.some((path) => !outside.has(path));
		collectPaths(pending, event.paths, event.structural ?? []);
		if (!event.paths.length || event.structural?.length) indexVersion++;
		scheduleFileChanges();
	}
	async function flushFileChanges() {
		const event = queuedFileChanges;
		if (!event) return;
		queuedFileChanges = undefined;
		refreshingFileChanges = true;
		try {
			await applyFileChanges(event);
		} finally {
			refreshingFileChanges = false;
			scheduleFileChanges();
		}
	}
	function checkEditedPath(changed: string[]) {
		if (editor.active() && (!changed.length || changed.some((item) => item === path || path.startsWith(`${item}/`))))
			report(editor.checkDisk());
	}
	function updateHead(head: FileChanges["head"]) {
		if (!head) return false;
		const changed = root.head !== head.head;
		root = { ...root, ...head, onDefaultBranch: !!head.branch && head.branch === root.defaultBranch };
		rootChrome();
		return changed;
	}
	function affectsWorkingDiff(refreshGit: boolean) {
		return refreshGit && view === "changes" && scope?.kind === "uncommitted";
	}
	async function applyFileChanges(event: QueuedFileChanges) {
		const changed = event.paths ? [...event.paths] : [];
		checkEditedPath(changed);
		tree.invalidate(event.paths ? event.structural : null);
		if (indexInUse() && loadedIndexVersion !== indexVersion) scheduleIndexRefresh();
		const headChanged = updateHead(event.head);
		const relevant = (candidate: string) =>
			changed.some((item) => item === candidate || candidate.startsWith(`${item}/`));
		const refreshThread =
			headChanged || !event.paths || notes.some((note) => note.target === undefined && relevant(note.path));
		const refreshGit = root.kind === "git" && event.review;
		const refreshFile = headChanged || !event.paths || relevant(path) || affectsWorkingDiff(refreshGit);
		await Promise.all([
			refreshThread ? refreshNotes() : undefined,
			refreshChangedView(openStamp, refreshGit, !!path && refreshFile),
		]);
	}
	async function refreshChangedView(stamp: number, refreshGit: boolean, refreshFile: boolean) {
		if (refreshGit) {
			const origin = rootStamp;
			await refreshScopes();
			if (origin !== rootStamp) return;
			if (view === "changes" || review) await refreshReview();
		}
		if (stamp !== openStamp || !refreshFile || loadingFile || editor.active()) return;
		await navigate({ path, view }, { refresh: true });
	}
	// A Git index change can add or remove indexed paths without a file event.
	function indexChanged() {
		indexVersion++;
		if (indexInUse()) scheduleIndexRefresh();
	}
	app.listen((event) => {
		switch (event.type) {
			case "open":
				hostOpen(event);
				break;
			case "notes.changed":
				if (booted) report(refreshNotes());
				break;
			case "zoom":
				zoomChanged(event.zoom);
				break;
			case "index.changed":
				if (booted) indexChanged();
				break;
			case "live":
				live = event;
				if (booted) liveChrome();
				break;
			case "promptState":
				reviewUI.prompt(event);
				break;
			case "files.changed":
				if (booted) filesChanged(event);
				break;
		}
	});
	function takeDeferredOpen() {
		const deferred = pendingOpen;
		pendingOpen = undefined;
		booted = true;
		if (!deferred?.root) return deferred;
		base = deferred.base;
		if (deferred.root.path !== root.path) resetRoot(deferred.root);
		else root = deferred.root;
		rootTrail();
		rootChrome();
		return deferred;
	}
	async function boot() {
		try {
			const result = await request("hello");
			root = result.root;
			base = result.base;
			rootTrail();
			settings = result.settings;
			live = result.live;
			settings.textSize = Number.isFinite(settings.textSize) ? Math.max(10, Math.min(32, settings.textSize)) : 16;
			settings.sidebar.width = Math.max(215, Math.min(430, settings.sidebar.width));
			settings.zoom = Number.isFinite(settings.zoom) ? settings.zoom : 1;
			renderZoom();
			updateNarrow();
			rootChrome();
			liveChrome();
			renderSidebarState();
			renderSidebar();
			const initial = Promise.all([
				loadRootListing(),
				refreshNotes(),
				refreshScopes(),
				refreshEditedPaths().catch((error) => notice(errorText(error))),
			]);
			const deferred = takeDeferredOpen();
			const launch = launchStamp;
			await initial;
			if (launch === launchStamp) await open(deferred ?? result.launch);
			if (root.kind === "git" && !review) report(refreshReview());
		} catch (error) {
			empty(
				"Explorer did not open",
				errorText(error),
				"error",
				button("Try again", () => report(boot()), "secondary"),
			);
		} finally {
			document.documentElement.dataset.ready = "true";
		}
	}

	const click = (id: string, action: () => void, glyphName?: string) => {
		const node = get(id);
		if (glyphName) glyph(node, glyphName);
		node.onclick = action;
	};
	click("sidebar-toggle", toggleSidebar, "sidebar");
	click("sheet-shade", narrowClose);
	click("back", () => report(moveHistory(-1)), "back");
	click("forward", () => report(moveHistory(1)), "forward");
	click("quick-open", () => command("quick"));
	click("zoom-level", () => report(request("zoom", { step: "reset" })));
	click("search", () => command("search"), "search");
	click("wrap-lines", toggleWrap);
	click("preview-mode", togglePreview);
	click("edit-file", toggleEditor, "edit");
	click(
		"copy-path",
		() => {
			if (path) copy(path, "Path copied");
		},
		"copy",
	);
	click("ask-file", () => askAt(null, "ask"), "ask");
	click("file-view", () => {
		if (view !== "file") toggleView();
	});
	click("diff-view", () => {
		if (view !== "changes") toggleView();
	});
	for (const tab of get("note-tabs").querySelectorAll<HTMLButtonElement>("[data-tab]"))
		tab.onclick = () => report(setTab(tab.dataset.tab as ExplorerTab, true));
	const resize = get("resize");
	function resizeSidebar(width: number) {
		settings.sidebar.width = Math.round(Math.max(215, Math.min(430, Math.min(innerWidth - 330, width))));
		renderSidebarState();
	}
	resize.addEventListener("pointerdown", (event) => {
		resize.setPointerCapture(event.pointerId);
		resizeSidebar(event.clientX);
	});
	resize.addEventListener("pointermove", (event) => {
		if (resize.hasPointerCapture(event.pointerId)) resizeSidebar(event.clientX);
	});
	resize.addEventListener("lostpointercapture", saveSettings);
	resize.addEventListener("keydown", (event) => {
		if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
			event.preventDefault();
			resizeSidebar(settings.sidebar.width + (event.key === "ArrowLeft" ? -12 : 12));
			saveSettings();
		}
	});
	sidebar.addEventListener("keydown", (event) => {
		if ((event.key !== "ArrowDown" && event.key !== "ArrowUp") || event.target instanceof HTMLSelectElement) return;
		const items = [...list.querySelectorAll<HTMLElement>("button[data-path]")];
		if (!items.length) return;
		const index = items.indexOf(document.activeElement as HTMLElement);
		const next =
			index < 0
				? event.key === "ArrowDown"
					? 0
					: items.length - 1
				: Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
		event.preventDefault();
		items[next].focus();
	});
	isWide.addEventListener("change", () => {
		if (view === "changes" && settings.diff === "auto") renderCode(code.place());
	});
	window.addEventListener("resize", () => {
		updateNarrow();
		placeStrip();
		reviewUI.reposition();
	});
	updateNarrow();
	window.addEventListener("pagehide", () => {
		if (booted) {
			void editor.flush();
			savePosition(true);
		}
	});

	function returnFocus() {
		window.getSelection()?.removeAllRanges();
		changeRange(null);
		code.highlight(null);
		report(request("focus.return"));
	}
	function escapeExplorer() {
		if (mode) return closeCommand();
		if (reviewUI.escape()) return placeStrip();
		if (!findSlot.hidden) {
			closeFind();
			body.focus({ preventScroll: true });
			return;
		}
		if (sheet) return narrowClose();
		returnFocus();
	}
	function navigationShortcut(event: KeyboardEvent, key: string, editing: boolean) {
		switch (key) {
			case "p":
				return event.altKey ? undefined : () => command("quick");
			case "f":
				return event.shiftKey ? () => command("search") : findInFile;
			case "[":
				return () => report(moveHistory(-1));
			case "]":
				return () => report(moveHistory(1));
			case "b":
				return editing ? undefined : toggleSidebar;
		}
	}
	function noteShortcut(event: KeyboardEvent, key: string, range: ExplorerRange | null, editing: boolean) {
		if (event.code === "KeyD" && !event.altKey && !event.shiftKey && !editing) return () => askAt(range, "ask");
		if (range) return rangeShortcut(event, key, range);
	}
	function rangeShortcut(event: KeyboardEvent, key: string, range: ExplorerRange) {
		if (event.shiftKey && key === "l") return () => askAt(range, "comment");
		if (!event.altKey) return;
		if (event.code === "KeyN") return () => askAt(range, "note");
		if (event.code === "KeyL") return () => copy(lineReference(range), "Line reference copied");
	}
	function fileShortcut(event: KeyboardEvent) {
		if (!event.altKey) return;
		if (event.code === "KeyR" && path) return () => report(request("finder.reveal", { path }));
		if (event.code === "KeyD") return toggleView;
		if (event.code === "KeyC" && path) return () => copy(path, "Path copied");
	}
	function copyShortcut(event: KeyboardEvent, key: string, editing: boolean, range: ExplorerRange | null) {
		if (key !== "c" || editing) return;
		const source = range && selectionExcerpt(range);
		const text = event.shiftKey
			? source
				? model.source(source)
				: undefined
			: (code.selection()?.text ?? source?.quote);
		if (text) return () => copy(text);
	}
	// The Edit menu's Undo, Redo and Select All belong to text fields. Elsewhere the page has nothing to
	// undo, and selecting the whole page would take in the sidebar and controls, so these keys do nothing.
	function fieldShortcut(event: KeyboardEvent, key: string, editing: boolean) {
		if (editing || event.altKey || (key !== "a" && key !== "z")) return;
		return () => {};
	}
	function metaShortcut(event: KeyboardEvent, key: string, editing: boolean, range: ExplorerRange | null) {
		if (!event.metaKey || event.ctrlKey) return;
		return (
			navigationShortcut(event, key, editing) ??
			noteShortcut(event, key, range, editing) ??
			fileShortcut(event) ??
			copyShortcut(event, key, editing, range) ??
			fieldShortcut(event, key, editing)
		);
	}
	function secondaryShortcut(event: KeyboardEvent, key: string, editing: boolean) {
		if (event.ctrlKey && key === "g" && (headLines.length || baseLines.length)) return () => command("line");
		if (event.altKey && !event.metaKey && event.code === "KeyZ" && !editing) return toggleWrap;
	}
	function stepNotes(key: string) {
		if (key === "arrowleft") return reviewUI.step(-1);
		if (key === "arrowright") return reviewUI.step(1);
		return false;
	}
	function isEditing(target: EventTarget | null) {
		return target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true]");
	}
	function editorShortcut(event: KeyboardEvent, key: string) {
		if (!editor.active()) return false;
		if (event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && key === "s") {
			event.preventDefault();
			report(editor.save());
			return true;
		}
		return (event.metaKey && !event.shiftKey && key === "f") || (event.ctrlKey && key === "g");
	}
	document.addEventListener("keydown", (event) => {
		if (event.isComposing || event.defaultPrevented || !menu.hidden) return;
		const key = event.key.toLowerCase();
		const editing = isEditing(event.target);
		const range = activeRange();
		if (key === "escape") {
			event.preventDefault();
			escapeExplorer();
			return;
		}
		if (mode || editorShortcut(event, key)) return;
		const action = metaShortcut(event, key, editing, range) ?? secondaryShortcut(event, key, editing);
		if (action) {
			event.preventDefault();
			action();
			return;
		}
		if (!editing && !event.metaKey && !event.ctrlKey && !event.altKey && stepNotes(key)) event.preventDefault();
	});
	void boot();
})();
