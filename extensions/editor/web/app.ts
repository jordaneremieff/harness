import {
	acceptPatch,
	acceptRefresh,
	anchorStillExact,
	capturePatch,
	lineIndex,
	makeDraft,
	refreshStamp,
} from "./draft.ts";
import { mountEditor } from "./editor-view.ts";
import { matchesThreadAnchor, rangeAt } from "./anchors.ts";
import type {
	Anchor,
	ApiOps,
	Directory,
	DocHeader,
	DocRecord,
	DraftBuffer,
	GitInfo,
	Member,
	SearchKind,
	Selection,
	Target,
	ThreadDetail,
	ThreadHeader,
	ViewHeader,
} from "./types.ts";

type BrowserPopup = HTMLDivElement & { returnFocus?: HTMLElement | null };
type Nav = "files" | "search" | "git";
type Recipient = "new" | "reply";
type PathMode = "new" | "save";
type Scope = { doc?: string; target?: Target };

interface Elements {
	source: HTMLTextAreaElement;
	"note-text": HTMLTextAreaElement;
	"reply-text": HTMLTextAreaElement;
	"find-input": HTMLInputElement;
	"search-input": HTMLInputElement;
	"path-input": HTMLInputElement;
	"show-lines": HTMLInputElement;
	"new-target": HTMLSelectElement;
	"reply-target": HTMLSelectElement;
	"search-kind": HTMLSelectElement;
	"path-dialog": HTMLDialogElement;
	"context-menu": BrowserPopup;
	"settings-menu": BrowserPopup;
	"post-note": HTMLButtonElement;
	"post-reply": HTMLButtonElement;
	save: HTMLButtonElement;
	"save-as": HTMLButtonElement;
	find: HTMLButtonElement;
	"add-note": HTMLButtonElement;
	recover: HTMLButtonElement;
	"desk-scope": HTMLButtonElement;
	"confirm-path": HTMLButtonElement;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

const $ = <K extends string>(id: K) =>
	document.getElementById(id) as K extends keyof Elements ? Elements[K] : HTMLElement;
const source = $("source");
const ink = $("ink");
const numbers = $("line-numbers");
const layout = $("layout");
const fragment = new URLSearchParams(location.hash.slice(1));
const launchFile = fragment.get("file");
let key = fragment.get("k");
if (location.hash) history.replaceState(null, "", location.pathname + location.search);
try {
	if (key) sessionStorage.setItem("editor-key", key);
	else key = sessionStorage.getItem("editor-key");
} catch {
	/* The launch key still works for this page. */
}

const tabs = new Map<string, DraftBuffer>();
const reads = new Map<string, Promise<DocRecord>>();
const viewTabs = new Map<string, { tab: HTMLDivElement; pick: HTMLButtonElement; label: HTMLSpanElement }>();
let views: ViewHeader[] = [];
let showingView: ViewHeader | undefined;
let viewEpoch = 0;
const directories = new Map<string, Directory>();
const expanded = new Set<string>();
let current: string | undefined;
let openChoice = 0;
let interaction = 0;
let seq: number | undefined;
let treeVersion = 0;
let documents: DocHeader[] = [];
let docsLimited = false;
let threads: ThreadHeader[] = [];
let threadsLimited = false;
let members: Member[] = [];
let noteAnchor: Anchor | undefined;
let engaging = false;
let contextTarget: Anchor | undefined;
let threadId: string | undefined;
let threadDetail: ThreadDetail | undefined;
let showAllThreads = false;
let currentView: Nav = "files";
let viewingDiff = false;
let git: GitInfo | undefined;
let gitVersion = 0;
let diffVersion = 0;
let stateFlight: Promise<void> | null;
let membersFlight: Promise<void> | null;
let threadFlight: { id: string } | null;
let poll: number | undefined;
let nextDiskCheck = 0;
let searchController: AbortController | undefined;
let searchTimer: number | undefined;
let pathMode: PathMode;
let pathDraft: DraftBuffer | undefined;
const smallScreen = matchMedia("(max-width: 800px)");
const editorView = mountEditor(source, ink, numbers, {
	active: () => active(),
	anchors: (draft: DraftBuffer) =>
		pending(draft) || draft.blocked
			? []
			: threads.filter((thread) => !thread.target && thread.doc === draft.doc && thread.rev === draft.rev),
	openThread: (id: string) => openThread(id),
	position: (language: string, cursor: string) => {
		$("language").textContent = language;
		$("position").textContent = cursor;
	},
});
const requestPaint = editorView.request;
const jumpToLine = editorView.jump;
let noticeTimer: number | undefined;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
	const element = document.createElement(tag);
	if (className) element.className = className;
	if (text !== undefined) element.textContent = text;
	return element;
}

function button(label: string, className: string, action: () => unknown) {
	const element = node("button", className, label);
	element.type = "button";
	element.onclick = action;
	return element;
}

function status(text: string, error = false) {
	$("connection").textContent = text;
	$("connection").dataset.error = String(error);
}

function tell(text: string, error = false) {
	const target = $("notice");
	target.textContent = text;
	target.title = text;
	target.dataset.error = String(error);
	clearTimeout(noticeTimer);
	if (!error)
		noticeTimer = window.setTimeout(() => {
			target.textContent = "";
			target.title = "";
		}, 3500);
}

class RequestError extends Error {
	readonly code: string | undefined;
	readonly status: number;
	constructor(message: string, code: string | undefined, status: number) {
		super(message);
		this.code = code;
		this.status = status;
	}
}

async function api<K extends keyof ApiOps>(op: K, args?: ApiOps[K][0], signal?: AbortSignal): Promise<ApiOps[K][1]> {
	if (!key) throw new RequestError("Open the editor from Pi to connect to this folder.", "auth", 401);
	const timeout = AbortSignal.timeout(12000);
	let response: Response;
	let result: unknown;
	try {
		response = await fetch("./api", {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
			body: JSON.stringify({ op, ...args }),
			cache: "no-store",
			credentials: "omit",
			redirect: "error",
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		result = await response.json();
	} catch (error) {
		if (signal?.aborted) throw error;
		status("Connection lost", true);
		throw new RequestError("The editor did not receive a response. Check the connection.", "network", 0);
	}
	if (response.status === 401 || response.status === 403) status("Open from Pi", true);
	else status("Connected");
	if (!response.ok) {
		const error = result as { error?: string; code?: string } | null;
		throw new RequestError(error?.error || "The workspace refused the request.", error?.code, response.status);
	}
	return result as ApiOps[K][1];
}

const fail = (error: unknown) => tell(errorText(error), true);
const disk = (doc: string) => !doc.startsWith("scratch:");
const pending = (draft: DraftBuffer) => draft.text !== draft.base || draft.composing;
const active = () => (showingView || current === undefined ? undefined : tabs.get(current));
const leaf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
const conflict = (error: unknown) =>
	error instanceof RequestError &&
	(/stale|conflict|disk changed|changed on disk|revision/i.test(`${error.code} ${errorText(error)}`) ||
		error.status === 409);

function rememberView() {
	const draft = active();
	if (!draft || viewingDiff || $("editor").hidden) return;
	draft.start = source.selectionStart;
	draft.end = source.selectionEnd;
	draft.direction = source.selectionDirection;
	draft.top = source.scrollTop;
	draft.left = source.scrollLeft;
}

function restoreView(draft: DraftBuffer) {
	if (source.value !== draft.text) source.value = draft.text;
	source.setSelectionRange(draft.start, draft.end, draft.direction);
	source.scrollTop = draft.top;
	source.scrollLeft = draft.left;
}

function markRows() {
	for (const row of document.querySelectorAll<HTMLElement>("[data-file]")) {
		row.setAttribute("aria-current", String(row.dataset.file === current));
	}
}

function attachTab(draft: ReturnType<typeof makeDraft>): DraftBuffer {
	const tab = node("div", "tab");
	const open = button("", "tab-open", () => {
		++openChoice;
		activate(draft.doc);
	});
	const name = node("span", "tab-label");
	const dot = node("span", "dot", "●");
	dot.setAttribute("aria-hidden", "true");
	open.append(name, dot);
	const close = button("×", "close", () => closeTab(buffer).catch(fail));
	tab.append(open, close);
	$("tabs").append(tab);
	const buffer = Object.assign(draft, { tab, open, name, dot, close });
	updateTab(buffer);
	return buffer;
}

function updateTab(draft: DraftBuffer) {
	const title = draft.title || leaf(draft.doc);
	draft.name.textContent = title;
	draft.close.setAttribute("aria-label", `Close ${title}`);
	draft.tab.title = disk(draft.doc) ? draft.doc : title;
	draft.dot.hidden = !(draft.dirty || pending(draft) || draft.blocked);
	tagTarget(draft.tab, { kind: "tab", key: draft.doc });
	draft.open.setAttribute("aria-current", String(current === draft.doc && !showingView));
	draft.open.setAttribute("aria-label", title + (draft.dot.hidden ? "" : ", not saved to disk"));
	draft.tab.classList.toggle("current", current === draft.doc && !showingView);
}

function addTab(record: DocRecord): DraftBuffer {
	const existing = tabs.get(record.doc);
	if (existing) return existing;
	const draft = attachTab(makeDraft(record));
	tabs.set(draft.doc, draft);
	return draft;
}

function activate(doc?: string, focus = true) {
	const old = active();
	if (doc !== current || viewingDiff || showingView) rememberView();
	showingView = undefined;
	++viewEpoch;
	current = doc;
	viewingDiff = false;
	++diffVersion;
	updateViewTabs();
	const draft = active();
	if (draft) displayDraft(draft, focus, old !== draft);
	else $("find-form").hidden = true;
	if (old) updateTab(old);
	if (mentionClosedDraft(doc)) closeComposer();
	if (doc && !showAllThreads && threadDetail?.doc && threadDetail.doc !== doc) closeThread();
	renderWork();
	renderThreads();
	markRows();
	updateFindCount();
	if (currentView === "git") refreshGit();
}

function displayDraft(draft: DraftBuffer, focus: boolean, switched: boolean) {
	$("editor").hidden = false;
	restoreView(draft);
	if (focus) source.focus({ preventScroll: true });
	if (switched) draft.tab.scrollIntoView({ block: "nearest", inline: "nearest" });
	updateTab(draft);
}

function mentionClosedDraft(doc?: string) {
	return noteAnchor?.doc !== undefined && noteAnchor.doc !== doc && !$("note-text").value;
}

async function readDoc(doc: string): Promise<DocRecord> {
	const record = await api("read", { doc });
	if (record.unchanged) throw new Error("The workspace did not return document text.");
	return record;
}

async function openDoc(doc: string, { focus = true, line }: { focus?: boolean; line?: number } = {}) {
	const intent = ++openChoice;
	const input = interaction;
	const wanted = () => intent === openChoice && input === interaction;
	try {
		let draft = tabs.get(doc);
		if (!draft) {
			if (!reads.has(doc)) {
				const read = readDoc(doc).finally(() => {
					reads.delete(doc);
				});
				reads.set(doc, read);
			}
			const record = await reads.get(doc);
			if (!record) return;
			if (!wanted()) return;
			draft = addTab(record);
		}
		if (!wanted()) return;
		activate(draft.doc, focus);
		if (line) jumpToLine(line);
		if (focus && smallScreen.matches) panel("files", false);
		return draft;
	} catch (error) {
		if (wanted()) throw error;
	}
}

async function closeTab(draft: DraftBuffer) {
	if (draft.closing || draft.saving) return;
	if (draft.blocked) {
		tell("Keep a scratch copy or resolve the draft before you close this tab.", true);
		return;
	}
	draft.closing = true;
	try {
		await flush(draft);
		if (pending(draft) || draft.blocked || draft.flight) return;
		const keys = [...tabs.keys()];
		tabs.delete(draft.doc);
		if (current === draft.doc) {
			++openChoice;
			const at = keys.indexOf(draft.doc);
			activate(keys[at + 1] ?? keys[at - 1]);
		}
		draft.tab.remove();
	} finally {
		draft.closing = false;
	}
}

function renderWork() {
	const draft = active();
	$("welcome").hidden = !!draft || viewingDiff || !!showingView;
	$("editor").hidden = !draft || viewingDiff;
	$("diff").hidden = !viewingDiff;
	$("agent-view").hidden = !showingView;
	$("document-path").textContent = draft
		? disk(draft.doc)
			? draft.doc
			: draft.title
		: (showingView?.title ?? "No file open");
	$("save").disabled = !draft || viewingDiff || !!draft.blocked || !!draft.saving;
	$("save-as").disabled = $("save").disabled;
	$("find").disabled = !draft || viewingDiff;
	$("add-note").disabled = !draft && !showingView;
	$("add-note").textContent = showingView
		? "＋ Thread on view"
		: viewingDiff
			? "＋ Thread on diff"
			: "＋ Thread at selection";
	const block = draft?.blocked;
	$("conflict").hidden = !draft || (!block && !draft.diskChanged);
	$("conflict-text").textContent = block ? block.message : "The file on disk changed. The shared draft is intact.";
	$("recover").hidden = !block;
	$("reload").hidden = block?.kind !== "conflict";
	$("retry").hidden = block?.kind !== "patch";
	requestPaint();
}

function updateDraft(draft: DraftBuffer) {
	updateTab(draft);
	if (draft === active()) renderWork();
}

function editInput() {
	const draft = active();
	if (!draft || source.value === draft.text) return;
	draft.text = source.value;
	draft.change++;
	rememberView();
	updateTab(draft);
	requestPaint();
	if (!draft.composing && !draft.blocked) queuePatch(draft);
}

function queuePatch(draft: DraftBuffer, delay = 210) {
	clearTimeout(draft.timer);
	draft.timer = window.setTimeout(() => {
		flush(draft).catch(fail);
	}, delay);
}

async function flush(draft: DraftBuffer): Promise<void> {
	clearTimeout(draft.timer);
	if (draft.saveInFlight) return;
	if (draft.composing) throw new Error("Finish entering the current text first.");
	if (draft.blocked) throw new Error(draft.blocked.message);
	if (draft.flight) {
		await draft.flight;
		return flush(draft);
	}
	const patch = capturePatch(draft);
	if (!patch) return;
	const { op, ...args } = patch.input;
	const receipt = api(op, args)
		.then((result) => acceptPatch(draft, patch, result))
		.catch((error) => {
			draft.blocked = {
				kind: conflict(error) ? "conflict" : "patch",
				message: `${errorText(error)} Your local text is intact.`,
			};
			throw error;
		})
		.finally(() => {
			draft.flight = null;
			updateDraft(draft);
		});
	draft.flight = receipt;
	await receipt;
	if (pending(draft) && !draft.composing) queuePatch(draft);
}

async function beforeRevision(draft: DraftBuffer, stamp: Selection) {
	if (draft.saving || !anchorStillExact(stamp, draft))
		throw new Error("The document changed or is busy. Select the text again before you post.");
	await flush(draft);
	if (!anchorStillExact(stamp, draft) || pending(draft))
		throw new Error("The document changed. Select the text again before you post.");
	return draft.rev;
}

async function saveDraft(draft?: DraftBuffer, path?: string) {
	if (!draft || draft.saving) return;
	draft.saving = true;
	const input = interaction;
	const intent = openChoice;
	updateDraft(draft);
	try {
		await flush(draft);
		if (pending(draft)) throw new Error("Text changed during Save. Try Save again.");
		draft.saveInFlight = true;
		const record = await requestSave(draft, path);
		applySave(draft, record, input === interaction && intent === openChoice);
		afterSave(record);
	} finally {
		draft.saveInFlight = false;
		draft.saving = false;
		if (pending(draft) && !draft.blocked && !draft.composing) queuePatch(draft);
		updateDraft(draft);
	}
}

async function requestSave(draft: DraftBuffer, path?: string) {
	try {
		return await api("save", { doc: draft.doc, rev: draft.rev, ...(path ? { path } : {}) });
	} catch (error) {
		if (conflict(error) && !path) draft.diskChanged = true;
		if (error instanceof RequestError && error.code === "network" && path && !disk(draft.doc)) {
			draft.blocked = {
				kind: "conflict",
				message:
					"The server did not confirm Save As. Your local text is intact. Check the destination before you try again.",
			};
		}
		throw error;
	}
}

function applySave(draft: DraftBuffer, record: DocRecord, showCopy: boolean) {
	const previous = draft.doc;
	if (record.doc !== previous) {
		if (disk(previous)) {
			const created = addTab(record);
			if (showCopy && active() === draft && !pending(draft)) activate(created.doc);
			return;
		}
		renameScratch(draft, record);
	}
	draft.base = record.text;
	draft.rev = record.rev;
	draft.dirty = record.dirty;
	draft.diskChanged = false;
}

function renameScratch(draft: DraftBuffer, record: DocRecord) {
	const previous = draft.doc;
	const entries = [...tabs];
	tabs.clear();
	for (const [id, tab] of entries) tabs.set(id === previous ? record.doc : id, tab);
	if (current === previous) current = record.doc;
	draft.doc = record.doc;
	draft.title = record.title;
	if (noteAnchor && moveNoteAnchor(noteAnchor, previous, record))
		$("anchor-label").textContent = anchorName(noteAnchor);
	if (contextTarget && moveNoteAnchor(contextTarget, previous, record))
		$("context-label").textContent = anchorName(contextTarget);
}

function moveNoteAnchor(anchor: Anchor, previous: string, record: DocRecord) {
	if (anchor.target?.kind === "tab" && anchor.target.key === previous) {
		anchor.target.key = record.doc;
		return true;
	}
	if (anchor.doc === previous) {
		anchor.doc = record.doc;
		anchor.title = record.title;
		return true;
	}
	return false;
}

function afterSave(record: DocRecord) {
	tell(`Saved ${record.doc}`);
	refreshState();
	refreshTree();
	if (currentView === "git") refreshGit();
}

async function recoverDraft() {
	const draft = active();
	if (!draft?.blocked || draft.recovering) return;
	draft.recovering = true;
	const intent = openChoice;
	const input = interaction;
	$("recover").disabled = true;
	try {
		const recovered = addTab(await api("new"));
		const text = draft.text;
		recovered.text = text;
		recovered.change++;
		const change = draft.change;
		await flush(recovered);
		finishRecovery(draft, recovered, change, input === interaction && intent === openChoice);
	} finally {
		draft.recovering = false;
		$("recover").disabled = false;
		refreshState();
	}
}

function finishRecovery(draft: DraftBuffer, recovered: DraftBuffer, change: number, showCopy: boolean) {
	if (draft.change !== change) {
		tell("Scratch copy saved. More recent local text remains in the original tab.", true);
		return;
	}
	if (showCopy && active() === draft) {
		activate(recovered.doc);
		draft.tab.remove();
		tabs.delete(draft.doc);
	}
	tell("Local text is now in a shared scratch document. The original was not changed.");
}

async function reloadDraft() {
	const draft = active();
	if (
		!draft?.blocked ||
		!window.confirm(
			"Replace this tab’s local text with the shared version? Keep a scratch copy first if you need the local text.",
		)
	)
		return;
	const stamp = refreshStamp(draft);
	const record = await readDoc(draft.doc);
	if (draft.change !== stamp.change || draft.doc !== stamp.doc || draft.composing) return;
	draft.blocked = null;
	draft.text = draft.base;
	acceptRefresh(draft, stamp, record);
	if (active() === draft && !viewingDiff) restoreView(draft);
	updateDraft(draft);
}

function refreshDraft(draft: DraftBuffer) {
	if (draft.checking || draft.flight || draft.saving || draft.blocked || pending(draft)) return;
	const stamp = refreshStamp(draft);
	draft.checking = api("read", { doc: stamp.doc, ifRev: stamp.rev })
		.then((record) => applyDraftRead(draft, stamp, record))
		.catch((error) => {
			if (!(error instanceof RequestError && error.code === "network")) fail(error);
		})
		.finally(() => {
			draft.checking = null;
		});
}

function applyDraftRead(draft: DraftBuffer, stamp: ReturnType<typeof refreshStamp>, record: ApiOps["read"][1]) {
	if (stamp.doc !== draft.doc || tabs.get(stamp.doc) !== draft || draft.saving || draft.rev !== stamp.rev) return;
	if (record.unchanged) {
		if (draft.diskChanged === !!record.diskChanged) return;
		draft.diskChanged = !!record.diskChanged;
		updateDraft(draft);
		return;
	}
	const visible = active() === draft;
	if (visible) rememberView();
	if (!acceptRefresh(draft, stamp, record)) return;
	draft.diskChanged = !!record.diskChanged;
	if (visible && !viewingDiff) restoreView(draft);
	if (visible) updateFindCount();
	updateDraft(draft);
}

function updateWorkspace(state: Exclude<ApiOps["state"][1], { unchanged: true }>) {
	seq = state.seq;
	documents = state.docs;
	docsLimited = !!state.docsLimited;
	threads = state.threads;
	threadsLimited = !!state.threadsLimited;
	const headers = state.views ?? [];
	if (JSON.stringify(views) !== JSON.stringify(headers)) {
		views = headers;
		renderViewList();
	}
	const title = state.root === "/" ? "/" : leaf(state.root);
	const rootChanged = $("root").textContent !== title;
	$("root").textContent = title;
	$("root").title = state.root;
	document.title = `${title} · Editor`;
	if (rootChanged && directories.has("")) renderTree();
	renderDraftList();
	renderThreads();
	requestPaint();
}

function refreshOpenItems() {
	const view = showingView;
	if (view && (views.find((entry) => entry.id === view.id)?.rev ?? 0) > view.rev) refreshView(view);
	for (const row of documents) {
		const draft = tabs.get(row.doc);
		if (draft && row.rev > draft.rev) refreshDraft(draft);
	}
	if (threadId) refreshOpenThread();
	const draft = active();
	if (draft && Date.now() >= nextDiskCheck) {
		nextDiskCheck = Date.now() + 3500;
		refreshDraft(draft);
	}
}

function refreshOpenThread() {
	const header = threads.find((thread) => thread.id === threadId);
	if (
		!threadDetail ||
		(header && (threadOriginChanged(header, threadDetail) || header.messageCount > threadDetail.messages.length))
	)
		refreshThread();
}

function threadOriginChanged(previous: Scope & { rev: number }, current: Scope & { rev: number }) {
	return (
		previous.doc !== current.doc ||
		previous.rev !== current.rev ||
		previous.target?.kind !== current.target?.kind ||
		previous.target?.key !== current.target?.key
	);
}

function refreshState() {
	if (!key || stateFlight || document.hidden) return stateFlight;
	stateFlight = api("state", seq === undefined ? {} : { since: seq })
		.then((state) => {
			if (!state.unchanged) updateWorkspace(state);
			refreshOpenItems();
		})
		.catch((error) => {
			if (!(error instanceof RequestError && error.status === 0)) fail(error);
		})
		.finally(() => {
			stateFlight = null;
		});
	return stateFlight;
}

function startPolling() {
	clearInterval(poll);
	if (document.hidden || !key) return;
	refreshState();
	poll = window.setInterval(refreshState, 1250);
}

function panel(name: "files" | "threads", visible: boolean) {
	const id = name === "files" ? "files" : "desk";
	$(id).hidden = !visible;
	layout.classList.toggle(`${id}-closed`, !visible);
	$(`toggle-${name}`).setAttribute("aria-expanded", String(visible));
	if (visible && smallScreen.matches) {
		const other = name === "files" ? "threads" : "files";
		const otherId = other === "files" ? "files" : "desk";
		if (!$(otherId).hidden) panel(other, false);
	}
	requestPaint();
}

function activateNav(view: Nav, focus = false) {
	currentView = view;
	for (const name of ["files", "search", "git"]) {
		$(`${name}-view`).hidden = name !== view;
		document.querySelector(`[data-view="${name}"]`)?.setAttribute("aria-pressed", String(name === view));
	}
	panel("files", true);
	if (view === "search" && focus) $("search-input").focus();
	if (view === "git") refreshGit();
}

function row(label: string, glyph: string, action: () => unknown, target: Target, depth = 0) {
	const element = button("", "row", action);
	element.style.setProperty("--depth", String(Math.min(depth, 8)));
	const icon = node("span", target.kind === "folder" ? "glyph" : "glyph file", glyph);
	icon.setAttribute("aria-hidden", "true");
	element.append(icon, node("span", "name", label));
	tagTarget(element, target);
	if (target.kind === "file" || target.kind === "tab") {
		element.dataset.file = target.key;
		element.setAttribute("aria-current", String(target.key === current));
	}
	return element;
}

function renderTree() {
	const tree = $("tree");
	const focused = tree.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : null;
	const scroll = $("files-view").scrollTop;
	const root = row($("root").textContent || "Workspace", "▾", () => loadDirectory("").catch(fail), {
		kind: "folder",
		key: "",
	});
	root.dataset.focus = "root";
	const fragment = document.createDocumentFragment();
	fragment.append(root);
	const fileStatus = new Map(git?.files.map((file) => [file.path, file.status]));
	listDirectory(fragment, fileStatus, "", 1);
	tree.replaceChildren(fragment);
	if (focused) restoreTreeFocus(tree, focused);
	$("files-view").scrollTop = scroll;
}

function restoreTreeFocus(tree: HTMLElement, focused: string) {
	const buttons = [...tree.querySelectorAll("button")];
	const key = focused.startsWith("more:") ? `folder:${focused.slice(5)}` : "root";
	const retained = buttons.find((element) => element.dataset.focus === focused);
	(retained ?? buttons.find((element) => element.dataset.focus === key))?.focus({ preventScroll: true });
}

function listDirectory(fragment: DocumentFragment, fileStatus: Map<string, string>, path: string, depth: number) {
	const directory = directories.get(path);
	if (!directory) {
		fragment.append(node("p", "muted", "Loading…"));
		return;
	}
	for (const entry of directory.entries) {
		fragment.append(treeEntry(entry, depth, fileStatus.get(entry.path)));
		if (entry.dir && expanded.has(entry.path)) listDirectory(fragment, fileStatus, entry.path, depth + 1);
	}
	addPageControls(fragment, path, directory);
}

function treeEntry(entry: Directory["entries"][number], depth: number, gitStatus?: string) {
	const kind = entry.dir ? "folder" : "file";
	const open = expanded.has(entry.path);
	const icon = entry.dir ? (open ? "▾" : "▸") : "▪";
	const element = row(entry.name, icon, () => openTreeEntry(entry), { kind, key: entry.path }, depth);
	element.dataset.focus = `${kind}:${entry.path}`;
	if (entry.dir) element.setAttribute("aria-expanded", String(open));
	if (gitStatus) element.append(node("span", "git-mark", gitStatus));
	return element;
}

function openTreeEntry(entry: Directory["entries"][number]) {
	if (!entry.dir) {
		openDoc(entry.path).catch(fail);
		return;
	}
	const opening = !expanded.delete(entry.path);
	if (opening) expanded.add(entry.path);
	renderTree();
	if (opening && !directories.has(entry.path)) loadDirectory(entry.path).catch(fail);
}

function addPageControls(fragment: DocumentFragment, path: string, directory: Directory) {
	if (directory.error) {
		const again = button(`Retry · ${directory.error}`, "row", () => loadDirectory(path).catch(fail));
		again.dataset.focus = `retry:${path}`;
		fragment.append(again);
	} else if (directory.next != null) {
		const more = button("Load more", "row", () => loadDirectory(path, directory.next ?? undefined).catch(fail));
		more.dataset.focus = `more:${path}`;
		fragment.append(more);
	}
	if (directory.limited) fragment.append(node("p", "muted", "Partial folder contents"));
	if (directory.entries.length === 0 && directory.next == null && !directory.error)
		fragment.append(node("p", "muted", "Empty folder"));
}

const treeRequests = new Map<string, Promise<void>>();
async function loadDirectory(path: string, offset?: number) {
	const version = treeVersion;
	const requestKey = JSON.stringify([version, path, offset ?? 0]);
	if (treeRequests.has(requestKey)) return treeRequests.get(requestKey);
	const request = (async () => {
		try {
			const result = await api("tree", { path, ...(offset == null ? {} : { offset }) });
			if (version !== treeVersion) return;
			const previous = offset == null ? [] : (directories.get(path)?.entries ?? []);
			const entries = [...new Map([...previous, ...result.entries].map((entry) => [entry.path, entry])).values()];
			directories.set(path, { ...result, entries });
			renderTree();
		} catch (error) {
			if (version !== treeVersion) return;
			directories.set(path, {
				next: null,
				...directories.get(path),
				entries: directories.get(path)?.entries ?? [],
				error: errorText(error),
			});
			renderTree();
			throw error;
		}
	})().finally(() => treeRequests.delete(requestKey));
	treeRequests.set(requestKey, request);
	return request;
}

function refreshTree() {
	const version = ++treeVersion;
	const paths = [...expanded].filter((path) => {
		for (let at = path.lastIndexOf("/"); at !== -1; at = path.lastIndexOf("/", at - 1)) {
			if (!expanded.has(path.slice(0, at))) return false;
		}
		return true;
	});
	refreshExpandedFolders(["", ...paths], version);
}

async function refreshExpandedFolders(paths: string[], version: number) {
	for (const path of paths) {
		if (version !== treeVersion) return;
		try {
			const result = await refreshFolderPages(path, version);
			if (version !== treeVersion) return;
			directories.set(path, result);
			renderTree();
		} catch (error) {
			if (version === treeVersion) fail(error);
		}
	}
}

async function refreshFolderPages(path: string, version: number): Promise<Directory> {
	const count = directories.get(path)?.entries.length ?? 0;
	let page = await api("tree", { path });
	const entries = new Map(page.entries.map((entry) => [entry.path, entry]));
	// Exchange the loaded pages together to preserve focus on rows beyond the first page.
	while (version === treeVersion && page.next != null && entries.size < count) {
		const offset = page.next;
		page = await api("tree", { path, offset });
		for (const entry of page.entries) entries.set(entry.path, entry);
		if (page.next === offset) break;
	}
	return { ...page, entries: [...entries.values()] };
}

let draftListKey: string | undefined;
function renderDraftList() {
	const rows = documents.filter((doc) => doc.dirty || !disk(doc.doc));
	const key = JSON.stringify([docsLimited, rows.map(({ doc, title }) => [doc, title])]);
	if (key === draftListKey) return;
	draftListKey = key;
	const container = $("draft-list");
	const focus = container.contains(document.activeElement)
		? (document.activeElement as HTMLElement).dataset.file
		: null;
	const fragment = document.createDocumentFragment();
	if (rows.length) fragment.append(node("div", "draft-heading", "Shared drafts"));
	if (docsLimited) fragment.append(node("p", "muted", "Recent documents only"));
	for (const entry of rows)
		fragment.append(
			row(entry.title || entry.doc, "◦", () => openDoc(entry.doc).catch(fail), {
				kind: disk(entry.doc) ? "file" : "tab",
				key: entry.doc,
			}),
		);
	container.replaceChildren(fragment);
	if (focus)
		[...container.querySelectorAll("button")]
			.find((element) => element.dataset.file === focus)
			?.focus({ preventScroll: true });
}

function searchSoon(immediate = false) {
	clearTimeout(searchTimer);
	searchController?.abort();
	const query = $("search-input").value.trim();
	if (!query) {
		$("search-results").replaceChildren();
		return;
	}
	const kind = $("search-kind").value as SearchKind;
	const controller = new AbortController();
	searchController = controller;
	const run = () => executeSearch(query, kind, controller.signal);
	if (immediate) run();
	else searchTimer = window.setTimeout(run, 170);
}

async function executeSearch(query: string, kind: SearchKind, signal: AbortSignal) {
	const list = $("search-results");
	list.replaceChildren(node("p", "muted", "Searching…"));
	try {
		const result = await api("search", { query, kind }, signal);
		if (!signal.aborted) renderSearch(result);
	} catch (error) {
		if (!signal.aborted) list.replaceChildren(node("p", "muted", errorText(error)));
	}
}

function renderSearch({ hits, limited }: ApiOps["search"][1]) {
	const fragment = document.createDocumentFragment();
	if (!hits.length || limited) fragment.append(node("p", "muted", limited ? "Partial search results" : "No matches"));
	for (const hit of hits) {
		const name = hit.line ? `${hit.path}:${hit.line}` : hit.path;
		const element = button("", "search-hit", () => openDoc(hit.path, { line: hit.line }).catch(fail));
		element.append(node("strong", "", name));
		if (hit.preview) element.append(node("small", "", hit.preview.trim()));
		tagTarget(element, { kind: "file", key: hit.path });
		fragment.append(element);
	}
	$("search-results").replaceChildren(fragment);
}

function openSearch() {
	activateNav("search", true);
	if ($("search-kind").value !== "paths") {
		$("search-kind").value = "paths";
		searchSoon(true);
	}
	$("search-input").select();
}

async function refreshGit() {
	const stamp = ++gitVersion;
	try {
		const draft = active();
		const doc = draft && disk(draft.doc) ? draft.doc : undefined;
		const state = await api("git", { doc });
		if (stamp !== gitVersion) return;
		git = state;
		const fragment = document.createDocumentFragment();
		fragment.append(
			node("p", "muted", state.repo === false ? "No Git repository in this folder" : state.branch || "Git changes"),
		);
		if (state.repo !== false && !state.files.length) fragment.append(node("p", "muted", "No changed files"));
		if (state.limited) fragment.append(node("p", "muted", "Partial Git results"));
		if (state.repo !== false && doc)
			fragment.append(row(`Diff · ${leaf(doc)}`, "±", () => showDiff(doc), { kind: "file", key: doc }));
		for (const file of state.files) {
			const element = row(file.path, "±", () => showDiff(file.path), { kind: "file", key: file.path });
			element.append(node("span", "git-mark", file.status));
			fragment.append(element);
		}
		$("git-list").replaceChildren(fragment);
		if (directories.has("")) renderTree();
	} catch (error) {
		if (stamp === gitVersion) $("git-list").replaceChildren(node("p", "muted", errorText(error)));
	}
}

async function showDiff(doc: string) {
	const stamp = ++diffVersion;
	const intent = ++openChoice;
	openDiff(doc);
	const visible = () => stamp === diffVersion && intent === openChoice;
	try {
		const result = await api("git", { doc });
		if (visible()) renderDiff(result);
	} catch (error) {
		if (visible()) $("diff-content").textContent = errorText(error);
	}
}

function openDiff(doc: string) {
	rememberView();
	if (showingView) {
		showingView = undefined;
		++viewEpoch;
		updateViewTabs();
	}
	viewingDiff = true;
	$("find-form").hidden = true;
	$("diff-title").textContent = doc;
	$("diff-content").textContent = "Loading diff…";
	renderWork();
	renderThreads();
	if (smallScreen.matches) panel("files", false);
}

function renderDiff(result: GitInfo) {
	const fragment = document.createDocumentFragment();
	if (result.diff) {
		for (const line of result.diff.split("\n")) fragment.append(node("div", diffClass(line), line || " "));
	} else {
		fragment.append(
			node(
				"div",
				"muted",
				result.repo === false ? "No Git repository for this file" : "No tracked disk diff for this file",
			),
		);
	}
	if (result.limited) fragment.append(node("div", "muted", "Partial diff"));
	$("diff-content").replaceChildren(fragment);
}

function diffClass(line: string) {
	if (line.startsWith("+")) return "diff-add";
	if (line.startsWith("-")) return "diff-del";
	if (line.startsWith("@@")) return "diff-hunk";
	return "";
}

let findCache: { text: string; query: string; offsets: number[] } | undefined;
function findMatches() {
	const text = active()?.text ?? "";
	const query = $("find-input").value;
	if (findCache?.text === text && findCache.query === query) return findCache.offsets;
	const offsets = [];
	if (query) {
		for (let at = text.indexOf(query); at !== -1; at = text.indexOf(query, at + query.length)) offsets.push(at);
	}
	findCache = { text, query, offsets };
	return offsets;
}

function updateFindCount() {
	if ($("find-form").hidden) return;
	const hits = findMatches();
	const selected = hits.indexOf(source.selectionStart);
	const match = selected !== -1 && source.selectionEnd - source.selectionStart === $("find-input").value.length;
	$("find-result").textContent = hits.length
		? match
			? `${selected + 1} / ${hits.length}`
			: `${hits.length} matches`
		: $("find-input").value
			? "No matches"
			: "";
}

function findNext(previous = false, fromCurrent = false) {
	const hits = findMatches();
	if (!hits.length) {
		updateFindCount();
		return;
	}
	const from = source.selectionStart;
	const start = previous
		? (hits.findLast((at) => at < from) ?? hits.at(-1))
		: (hits.find((at) => (fromCurrent ? at >= from : at > from)) ?? hits[0]);
	if (start === undefined) return;
	editorView.setRange(start, start + $("find-input").value.length, false);
	updateFindCount();
}

function showFind() {
	if (!active() || viewingDiff) return;
	const field = $("find-input");
	$("find-form").hidden = false;
	const selected = source.value.slice(source.selectionStart, source.selectionEnd);
	if (selected && !selected.includes("\n")) field.value = selected;
	field.focus();
	field.select();
	updateFindCount();
}

function closeFind() {
	$("find-form").hidden = true;
	if (active() && !viewingDiff) source.focus({ preventScroll: true });
}

function tagTarget(element: HTMLElement, target: Target) {
	element.dataset.targetKind = target.kind;
	element.dataset.targetKey = target.key;
}

const paneLabels: Record<string, string> = {
	files: "Files pane",
	editor: "Editor pane",
	tabs: "Tab strip",
	threads: "Threads pane",
	diff: "Git diff pane",
};
const settingLabels: Record<string, string> = { "line-numbers": "Line numbers" };

function targetName(target: Target) {
	if (target.kind === "pane") return paneLabels[target.key] ?? target.key;
	if (target.kind === "setting") return settingLabels[target.key] ?? target.key;
	if (target.kind === "view") return views.find((view) => view.id === target.key)?.title ?? "Agent view";
	if (target.kind === "tab")
		return (
			tabs.get(target.key)?.title ??
			documents.find((doc) => doc.doc === target.key)?.title ??
			(disk(target.key) ? target.key : "Scratch tab")
		);
	return target.key || "Workspace folder";
}

function captureSelection(at?: number): Selection | null {
	const draft = active();
	if (!draft || viewingDiff) return null;
	if (draft.composing) {
		tell("Finish entering the current text before you create a thread.", true);
		return null;
	}
	rememberView();
	const { start, end } = rangeAt(draft.text, draft.start, draft.end, at);
	if (start !== draft.start || end !== draft.end) editorView.setRange(start, end, false);
	const offsets = editorView.offsets();
	const first = lineIndex(offsets, start);
	return {
		doc: draft.doc,
		rev: draft.rev,
		text: draft.text,
		change: draft.change,
		start,
		end,
		line: first + 1,
		column: start - offsets[first] + 1,
		last: lineIndex(offsets, Math.max(start, end - 1)) + 1,
		title: draft.title || draft.doc,
	};
}

function anchorName(anchor: Anchor) {
	if (anchor.target) return targetName(anchor.target);
	const lines =
		anchor.last > anchor.line ? `Lines ${anchor.line}–${anchor.last}` : `Line ${anchor.line}, column ${anchor.column}`;
	return `${anchor.title} · ${lines}`;
}

function dismissPopup(popup: BrowserPopup, restore = false) {
	if (popup.hidden) return;
	popup.hidden = true;
	if (restore) popup.returnFocus?.focus({ preventScroll: true });
	popup.returnFocus = null;
	if (popup.id === "context-menu") contextTarget = undefined;
	else $("settings").setAttribute("aria-expanded", "false");
}

function locatePopup(popup: BrowserPopup, x: number, y: number, returnFocus: HTMLElement | null) {
	popup.returnFocus = returnFocus;
	popup.hidden = false;
	popup.style.left = `${Math.max(6, Math.min(x, innerWidth - popup.offsetWidth - 6))}px`;
	popup.style.top = `${Math.max(6, Math.min(y, innerHeight - popup.offsetHeight - 6))}px`;
}

function contextMenu(event: MouseEvent | KeyboardEvent) {
	const target = event.target;
	if (!(target instanceof HTMLElement)) return;
	const keyboard = event instanceof KeyboardEvent || (event.clientX === 0 && event.clientY === 0 && event.button === 0);
	const anchor = findContextAnchor(target, event, keyboard);
	if (!anchor) return;
	event.preventDefault();
	contextTarget = anchor;
	$("context-label").textContent = anchorName(anchor);
	const box = target.getBoundingClientRect();
	const x = keyboard || !(event instanceof MouseEvent) ? box.left + Math.min(12, box.width) : event.clientX;
	const y = keyboard || !(event instanceof MouseEvent) ? box.top + Math.min(30, box.height) : event.clientY;
	const focus = document.activeElement;
	locatePopup($("context-menu"), x, y, focus instanceof HTMLElement ? focus : null);
	$("context-note").focus({ preventScroll: true });
}

function findContextAnchor(target: HTMLElement, event: MouseEvent | KeyboardEvent, keyboard: boolean): Anchor | null {
	if (target === source && !viewingDiff) {
		if (keyboard || !(event instanceof MouseEvent)) return captureSelection(source.selectionStart);
		const previous = pointerAnchor;
		pointerAnchor = undefined;
		if (previous?.doc === current && previous && previous.change === active()?.change) {
			source.setSelectionRange(previous.start, previous.end, previous.direction);
		}
		return captureSelection(editorView.point(event.clientX, event.clientY));
	}
	const marked = target.closest<HTMLElement>("[data-target-kind]");
	const kind = marked?.dataset.targetKind as Target["kind"] | undefined;
	const key = marked?.dataset.targetKey;
	return kind && key !== undefined ? { target: { kind, key } } : null;
}

function beginNote(anchor: Anchor | null | undefined, toAgent = false) {
	if (!anchor) return;
	noteAnchor = anchor;
	engaging = toAgent;
	panel("threads", true);
	const quote = anchor.target ? "" : anchor.text.slice(anchor.start, anchor.end);
	$("anchor-label").textContent = anchorName(anchor);
	$("anchor-quote").hidden = !quote;
	$("anchor-quote").textContent = quote.length > 270 ? `${quote.slice(0, 270)}…` : quote;
	$("new-target").value = "";
	$("desk-compose").hidden = false;
	refreshMembers();
	renderRecipient("new");
	(toAgent ? $("new-target") : $("note-text")).focus({ preventScroll: true });
	$("desk").scrollTop = 0;
}

function closeComposer() {
	noteAnchor = undefined;
	engaging = false;
	$("desk-compose").hidden = true;
	$("note-text").value = "";
}

const fileScope = (thread: Scope) => {
	if (showAllThreads) return true;
	const target = thread.target;
	if (showingView) return target?.kind === "view" && target.key === showingView.id;
	if (viewingDiff) return target?.kind === "pane" && target.key === "diff";
	if (!current) return true;
	return target ? (target.kind === "file" || target.kind === "tab") && target.key === current : thread.doc === current;
};

let listKey: string | undefined;
function renderThreads() {
	const rows = threads.filter(fileScope);
	const location = showingView?.title ?? (viewingDiff ? "Git diff" : active()?.title);
	$("desk-location").textContent = !showAllThreads && location ? location : "Workspace threads";
	$("desk-scope").textContent = showAllThreads ? "This tab" : "All files";
	$("desk-scope").disabled = !location;
	$("thread-count").textContent = rows.length ? String(rows.length) : "";
	$("desk-action").hidden = !!threadId;
	$("thread-entries").hidden = !!threadId;
	$("thread-detail").hidden = !threadId;
	if (!threadId) renderThreadList(rows);
}

function renderThreadList(rows: ThreadHeader[]) {
	const key = JSON.stringify([threadsLimited, rows]);
	if (key === listKey) return;
	listKey = key;
	const parent = $("thread-entries");
	const focus = parent.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.thread : null;
	const fragment = document.createDocumentFragment();
	if (!rows.length) fragment.append(node("p", "muted", "No threads here yet."));
	if (threadsLimited) fragment.append(node("p", "muted", "Recent threads only"));
	for (const thread of rows) fragment.append(threadListItem(thread));
	parent.replaceChildren(fragment);
	if (focus)
		[...parent.querySelectorAll("button")]
			.find((element) => element.dataset.thread === focus)
			?.focus({ preventScroll: true });
}

function threadListItem(thread: ThreadHeader) {
	const count = thread.messageCount;
	const owner = thread.target ? targetName(thread.target) : docTitle(thread.doc);
	const item = button("", "thread-row", () => openThread(thread.id));
	item.dataset.thread = thread.id;
	item.append(
		node("strong", "", thread.preview || thread.quote || "New thread"),
		node("span", "", `${owner} · ${count} ${count === 1 ? "message" : "messages"}`),
	);
	return item;
}

function docTitle(doc: string) {
	return tabs.get(doc)?.title ?? documents.find((entry) => entry.doc === doc)?.title ?? doc;
}

const replyDrafts = new Map<string, { text: string; target: string }>();
let notePosting = false;
const replyPosting = new Set<string>();

function openThread(id: string, focus = true) {
	if (focus) panel("threads", true);
	if (id !== threadId) {
		if (threadId) rememberReply();
		if (threads.some((thread) => thread.id === id && !fileScope(thread))) showAllThreads = true;
		threadId = id;
		threadDetail = undefined;
		const saved = replyDrafts.get(id);
		$("reply-text").value = saved?.text ?? "";
		$("reply-target").value = saved?.target ?? "";
		$("thread-anchor").textContent = "Loading thread…";
		$("messages").replaceChildren();
	}
	renderRecipient("reply");
	renderThreads();
	refreshThread();
	if (focus) $("back-to-threads").focus({ preventScroll: true });
}

function rememberReply() {
	if (threadId) replyDrafts.set(threadId, { text: $("reply-text").value, target: $("reply-target").value });
}

function closeThread(focus = false) {
	const previous = threadId;
	rememberReply();
	threadId = threadDetail = undefined;
	threadFlight = null;
	renderThreads();
	if (focus)
		(
			[...$("thread-entries").querySelectorAll("button")].find((row) => row.dataset.thread === previous) ??
			$("add-note")
		).focus({ preventScroll: true });
}

function refreshThread() {
	const id = threadId;
	if (!id || threadFlight?.id === id) return;
	const flight = { id };
	threadFlight = flight;
	api("thread", { id })
		.then((thread) => {
			if (threadFlight !== flight || threadId !== id) return;
			const previous = threadDetail;
			threadDetail = thread;
			if (!previous || threadOriginChanged(previous, thread) || previous.quote !== thread.quote)
				renderThreadAnchor(thread);
			const fragment = document.createDocumentFragment();
			for (const message of thread.messages.slice(previous?.messages.length ?? 0)) {
				const item = node("li");
				item.append(node("strong", "", message.author), node("p", "", message.text));
				fragment.append(item);
			}
			$("messages").append(fragment);
			renderRecipient("reply");
		})
		.catch((error) => {
			if (threadFlight === flight && threadId === id) fail(error);
		})
		.finally(() => {
			if (threadFlight === flight) threadFlight = null;
		});
}

function renderThreadAnchor(thread: ThreadDetail) {
	const parent = $("thread-anchor");
	const hadFocus = parent.contains(document.activeElement);
	const target = thread.target;
	parent.replaceChildren(
		target
			? button(targetName(target), "", () => followTarget(target))
			: button(docTitle(thread.doc), "", () => followQuote(thread)),
	);
	if (thread.quote) parent.append(node("blockquote", "", thread.quote));
	if (hadFocus) parent.querySelector("button")?.focus({ preventScroll: true });
}

function followTarget(target: Target) {
	switch (target.kind) {
		case "file":
		case "tab":
			return openDoc(target.key).catch(fail);
		case "view":
			return openView(target.key).catch(fail);
		case "folder":
			return revealFolder(target.key);
		case "setting":
			return showSettings();
		case "pane":
			return revealPane(target.key);
	}
}

async function followQuote(thread: ThreadDetail) {
	try {
		const draft = await openDoc(thread.doc);
		if (!draft) return;
		if (!pending(draft) && matchesThreadAnchor(thread, draft)) editorView.setRange(thread.start, thread.end);
		else tell("This thread refers to an earlier version. The original quote is shown here.", true);
	} catch (error) {
		fail(error);
	}
}

function revealPane(key: string) {
	if (key === "files") {
		panel("files", true);
		$("refresh-files").focus();
	} else if (key === "threads") {
		panel("threads", true);
		$("desk-scope").focus();
	} else if (key === "diff") activateNav("git");
	else if (key === "tabs") $("tabs").querySelector("button")?.focus();
	else if (active()) source.focus({ preventScroll: true });
}

function revealFolder(path: string) {
	activateNav("files");
	const parts = path ? path.split("/") : [];
	for (let i = 1; i <= parts.length; i++) {
		const prefix = parts.slice(0, i).join("/");
		expanded.add(prefix);
		if (!directories.has(prefix)) loadDirectory(prefix).catch(fail);
	}
	renderTree();
}

function refreshMembers() {
	if (!key || membersFlight) return membersFlight;
	membersFlight = api("members")
		.then((result) => {
			if (JSON.stringify(members) === JSON.stringify(result.members)) return;
			members = result.members;
			updateRecipientPicker("new");
			updateRecipientPicker("reply");
		})
		.catch((error) => {
			if (!$("desk").hidden) fail(error);
		})
		.finally(() => {
			membersFlight = null;
		});
	return membersFlight;
}

function updateRecipientPicker(name: Recipient) {
	const select = $(`${name}-target`);
	const old = select.value;
	const existing = [...select.options].slice(1);
	const options = members.map((member) => memberOption(existing, member));
	if (old && !members.some((entry) => entry.id === old)) {
		const disconnected = node("option", "", `${select.selectedOptions[0]?.textContent} (left)`);
		disconnected.value = old;
		disconnected.disabled = true;
		options.push(disconnected);
	}
	for (const previous of existing) if (!options.includes(previous)) previous.remove();
	for (const [at, option] of options.entries()) {
		if (select.options[at + 1] !== option) select.insertBefore(option, select.options[at + 1] ?? null);
	}
	select.value = old;
	renderRecipient(name);
}

function memberOption(existing: HTMLOptionElement[], member: Member) {
	const option = existing.find((item) => item.value === member.id) ?? node("option");
	option.value = member.id;
	option.textContent = `${member.label} · ${member.kind === "durable" ? "Durable" : "Ordinary"}`;
	option.disabled = false;
	return option;
}

function renderRecipient(name: Recipient) {
	const target = $(`${name}-target`).value;
	const isNote = name === "new";
	const needsTarget = isNote && engaging;
	const connected = members.some((member) => member.id === target);
	const control = isNote ? $("post-note") : $("post-reply");
	const busy = isNote ? notePosting : !threadDetail || replyPosting.has(threadDetail.id);
	const unassigned = target ? !connected : needsTarget;
	control.textContent = target || needsTarget ? "Send" : isNote ? "Post note" : "Post reply";
	control.disabled = busy || unassigned;
	$(`${name}-target-hint`).textContent = recipientHint(needsTarget, target, connected);
}

function recipientHint(needsTarget: boolean, target: string, connected: boolean) {
	if (needsTarget && !members.length) return "No sessions connected. Use the editor tool to join from Pi.";
	if (target && !connected) return "That session left this folder.";
	return "";
}

async function noteInput(anchor: Anchor, text: string): Promise<ApiOps["note"][0]> {
	if (anchor.target) return { target: anchor.target, text };
	const draft = tabs.get(anchor.doc);
	if (!draft) throw new Error("Open the document and select the text again before you post.");
	const rev = await beforeRevision(draft, anchor);
	return { doc: anchor.doc, rev, start: anchor.start, end: anchor.end, text };
}

function showPostedNote(id: string, anchor: Anchor, message: string, retryTarget?: string) {
	if (anchor !== noteAnchor || $("note-text").value !== message) return;
	const hadFocus = $("desk-compose").contains(document.activeElement);
	closeComposer();
	if (!fileScope(anchor)) showAllThreads = true;
	if (retryTarget) replyDrafts.set(id, { text: message, target: retryTarget });
	openThread(id, hadFocus && !$("desk").hidden);
}

async function postNote() {
	const anchor = noteAnchor;
	const message = $("note-text").value;
	const to = $("new-target").value;
	if (!anchor || !message.trim() || notePosting || (engaging && !to)) return;
	notePosting = true;
	renderRecipient("new");
	let id: string | undefined;
	try {
		const result = await api("note", await noteInput(anchor, message));
		id = result.id;
		const receipt = to ? await api("send", { id, to, message }) : null;
		showPostedNote(id, anchor, message);
		announceDelivery(receipt, "Note posted");
	} catch (error) {
		if (id) {
			showPostedNote(id, anchor, message, to);
			tell(`Note posted. ${errorText(error)} Check the thread before you send again.`, true);
		} else if (error instanceof RequestError && error.code === "network") {
			tell(`${errorText(error)} Check the thread list before you post again.`, true);
		} else fail(error);
	} finally {
		notePosting = false;
		renderRecipient("new");
		refreshState();
	}
}

async function postReply() {
	const id = threadId;
	const field = $("reply-text");
	const content = field.value;
	const to = $("reply-target").value;
	if (!id || !content.trim() || replyPosting.has(id)) return;
	replyPosting.add(id);
	renderRecipient("reply");
	try {
		const receipt = to ? await api("send", { id, to, message: content }) : null;
		if (!to) await api("reply", { id, text: content });
		const cache = replyDrafts.get(id);
		if (cache?.text === content) replyDrafts.delete(id);
		if (threadId === id) {
			if (field.value === content) field.value = "";
			refreshThread();
		}
		announceDelivery(receipt, "Reply posted");
	} catch (error) {
		tell(`${errorText(error)} Check the thread before you send again.`, true);
		if (threadId === id) refreshThread();
	} finally {
		replyPosting.delete(id);
		renderRecipient("reply");
		refreshState();
	}
}

function announceDelivery(receipt: ApiOps["send"][1] | null, fallback: string) {
	if (receipt?.warning) tell(receipt.warning, true);
	else tell(receipt ? "Session accepted the task" : fallback);
}

function renderViewList() {
	const container = $("view-list");
	const focus = container.contains(document.activeElement)
		? (document.activeElement as HTMLElement).dataset.targetKey
		: null;
	const fragment = document.createDocumentFragment();
	if (views.length) fragment.append(node("div", "draft-heading", "Agent views"));
	for (const entry of views) {
		fragment.append(row(entry.title, "◇", () => openView(entry.id).catch(fail), { kind: "view", key: entry.id }));
		const tab = viewTabs.get(entry.id);
		if (tab) tab.label.textContent = entry.title;
	}
	container.replaceChildren(fragment);
	if (focus)
		[...container.querySelectorAll("button")]
			.find((element) => element.dataset.targetKey === focus)
			?.focus({ preventScroll: true });
}

function updateViewTabs() {
	for (const [id, entry] of viewTabs) {
		entry.tab.classList.toggle("current", showingView?.id === id);
		entry.pick.setAttribute("aria-current", String(showingView?.id === id));
	}
}

function attachViewTab(header: ViewHeader) {
	if (viewTabs.has(header.id)) return;
	const tab = node("div", "tab");
	const pick = button("", "tab-open", () => openView(header.id).catch(fail));
	const label = node("span", "tab-label", header.title);
	pick.append(node("span", "view-glyph", "◇"), label);
	const close = button("×", "close", () => {
		++openChoice;
		if (showingView?.id === header.id) activate(current);
		viewTabs.delete(header.id);
		tab.remove();
	});
	close.setAttribute("aria-label", `Close ${header.title}`);
	const target: Target = { kind: "view", key: header.id };
	tagTarget(pick, target);
	tagTarget(tab, target);
	tab.append(pick, close);
	$("tabs").append(tab);
	viewTabs.set(header.id, { tab, pick, label });
}

async function openView(id: string) {
	if (showingView?.id === id) return;
	const intent = ++openChoice;
	const header = views.find((item) => item.id === id);
	if (!header && !viewTabs.has(id)) throw new Error("This agent view is not available.");
	rememberView();
	viewingDiff = false;
	++diffVersion;
	const view = { id, title: header?.title ?? viewTabs.get(id)?.label.textContent ?? "Agent view", rev: -1 };
	showingView = view;
	++viewEpoch;
	attachViewTab(view);
	const doc = current === undefined ? undefined : tabs.get(current);
	if (doc) updateTab(doc);
	updateViewTabs();
	$("find-form").hidden = true;
	if (threadId && !showAllThreads) closeThread();
	const surface = $("agent-view");
	tagTarget(surface, { kind: "view", key: id });
	surface.replaceChildren(node("p", "muted", "Loading agent view…"));
	renderWork();
	renderThreads();
	if (smallScreen.matches) panel("files", false);
	if (intent === openChoice) refreshView(view);
}

let loadingView: { view: ViewHeader; epoch: number } | null;
let viewModule: Promise<typeof import("./view.ts")> | null;
function refreshView(view: ViewHeader) {
	if (loadingView?.view === view) return;
	const task = { view, epoch: viewEpoch };
	loadingView = task;
	viewModule ??= import("./view.ts").catch((error) => {
		viewModule = null;
		throw error;
	});
	Promise.all([api("view", { id: view.id }), viewModule])
		.then(([result, { renderView }]) => {
			if (viewEpoch !== task.epoch || showingView !== view || result.rev < view.rev) return;
			const surface = $("agent-view");
			renderView(surface, result, { openLocation: (doc, line) => openDoc(doc, { line }).catch(fail) });
			Object.assign(view, { title: result.title, rev: result.rev });
			const label = viewTabs.get(view.id)?.label;
			if (label) label.textContent = view.title;
			renderWork();
			renderThreads();
		})
		.catch((error) => {
			if (viewEpoch !== task.epoch || showingView !== view) return;
			if (view.rev < 0)
				$("agent-view").replaceChildren(
					node("p", "muted", "The agent view did not load."),
					button("Retry", "", () => refreshView(view)),
				);
			fail(error);
		})
		.finally(() => {
			if (loadingView === task) loadingView = null;
		});
}

function showSettings() {
	const trigger = $("settings");
	const popup = $("settings-menu");
	const box = trigger.getBoundingClientRect();
	locatePopup(popup, box.right - 205, box.bottom + 6, trigger);
	trigger.setAttribute("aria-expanded", "true");
	$("show-lines").focus({ preventScroll: true });
}

async function createDoc(path?: string) {
	const intent = ++openChoice;
	const input = interaction;
	const record = await api("new", path ? { path } : {});
	const draft = addTab(record);
	if (intent === openChoice && input === interaction) activate(draft.doc);
	refreshState();
}

function choosePath(mode: PathMode, draft?: DraftBuffer) {
	pathMode = mode;
	pathDraft = draft;
	$("path-title").textContent = mode === "save" ? "Save As" : "New file";
	$("confirm-path").textContent = mode === "save" ? "Save new file" : "Create draft";
	$("dialog-scratch").hidden = mode === "save";
	$("path-hint").textContent =
		mode === "save"
			? "Save to a path that does not already exist."
			: "Start a draft. Save when you want to write to disk.";
	$("path-input").value = "";
	$("path-dialog").showModal();
	$("path-input").focus();
}

function saveCurrent(saveAs = false) {
	const draft = active();
	if (!draft || viewingDiff || draft.saving || draft.blocked) return;
	if (saveAs || !disk(draft.doc)) choosePath("save", draft);
	else saveDraft(draft).catch(fail);
}

let pointerAnchor:
	| { doc: string; change: number; start: number; end: number; direction: "forward" | "backward" | "none" }
	| undefined;
function shortcut(event: KeyboardEvent) {
	const { key: pressed, shiftKey: shift, target } = event;
	if (!(target instanceof HTMLElement)) return;
	if (pressed === "Escape") {
		escapeControl(target);
		return;
	}
	if (pressed === "ContextMenu" || (pressed === "F10" && shift)) {
		contextMenu(event);
		return;
	}
	if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing || $("path-dialog").open) return;
	const action = editingShortcut(pressed.toLowerCase(), target, shift);
	if (action) {
		event.preventDefault();
		action();
	}
}

function escapeControl(target: HTMLElement) {
	if (!$("context-menu").hidden) dismissPopup($("context-menu"), true);
	else if (!$("settings-menu").hidden) dismissPopup($("settings-menu"), true);
	else if (!$("find-form").hidden && $("find-form").contains(target)) closeFind();
}

function editingShortcut(keyName: string, target: HTMLElement, shift: boolean) {
	if (keyName === "s") return () => saveCurrent(shift);
	if (keyName === "p") return openSearch;
	if (keyName === "f" && active() && !$("desk").contains(target)) return showFind;
	if (keyName === "enter" && shift && active() && target === source) return () => beginNote(captureSelection());
}

source.addEventListener("input", () => {
	editInput();
	updateFindCount();
});
source.addEventListener("compositionstart", () => {
	const draft = active();
	if (draft) draft.composing = true;
});
source.addEventListener("compositionend", () => {
	const draft = active();
	if (!draft) return;
	draft.composing = false;
	editInput();
	if (!draft.blocked && pending(draft)) queuePatch(draft);
});
source.addEventListener("pointerdown", (event) => {
	const draft = active();
	pointerAnchor =
		(event.button === 2 || (event.button === 0 && event.ctrlKey)) && draft
			? {
					doc: draft.doc,
					change: draft.change,
					start: source.selectionStart,
					end: source.selectionEnd,
					direction: source.selectionDirection,
				}
			: undefined;
});
source.addEventListener("scroll", requestPaint);
source.addEventListener("select", () => {
	rememberView();
	requestPaint();
	updateFindCount();
});
source.addEventListener("keyup", requestPaint);
source.addEventListener("click", requestPaint);
numbers.addEventListener("focusout", requestPaint);
document.addEventListener("contextmenu", contextMenu);
document.addEventListener(
	"input",
	() => {
		interaction++;
	},
	true,
);
document.addEventListener("keydown", (event) => {
	interaction++;
	shortcut(event);
});
document.addEventListener("pointerdown", (event) => {
	interaction++;
	if (!(event.target instanceof Node)) return;
	if (!$("context-menu").contains(event.target)) dismissPopup($("context-menu"));
	if (!$("settings-menu").contains(event.target) && event.target !== $("settings")) dismissPopup($("settings-menu"));
});
window.addEventListener("focus", () => {
	nextDiskCheck = 0;
	refreshState();
});
window.addEventListener("online", () => {
	refreshState();
});
window.addEventListener("offline", () => status("Connection lost", true));
window.addEventListener("beforeunload", (event) => {
	if (
		[...tabs.values()].some((draft) => pending(draft) || !!draft.flight) ||
		$("note-text").value ||
		$("reply-text").value ||
		[...replyDrafts.values()].some((draft) => draft.text)
	) {
		event.preventDefault();
		event.returnValue = "";
	}
});
document.addEventListener("visibilitychange", () => {
	if (!document.hidden) nextDiskCheck = 0;
	startPolling();
});
smallScreen.addEventListener("change", () => {
	if (smallScreen.matches && !$("files").hidden && !$("desk").hidden) panel("files", false);
});

for (const [id, kind, key] of [
	["files", "pane", "files"],
	["toggle-files", "pane", "files"],
	["work-body", "pane", "editor"],
	["document-path", "pane", "editor"],
	["tabs", "pane", "tabs"],
	["desk", "pane", "threads"],
	["toggle-threads", "pane", "threads"],
	["diff", "pane", "diff"],
	["setting-lines", "setting", "line-numbers"],
] as const)
	tagTarget($(id), { kind, key });
$("context-note").onclick = () => {
	const target = contextTarget;
	dismissPopup($("context-menu"));
	beginNote(target);
};
$("context-engage").onclick = () => {
	const target = contextTarget;
	dismissPopup($("context-menu"));
	beginNote(target, true);
};
$("toggle-files").onclick = () => panel("files", $("files").hidden);
$("toggle-threads").onclick = () => panel("threads", $("desk").hidden);
$("refresh-files").onclick = () => {
	refreshTree();
	if (currentView === "git") refreshGit();
};
$("quick-open").onclick = $("welcome-open").onclick = openSearch;
$("new").onclick = () => choosePath("new");
$("welcome-new").onclick = () => createDoc().catch(fail);
$("save").onclick = () => saveCurrent();
$("save-as").onclick = () => saveCurrent(true);
$("find").onclick = showFind;
$("find-close").onclick = closeFind;
$("find-prev").onclick = () => findNext(true);
$("find-input").oninput = () => findNext(false, true);
$("find-form").onsubmit = (e) => {
	e.preventDefault();
	findNext();
};
$("search-input").oninput = () => searchSoon();
$("search-kind").onchange = () => searchSoon(true);
$("search-form").onsubmit = (e) => {
	e.preventDefault();
	const hit = $("search-results").querySelector("button");
	if (hit) hit.click();
	else searchSoon(true);
};
$("search-input").onkeydown = (event) => {
	if (event.key === "ArrowDown") {
		event.preventDefault();
		$("search-results").querySelector("button")?.focus();
	}
};
for (const trigger of document.querySelectorAll<HTMLButtonElement>(".rail-modes button"))
	trigger.onclick = () => activateNav(trigger.dataset.view as Nav, true);
$("edit-view").onclick = () => activate(current);
$("recover").onclick = () => recoverDraft().catch(fail);
$("reload").onclick = () => reloadDraft().catch(fail);
$("retry").onclick = () => {
	const draft = active();
	if (draft?.blocked?.kind !== "patch") return;
	draft.blocked = null;
	updateDraft(draft);
	flush(draft).catch(fail);
};
$("settings").onclick = () => ($("settings-menu").hidden ? showSettings() : dismissPopup($("settings-menu"), true));
try {
	$("show-lines").checked = localStorage.getItem("editor-line-numbers") !== "off";
} catch {
	/* Default is visible. */
}
function lineNumberSetting() {
	const enabled = $("show-lines").checked;
	$("editor").classList.toggle("no-numbers", !enabled);
	try {
		localStorage.setItem("editor-line-numbers", enabled ? "on" : "off");
	} catch {
		/* Current view still reflects the setting. */
	}
	requestPaint();
}
$("show-lines").onchange = lineNumberSetting;
$("add-note").onclick = () => {
	if (showingView) beginNote({ target: { kind: "view", key: showingView.id } });
	else if (viewingDiff) beginNote({ target: { kind: "pane", key: "diff" } });
	else beginNote(captureSelection());
};
$("cancel-note").onclick = () => {
	if ($("note-text").value && !confirm("Discard this unposted note?")) return;
	closeComposer();
	$("add-note").focus();
};
$("desk-scope").onclick = () => {
	showAllThreads = !showAllThreads;
	if (threadId) closeThread();
	renderThreads();
};
$("back-to-threads").onclick = () => closeThread(true);
$("new-thread-form").onsubmit = (e) => {
	e.preventDefault();
	postNote();
};
$("reply-form").onsubmit = (e) => {
	e.preventDefault();
	postReply();
};
for (const name of ["new", "reply"] as const) {
	const select = $(`${name}-target`);
	select.onfocus = refreshMembers;
	select.onchange = () => renderRecipient(name);
	select.onpointerdown = refreshMembers;
}
function cancelPath() {
	++openChoice;
	$("path-dialog").close();
}
$("path-dialog").addEventListener("cancel", () => {
	++openChoice;
});
$("cancel-path").onclick = cancelPath;
$("dialog-scratch").onclick = () => {
	$("path-dialog").close();
	createDoc().catch(fail);
};
$("path-form").onsubmit = async (event) => {
	event.preventDefault();
	const input = $("path-input");
	const path = input.value;
	if (!path?.trim()) {
		$("path-hint").textContent = "Enter a path in this folder.";
		return;
	}
	$("confirm-path").disabled = true;
	try {
		if (pathMode === "save") await saveDraft(pathDraft, path);
		else await createDoc(path);
		if ($("path-dialog").open && input.value === path) {
			$("path-dialog").close();
			if (active()?.doc === path) source.focus({ preventScroll: true });
		}
	} catch (error) {
		$("path-hint").textContent = errorText(error);
	} finally {
		$("confirm-path").disabled = false;
	}
};

panel("threads", false);
if (smallScreen.matches && launchFile) panel("files", false);
lineNumberSetting();
renderWork();
renderThreads();
if (!key) status("Open from Pi", true);
else {
	if (launchFile) openDoc(launchFile, { focus: false }).catch(fail);
	refreshMembers();
	loadDirectory("").catch(fail);
	startPolling();
}
