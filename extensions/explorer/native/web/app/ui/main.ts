(() => {
	const app = window.explorer;
	const { el, get, icon, button, glyph, iconButton } = app.dom;
	const { request, model } = app;
	const shell = get("app"),
		body = get("view-body"),
		sidebar = get("sidebar"),
		list = get("sidebar-list"),
		heading = get("sidebar-heading");
	const float = get("floating"),
		overlay = get("overlay"),
		status = get("notice");
	const isNarrow = matchMedia("(max-width: 759px)"),
		isWide = matchMedia("(min-width: 1200px)");
	const code = app.code(body);
	let root: ExplorerRoot = {
		path: "",
		name: "Repository",
		kind: "folder",
		branch: null,
		head: null,
		defaultBranch: null,
		onDefaultBranch: false,
	};
	let settings: ExplorerSettings = {
		textSize: 16,
		wrap: false,
		diff: "auto",
		sidebar: { width: 245, open: true },
		tab: "files",
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
		await Promise.all(draftWrites);
	};
	let notes: ExplorerNote[] = [],
		tours: ExplorerTour[] = [];
	let paths: string[] = [],
		filesError = "",
		treeTruncated = false,
		filter = "";
	let path = "",
		view: "file" | "changes" = "file",
		file: ExplorerFile | null = null,
		diff: ExplorerDiff | null = null;
	let fileError = "",
		loadingFile = false;
	let headLines: string[] = [],
		baseLines: string[] = [];
	let sheet = false,
		openStamp = 0,
		reviewStamp = 0,
		notesStamp = 0,
		filesStamp = 0,
		rootStamp = 0;
	let lineRange: ExplorerRange | null = null,
		latestLine = 1;
	let history: (ExplorerLaunch & { path: string })[] = [],
		historyAt = -1;
	let stateTimer = 0,
		noticeTimer = 0;
	let mode: "quick" | "search" | "line" | "scope" | null = null;
	let previousFocus: HTMLElement | null = null;
	let pendingOpen: ({ type: "open"; root?: ExplorerRoot } & ExplorerLaunch) | undefined;
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
	const activeNotes = () => notes.filter((note) => note.path === path);
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
		drafts: () => notes.filter((note) => note.state === "draft"),
		notes: () => notes,
		excerpt: selectionExcerpt,
		bounds: code.anchor,
		highlight: code.highlight,
		go: async (note) => {
			await goNote(note, false);
		},
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
			const fields = draft && draftPath === path ? { view, line: anchoredLine ?? latestLine, review: scope } : {};
			const write = request("state.save", { ...fields, path: draftPath, draft }).then(() => {});
			draftWrites.add(write);
			void write.then(
				() => draftWrites.delete(write),
				() => draftWrites.delete(write),
			);
			return write;
		},
		notice,
	});
	function excerptCommit(side?: ExplorerSide) {
		if (view !== "changes") return null;
		if (side === "base") return review?.resolved.base ?? null;
		const head = review?.resolved.head;
		return head === "worktree" ? null : (head ?? null);
	}
	function selectionExcerpt(range: ExplorerRange | null): ExplorerExcerpt | null {
		if (!path || !file || file.kind === "directory" || (file.kind === "missing" && !diff)) return null;
		const lines = range?.side === "base" ? baseLines : headLines;
		const commit = excerptCommit(range?.side);
		if (!range) return { path, commit, text: "" };
		const start = Math.max(1, range.start),
			end = Math.min(lines.length, range.end);
		if (end < start) return null;
		return { path, start, end, quote: lines.slice(start - 1, end).join("\n"), commit, text: "" };
	}
	function liveChrome() {
		const node = get("connection");
		node.textContent = live.connected ? "Agent connected" : "Local notes only";
		node.title = live.connected ? (live.label ?? "Connected") : (live.reason ?? "No live conversation");
		sidebar.classList.toggle("disconnected", !live.connected);
		reviewUI.refresh();
	}
	function rootChrome() {
		get("repo-name").textContent = root.name;
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

	type Tree = { folders: Map<string, Tree>; files: string[] };
	let tree: Tree = { folders: new Map(), files: [] };
	const folders = new Set<string>();
	function makeTree() {
		tree = { folders: new Map(), files: [] };
		for (const item of paths) {
			let at = tree;
			for (const part of item.split("/").slice(0, -1)) {
				let child = at.folders.get(part);
				if (!child) {
					child = { folders: new Map(), files: [] };
					at.folders.set(part, child);
				}
				at = child;
			}
			at.files.push(item);
		}
	}
	function revealPath(value: string, self = false) {
		const pieces = (self ? value : dirname(value)).split("/");
		for (let index = 1; index <= pieces.length; index++) folders.add(pieces.slice(0, index).join("/"));
	}
	function fileRowIcon(item: string, language: ReturnType<typeof model.language>, folder?: boolean) {
		if (folder) return icon(folders.has(item) || filter ? "open" : "folder");
		if (!language.mark) return icon("file");
		return el("span", `language-mark lang-${language.id}`, language.mark);
	}
	function fileRow(item: string, depth: number, folder?: boolean) {
		const node = button(
			"",
			() => {
				if (folder) {
					if (folders.has(item)) folders.delete(item);
					else folders.add(item);
					renderSidebar(item);
				} else report(navigate({ path: item, view: "file" }));
			},
			"list-row",
		);
		const language = model.language(item);
		node.style.setProperty("--depth", String(depth));
		node.dataset.path = item;
		if (folder) node.setAttribute("aria-expanded", String(folders.has(item) || !!filter));
		else if (item === path && view === "file") node.setAttribute("aria-current", "true");
		node.append(fileRowIcon(item, language, folder), el("span", "row-title", basename(item)));
		return node;
	}
	let treeLimit = 1500;
	function renderTree() {
		if (filesError) {
			list.append(
				el("p", "empty-list", filesError),
				button("Try again", () => report(refreshFiles()), "quiet"),
			);
			return;
		}
		const output = document.createDocumentFragment();
		let remaining = treeLimit;
		function emitFiles(files: string[], depth: number) {
			for (const item of files) {
				if (remaining-- <= 0) return;
				output.append(fileRow(item, depth));
			}
		}
		function emit(branch: Tree, prefix = "", depth = 0) {
			for (const [name, child] of branch.folders.entries()) {
				if (remaining-- <= 0) return;
				const key = prefix + name;
				output.append(fileRow(key, depth, true));
				if (folders.has(key)) emit(child, `${key}/`, depth + 1);
			}
			emitFiles(branch.files, depth);
		}
		if (filter) for (const { path: item } of model.fuzzy(paths, filter, 250)) output.append(fileRow(item, 0));
		else emit(tree);
		if (!output.childNodes.length)
			output.append(el("p", "empty-list", filter ? "No paths match this filter." : "No files to show."));
		if (remaining <= 0)
			output.append(
				button(
					"Show more paths",
					() => {
						treeLimit += 1500;
						renderSidebar();
					},
					"quiet",
				),
			);
		if (treeTruncated) output.append(el("p", "empty-list", "The host listed only the first paths."));
		list.append(output);
	}
	const filterLabel = el("label", "filter");
	const filterInput = el("input");
	filterInput.type = "search";
	filterInput.placeholder = "Filter files";
	filterInput.setAttribute("aria-label", "Filter files");
	filterInput.addEventListener("input", () => {
		filter = filterInput.value;
		list.replaceChildren();
		renderTree();
	});
	filterLabel.append(icon("search"), filterInput);

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
	function changeRow(item: ExplorerChange) {
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
		const check = viewedButton(item);
		row.append(open, check);
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
	function commitList(entries: ExplorerReview["commits"]) {
		const details = el("details");
		details.append(el("summary", "", `${entries.length} commit${entries.length === 1 ? "" : "s"} in this range`));
		const commits = el("ol");
		for (const commit of entries) {
			const item = el("li");
			item.append(el("code", "", commit.short), ` ${commit.subject}`);
			commits.append(item);
		}
		details.append(commits);
		return details;
	}
	function renderChangedFiles() {
		if (review?.files.length) list.append(el("div", "list-label", "CHANGED FILES"));
		for (const item of review?.files ?? []) {
			list.append(changeRow(item));
		}
		if (review && !review.files.length) list.append(el("p", "empty-list", "No files changed in this scope."));
	}
	function renderChanges() {
		if (root.kind !== "git") {
			list.append(el("p", "empty-list", "Changes are available in Git repositories."));
			return;
		}
		const summary = el("div", "range-box");
		const kicker = el("div", "range-kicker", "REVIEW RANGE");
		kicker.prepend(icon("branch"));
		summary.append(kicker, makeScopeControl(true));
		appendReviewSummary(summary);
		for (const tour of tours) {
			const entry = button("", () => report(startTour(tour)), "tour-launch");
			entry.append(
				icon("tour"),
				el("span", "", tours.length === 1 ? "Walkthrough" : tour.title),
				el("small", "", `${tour.stops.length} stops`),
			);
			summary.append(entry);
		}
		if (review?.commits.length) summary.append(commitList(review.commits));
		heading.append(summary);
		renderChangedFiles();
	}
	function noteLocation(note: ExplorerNote) {
		if (note.location === "outdated") return `Outdated · was L${note.anchor.start}`;
		if (note.location === "moved") return `L${note.start} · moved from L${note.movedFrom ?? note.anchor.start}`;
		return `L${note.start}`;
	}
	function noteRow(note: ExplorerNote) {
		const row = el("div", "note-list-row");
		const open = button("", () => report(goNote(note)), "note-open");
		open.dataset.path = note.id;
		const kind = el("span", `note-kind ${note.author}`);
		kind.append(icon(note.author === "agent" ? "ask" : "note"));
		const preview = el("span", "note-preview");
		const loc = noteLocation(note);
		preview.append(
			el("strong", "", note.title || note.text.split("\n")[0]),
			el(
				"small",
				note.location === "moved" ? "moved-fact" : "",
				`${loc} · ${note.author === "agent" ? "Agent" : "You"} · ${note.state}`,
			),
		);
		open.append(kind, preview);
		row.append(open);
		return row;
	}
	function renderNotes() {
		const intro = el("div", "notes-heading");
		intro.append(
			el("strong", "", "Repository notes"),
			el("p", "", "Notes follow their quoted lines across worktrees."),
		);
		heading.append(intro);
		if (notesError) {
			list.append(
				el("p", "empty-list", notesError),
				button("Try again", () => report(refreshNotes()), "quiet"),
			);
			return;
		}
		if (!notes.length) {
			list.append(el("p", "empty-list", "No notes yet. Select a line to keep a note."));
			return;
		}
		const grouped = new Map<string, ExplorerNote[]>();
		for (const note of notes) {
			const items = grouped.get(note.path) ?? [];
			items.push(note);
			grouped.set(note.path, items);
		}
		for (const [item, entries] of grouped) {
			const group = el("section", "note-group");
			const header = el("header");
			header.append(el("strong", "", basename(item)), el("small", "", dirname(item) || root.name));
			group.append(header);
			for (const note of entries) group.append(noteRow(note));
			list.append(group);
		}
	}
	function prepareSidebarHeading() {
		if (settings.tab === "files") {
			if (!heading.contains(filterLabel)) heading.replaceChildren(filterLabel);
		} else heading.replaceChildren();
	}
	function focusedPath(active: HTMLElement | null) {
		return active && list.contains(active) ? active.dataset.path : undefined;
	}
	function renderSidebar(refocus?: string) {
		const active = document.activeElement as HTMLElement | null;
		const key = refocus ?? focusedPath(active);
		const scroll = list.scrollTop;
		prepareSidebarHeading();
		list.replaceChildren();
		const tabs = get("note-tabs");
		for (const tab of tabs.querySelectorAll<HTMLElement>("[data-tab]")) pressed(tab, tab.dataset.tab === settings.tab);
		get("change-count").textContent = review ? String(review.files.length) : "";
		get("note-count").textContent = notes.length ? String(notes.length) : "";
		if (settings.tab === "files") renderTree();
		else if (settings.tab === "changes") renderChanges();
		else renderNotes();
		if (key)
			[...list.querySelectorAll<HTMLElement>("[data-path]")]
				.find((item) => item.dataset.path === key)
				?.focus({ preventScroll: true });
		list.scrollTop = scroll;
	}
	async function setTab(tab: ExplorerTab, switchView = false) {
		settings.tab = tab;
		renderSidebar();
		saveSettings();
		savePosition();
		if (tab === "changes" && root.kind === "git") {
			if (!review) await refreshReview();
			if (switchView && review?.files.length && view !== "changes")
				await navigate(
					{ path: review.files.find((item) => item.path === path)?.path ?? review.files[0].path, view: "changes" },
					{ keepSheet: true, keepTab: true },
				);
			else renderHeader();
		}
	}
	async function refreshFiles() {
		const stamp = ++filesStamp;
		try {
			const data = await request("files.list");
			if (stamp !== filesStamp) return;
			paths = [...data.paths].sort((a, b) => a.localeCompare(b));
			treeTruncated = data.truncated;
			filesError = "";
			makeTree();
		} catch (error) {
			if (stamp === filesStamp) filesError = errorText(error);
		}
		if (stamp === filesStamp && settings.tab === "files") renderSidebar();
	}
	async function refreshNotes() {
		const stamp = ++notesStamp;
		try {
			const result = await request("notes.list");
			if (stamp !== notesStamp) return;
			notes = result.notes;
			tours = result.tours;
			notesError = "";
		} catch (error) {
			if (stamp === notesStamp) notesError = errorText(error);
		}
		if (stamp !== notesStamp) return;
		renderSidebar();
		renderOutdated();
		code.updateNotes(activeNotes());
		reviewUI.refresh();
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
	async function refreshReview() {
		if (!scope) await refreshScopes();
		if (!scope || root.kind !== "git") return;
		const stamp = ++reviewStamp;
		const requested = scope;
		try {
			const result = await request("review.files", { scope: requested });
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
		renderSidebar();
		renderHeader();
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
		if (file.kind === "text") pieces.push(model.language(path).label);
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
	function renderHeader() {
		renderCrumbs();
		get("file-title").textContent = basename(path) || root.name;
		pressed(get("file-view"), view === "file");
		pressed(get("diff-view"), view === "changes");
		pressed(get("wrap-lines"), settings.wrap);
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
		const old = activeNotes().filter((note) => note.location === "outdated");
		anchor.hidden = !old.length;
		for (const note of old) {
			const display = button("", () => reviewUI.thread([note]));
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
				"Pick a file from the sidebar or use Quick open (⌘P).",
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
	function restoreCodeView(saved?: ReturnType<ExplorerCodeView["place"]>) {
		if (saved) code.restore(saved);
		if (lineRange || targetRange) code.highlight(lineRange ?? targetRange);
		if (findQuery.value) computeFind(false);
		if (file?.truncated || diff?.truncated) get("file-annotation").textContent = "Large file · partial preview";
	}
	function renderCode(saved?: ReturnType<ExplorerCodeView["place"]>) {
		if (!showsCode()) {
			code.clear();
			renderCodePlaceholder();
			return;
		}
		code.show({
			path,
			base: baseLines,
			head: headLines,
			diff: view === "changes" ? diff : null,
			split: view === "changes" && useSplit(),
			wrap: settings.wrap,
			size: settings.textSize,
			notes: activeNotes(),
			onNote: reviewUI.thread,
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
		});
		restoreCodeView(saved);
	}
	type NavigationOptions = {
		replace?: boolean;
		keepSheet?: boolean;
		keepTab?: boolean;
		refresh?: boolean;
		side?: ExplorerSide;
		noHistory?: boolean;
	};
	function recordNavigation(target: ExplorerLaunch, replace?: boolean) {
		const nav = { path, view: target.view ?? view, line: target.line, review: scope };
		if (replace && historyAt >= 0) history[historyAt] = nav;
		else if (history[historyAt]?.path !== path || history[historyAt]?.view !== nav.view || target.line !== undefined) {
			history = history.slice(0, historyAt + 1);
			history.push(nav);
			historyAt = history.length - 1;
		}
	}
	function clearNavigationSelection() {
		if (!keepCardOnNavigate) reviewUI.escape();
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
		if (leavesView(target, options, candidatePath, requestedView)) clearNavigationSelection();
		if (!options.keepSheet) narrowClose();
		if (!options.keepTab && target.view) settings.tab = target.view === "file" ? "files" : target.view;
		revealPath(candidatePath);
		path = candidatePath;
		view = requestedView;
		if (!options.noHistory) recordNavigation(target, options.replace);
		disabled("back", historyAt <= 0);
		disabled("forward", historyAt >= history.length - 1);
		renderSidebar();
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
		code.highlight(targetRange);
		setAnchorLine(start);
	}
	function showDirectory(keepSheet?: boolean) {
		revealPath(path, true);
		if (isNarrow.matches && keepSheet) sheet = true;
		renderSidebarState();
	}
	function readNavigation(change: boolean) {
		const selectedScope = scope;
		const at =
			change && review?.resolved.head && review.resolved.head !== "worktree" ? review.resolved.head : undefined;
		return Promise.all([
			request("file.read", { path, ...(at ? { at } : {}) }),
			change && selectedScope ? request("review.diff", { path, scope: selectedScope }) : Promise.resolve(null),
		]);
	}
	function clearFileData() {
		file = null;
		diff = null;
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
		renderSidebar();
		renderHeader();
		renderCode(options.refresh ? previous : undefined);
		if (!options.refresh && target.line !== undefined) showTargetLines(target.line, target.end, options.side);
		renderLocation();
		savePosition();
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
	async function navigate(target: ExplorerLaunch, options: NavigationOptions = {}) {
		const stamp = ++openStamp;
		const candidatePath = target.path ?? path;
		const requestedView = target.view === "changes" ? "changes" : "file";
		const previous = code.place();
		if (!options.refresh) prepareNavigation(target, options, candidatePath, requestedView);
		fileError = "";
		if (!prepareFileRead(options.refresh, target.line)) return;
		try {
			const change = view === "changes";
			const [next, patch] = await readNavigation(change);
			if (stamp !== openStamp) return;
			applyNavigation(next, patch, change, options.keepSheet);
		} catch (error) {
			if (stamp !== openStamp) return;
			fileError = errorText(error);
		}
		finishNavigation(target, options, previous);
	}
	async function moveHistory(delta: number) {
		const next = historyAt + delta;
		if (!history[next]) return;
		history[historyAt].line = latestLine;
		historyAt = next;
		const target = history[next];
		if (target.review && !sameScope(target.review, scope)) {
			scope = target.review;
			await refreshReview();
		}
		await navigate(target, { noHistory: true });
	}
	async function selectScope(next: ExplorerScope) {
		scope = next;
		reviewError = "";
		settings.tab = "changes";
		saveSettings();
		await refreshReview();
		if (!sameScope(next, scope)) return;
		const candidate = review?.files.find((item) => item.path === path) ?? review?.files[0];
		await navigate({ path: candidate?.path ?? "", view: "changes" }, { keepSheet: true, keepTab: true });
		if (reviewError) notice(reviewError);
	}
	let keepCardOnNavigate = false;
	async function goNote(note: ExplorerNote, show = true) {
		if (note.side === "base" && !review && root.kind === "git") await refreshReview();
		const change = review?.files.some((item) => item.path === note.path);
		const useDiff = !!change && (note.side === "base" || view === "changes");
		const side = note.side;
		keepCardOnNavigate = !show;
		try {
			await navigate(
				{ path: note.path, line: note.start, view: useDiff ? "changes" : "file" },
				{ keepTab: true, side },
			);
			if (show && side === "head" && useDiff && !locateNote(note))
				await navigate({ path: note.path, line: note.start, view: "file" }, { keepTab: true });
		} finally {
			keepCardOnNavigate = false;
		}
		const range = locateNote(note);
		if (range) {
			code.jump(range.start, range.side, true);
			code.jump(range.end, range.side, true);
			code.jump(range.start, range.side, true);
			code.highlight(range);
			setAnchorLine(range.start);
		} else {
			targetRange = null;
			code.highlight(null);
		}
		if (show) reviewUI.thread([note], range);
	}
	function locateNote(note: ExplorerNote): ExplorerRange | null {
		if (path !== note.path) return null;
		for (const spot of [{ start: note.start, end: note.end }, note.anchor]) {
			const range = { ...spot, side: note.side };
			if (selectionExcerpt(range)?.quote === note.anchor.quote) return range;
		}
		return null;
	}
	async function startTour(tour: ExplorerTour) {
		if (tour.scope && !sameScope(tour.scope, scope)) {
			scope = tour.scope;
			settings.tab = "changes";
			await refreshReview();
		}
		await reviewUI.tour(tour);
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
	const findBack = iconButton("up", "Previous match (⇧↩)", () => stepFind(-1));
	const findNext = iconButton("down", "Next match (↩)", () => stepFind(1));
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
		matches = model.find(headLines, findQuery.value, "head");
		if (view === "changes" && matches.length < 10000 && diff)
			matches.push(
				...model
					.find(baseLines, findQuery.value, "base", 10000 - matches.length)
					.filter((match) =>
						diff?.hunks.some((hunk) => hunk.baseStart <= match.line && match.line < hunk.baseStart + hunk.baseCount),
					),
			);
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
		if (current && jump) code.jump(current.line, current.side);
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
	const stripCopy = button("Copy", () => {
		const range = activeRange();
		const text = code.selection()?.text ?? (range ? selectionExcerpt(range)?.quote : undefined);
		if (text) copy(text);
	});
	stripAsk.prepend(icon("ask"));
	stripComment.prepend(icon("note"));
	stripCopy.prepend(icon("copy"));
	strip.append(stripAsk, stripComment, stripCopy);
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
		if (sheet || !menu.hidden || !overlay.hidden || document.querySelector(".float-card") || !activeRange()) {
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
		setAnchorLine(null);
		code.highlight(null);
		strip.hidden = true;
	});

	function copy(text: string, feedback = "Copied") {
		report(request("clipboard.write", { text }).then(() => notice(feedback)));
	}
	function lineReference(range: ExplorerRange) {
		return `${path}:${range.start}${range.end === range.start ? "" : `–${range.end}`}`;
	}
	function toggleWrap() {
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
		if (headLines.length || baseLines.length) {
			result.push(
				{ label: "Find in file", key: "⌘F", glyph: "search", divide: true, run: findInFile },
				{ label: "Go to line", key: "⌃G", glyph: "list", run: () => command("line") },
			);
			if (review?.files.some((item) => item.path === path))
				result.push({
					label: view === "file" ? "Show changes" : "Show file",
					key: "⌘⌥D",
					glyph: "branch",
					run: toggleView,
				});
			result.push({ label: settings.wrap ? "Turn wrap off" : "Wrap lines", key: "⌥Z", glyph: "file", run: toggleWrap });
		}
	}
	function appendReviewActions(
		result: Action[],
		range: ExplorerRange | null,
		source: ExplorerExcerpt | null,
		fileHere: boolean,
	) {
		if (fileHere)
			result.push({
				label: "Ask about this",
				key: range ? "⌘⇧M" : "⌘⌥M",
				glyph: "ask",
				run: () => askAt(range, "ask"),
			});
		if (source)
			result.push(
				{ label: "Comment on line(s)", key: "⌘⇧L", glyph: "note", run: () => askAt(range, "comment") },
				{ label: "Keep a note", key: "⌘⌥N", glyph: "edit", run: () => askAt(range, "note") },
			);
	}
	function actions(range: ExplorerRange | null, text?: string): Action[] {
		const source = range ? selectionExcerpt(range) : null;
		const fileHere = !!selectionExcerpt(null);
		const result: Action[] = [];
		appendReviewActions(result, range, source, fileHere);
		result.push(
			{
				label: "Copy",
				key: "⌘C",
				glyph: "copy",
				disabled: !text,
				divide: result.length > 0,
				run: () => {
					if (text) copy(text);
				},
			},
			{
				label: "Copy with source",
				key: "⌘⇧C",
				glyph: "copy",
				disabled: !source,
				run: () => {
					if (source) copy(model.source(source), "Copied with source");
				},
			},
		);
		if (path) result.push({ label: "Copy path", key: "⌘⌥C", glyph: "file", run: () => copy(path, "Path copied") });
		if (range)
			result.push({
				label: "Copy line reference",
				key: "⌘⌥L",
				glyph: "list",
				run: () => copy(lineReference(range), "Line reference copied"),
			});
		if (path)
			result.push({
				label: "Reveal in Finder",
				key: "⌘⌥R",
				glyph: "folder",
				run: () => report(request("finder.reveal", { path })),
			});
		appendCodeActions(result);
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
	function showMenu(x: number, y: number, range: ExplorerRange | null, text?: string) {
		menuFocus = document.activeElement as HTMLElement | null;
		if (range) setAnchorLine(range.start);
		menu.replaceChildren();
		strip.hidden = true;
		for (const action of actions(range, text)) {
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
	document.addEventListener(
		"contextmenu",
		(event) => {
			event.preventDefault();
			if (!overlay.hidden) return;
			const selection = code.selection();
			const clicked = code.rowAt(event.target instanceof Node ? event.target : null);
			const chosen = selection && selectionAt(selection, clicked, event.clientX, event.clientY) ? selection : null;
			const range = chosen?.range ?? clicked ?? (body.contains(event.target as Node) ? lineRange : null);
			const text = menuText(event.target, chosen?.text, range);
			closeMenu(false);
			showMenu(event.clientX, event.clientY, range, text);
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
		searchTimer = 0;
	function closeCommand() {
		commandStamp++;
		clearTimeout(searchTimer);
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
			scope: detail === "range" ? "Choose a commit range" : "Choose a commit",
		};
		dialog.setAttribute("aria-label", titles[next]);
		const header = el("header");
		header.append(el("strong", "", titles[next]), iconButton("close", "Close (Esc)", closeCommand));
		dialog.append(header);
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
		function queryPaths(value: string) {
			showResult(
				model
					.fuzzy(paths, value)
					.map(({ path }) => ({ title: basename(path), hint: dirname(path) || root.name, path })),
				value ? `${paths.length.toLocaleString()} indexed paths · ↑ ↓ to move · ↩ to open` : "↑ ↓ to move · ↩ to open",
			);
			if (!entries.length) summary.textContent = filesError || "No matching paths.";
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
					? `${data.results.length.toLocaleString()} results${data.truncated ? " · list truncated" : ""} · ↩ to open`
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
		input.oninput = query;
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
		if (next === "line" || next === "scope") {
			const controls = el("div", "card-actions");
			controls.append(
				button("Cancel", closeCommand, "quiet"),
				button(next === "line" ? "Go to line" : "Open review", submit, "primary"),
			);
			dialog.append(controls);
		}
		overlay.replaceChildren(dialog);
		overlay.hidden = false;
		input.focus({ preventScroll: true });
		query();
	}
	overlay.onclick = (event) => {
		if (event.target === overlay) closeCommand();
	};

	function restoreLaunchDraft(target: ExplorerLaunch, candidate: string | undefined, stamp: number) {
		if (target.draft && candidate === path && stamp === rootStamp) {
			targetRange = null;
			reviewUI.restore(path, target.draft);
		}
	}
	async function openPath(target: ExplorerLaunch, requested: ExplorerLaunch["view"], stamp: number) {
		const candidate = target.path ?? (requested === "changes" ? review?.files[0]?.path : "");
		const anchor = target.draft?.range;
		await navigate(
			{
				...target,
				path: candidate ?? "",
				view: requested,
				line: anchor?.start ?? target.line,
				end: anchor?.end ?? target.end,
			},
			{ keepTab: !requested, keepSheet: true, side: anchor?.side },
		);
		restoreLaunchDraft(target, candidate, stamp);
		if (target.tour || target.note)
			notice(target.tour ? "That walkthrough is not available." : "That note is not available.");
	}
	function launchView(target: ExplorerLaunch) {
		return target.view ?? (target.review || target.tour ? "changes" : undefined);
	}
	function launchNeedsReview(requested: ExplorerLaunch["view"], target: ExplorerLaunch) {
		return (requested === "changes" || target.review) && root.kind === "git";
	}
	function launchNeedsNotes(target: ExplorerLaunch) {
		return (target.note || target.tour) && !notes.length;
	}
	function prepareLaunch(target: ExplorerLaunch) {
		if (target.review) scope = target.review;
		const requested = launchView(target);
		if (requested) settings.tab = requested === "file" ? "files" : requested;
		return requested;
	}
	async function open(target: ExplorerLaunch) {
		const stamp = rootStamp;
		const requested = prepareLaunch(target);
		if (launchNeedsReview(requested, target)) await refreshReview();
		if (stamp !== rootStamp) return;
		if (launchNeedsNotes(target)) await refreshNotes();
		if (stamp !== rootStamp) return;
		const note = notes.find((note) => note.id === target.note);
		const tour = tours.find((tour) => tour.id === target.tour);
		if (tour) {
			await startTour(tour);
			return;
		}
		if (note) {
			await goNote(note);
			return;
		}
		await openPath(target, requested, stamp);
	}
	function resetRoot(next: ExplorerRoot) {
		clearTimeout(stateTimer);
		closeCommand();
		closeMenu(false);
		closeFind();
		reviewUI.escape();
		reviewUI.escape();
		openStamp++;
		reviewStamp++;
		notesStamp++;
		filesStamp++;
		rootStamp++;
		root = next;
		scope = undefined;
		scopes = [];
		review = null;
		notes = [];
		tours = [];
		paths = [];
		viewed.clear();
		folders.clear();
		path = "";
		lineRange = null;
		file = null;
		diff = null;
		baseLines = [];
		headLines = [];
		fileError = "";
		filesError = "";
		reviewError = "";
		notesError = "";
		sentReviews.clear();
		targetRange = null;
		anchoredLine = null;
		history = [];
		historyAt = -1;
		filter = "";
		filterInput.value = "";
		makeTree();
		code.clear();
		rootChrome();
		reviewUI.refresh();
		report(refreshFiles());
		report(refreshNotes());
		report(refreshScopes());
	}
	function hostOpen(event: Extract<ExplorerEvent, { type: "open" }>) {
		if (!booted) {
			pendingOpen = event;
			return;
		}
		if (event.root && root.path !== event.root.path) resetRoot(event.root);
		else if (event.root) {
			root = event.root;
			rootChrome();
		}
		report(open(event));
	}
	function filesChanged(event: Extract<ExplorerEvent, { type: "files.changed" }>) {
		const oldHead = root.head;
		if (event.head) {
			root = {
				...root,
				...event.head,
				onDefaultBranch: !!event.head.branch && event.head.branch === root.defaultBranch,
			};
			rootChrome();
		}
		const stamp = openStamp;
		report(refreshFiles());
		report(refreshNotes());
		report(refreshChangedView(stamp, oldHead, event.paths));
	}
	function touchesOpenFile(oldHead: ExplorerRoot["head"], paths: string[]) {
		return (
			oldHead !== root.head ||
			!paths.length ||
			paths.includes(path) ||
			(view === "changes" && scope?.kind === "uncommitted")
		);
	}
	async function refreshChangedView(stamp: number, oldHead: ExplorerRoot["head"], paths: string[]) {
		if (root.kind === "git") {
			await refreshScopes();
			if (view === "changes" || review) await refreshReview();
		}
		if (stamp !== openStamp || !path || loadingFile) return;
		if (touchesOpenFile(oldHead, paths)) await navigate({ path, view }, { refresh: true });
	}
	app.listen((event) => {
		switch (event.type) {
			case "open":
				hostOpen(event);
				break;
			case "notes.changed":
				if (booted) report(refreshNotes());
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
	async function boot() {
		try {
			const result = await request("hello");
			root = result.root;
			settings = result.settings;
			live = result.live;
			settings.textSize = Number.isFinite(settings.textSize) ? Math.max(10, Math.min(32, settings.textSize)) : 16;
			settings.sidebar.width = Math.max(215, Math.min(430, settings.sidebar.width));
			rootChrome();
			liveChrome();
			renderSidebarState();
			renderSidebar();
			const initial = Promise.all([refreshFiles(), refreshNotes(), refreshScopes()]);
			const deferred = pendingOpen;
			pendingOpen = undefined;
			booted = true;
			if (deferred?.root && deferred.root.path !== root.path) resetRoot(deferred.root);
			await initial;
			await open(deferred ?? result.launch);
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
	click("search", () => command("search"), "search");
	click("wrap-lines", toggleWrap);
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
	isNarrow.addEventListener("change", () => {
		sheet = false;
		renderSidebarState();
		reviewUI.reposition();
	});
	isWide.addEventListener("change", () => {
		if (view === "changes" && settings.diff === "auto") renderCode(code.place());
	});
	window.addEventListener("resize", () => {
		placeStrip();
		reviewUI.reposition();
	});
	window.addEventListener("pagehide", () => {
		if (booted) savePosition(true);
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
	function noteShortcut(event: KeyboardEvent, key: string, range: ExplorerRange | null) {
		if ((key === "m" || event.code === "KeyM") && event.altKey) return () => askAt(null, "ask");
		if (range) return rangeShortcut(event, key, range);
	}
	function rangeShortcut(event: KeyboardEvent, key: string, range: ExplorerRange) {
		if (event.shiftKey && key === "m") return () => askAt(range, "ask");
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
	function metaShortcut(event: KeyboardEvent, key: string, editing: boolean, range: ExplorerRange | null) {
		if (!event.metaKey || event.ctrlKey) return;
		return (
			navigationShortcut(event, key, editing) ??
			noteShortcut(event, key, range) ??
			fileShortcut(event) ??
			copyShortcut(event, key, editing, range)
		);
	}
	function secondaryShortcut(event: KeyboardEvent, key: string, editing: boolean) {
		if (event.ctrlKey && key === "g" && (headLines.length || baseLines.length)) return () => command("line");
		if (event.altKey && !event.metaKey && event.code === "KeyZ" && !editing) return toggleWrap;
	}
	function stepWalkthrough(key: string) {
		if (key === "arrowleft") return reviewUI.step(-1);
		if (key === "arrowright") return reviewUI.step(1);
		return false;
	}
	function isEditing(target: EventTarget | null) {
		return target instanceof HTMLElement && !!target.closest("input,textarea,select,[contenteditable=true]");
	}
	document.addEventListener("keydown", (event) => {
		if (event.isComposing || event.defaultPrevented) return;
		if (!menu.hidden) return;
		const key = event.key.toLowerCase();
		const editing = isEditing(event.target);
		const range = activeRange();
		if (key === "escape") {
			event.preventDefault();
			escapeExplorer();
			return;
		}
		if (mode) return;
		const action = metaShortcut(event, key, editing, range) ?? secondaryShortcut(event, key, editing);
		if (action) {
			event.preventDefault();
			action();
			return;
		}
		if (!editing && stepWalkthrough(key)) event.preventDefault();
	});
	void boot();
})();
