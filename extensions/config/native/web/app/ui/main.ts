import type {
	BridgeCommand,
	BridgeResponse,
	Catalogue,
	EditResult,
	Entry,
	Json,
	Scope,
	ConfigContext,
	ToolsView,
	ValueSchema,
} from "../../../../protocol.ts";
import {
	begin,
	blocker,
	compareResult,
	type Draft,
	display,
	documentFor,
	draftKey,
	pointer,
	responseGate,
	resultLabel,
	type Snapshot,
	scopeLabel,
	searchCatalogue,
	sectionFor,
	stored,
	targetKey,
} from "../core/state.ts";
import { editor, initialValue, parseValue } from "../form/control.ts";
import { button, el, id, message, option } from "./dom.ts";
import { entryRow } from "./entry.ts";

const search = id<HTMLInputElement>("search");
const scopeInput = id<HTMLSelectElement>("scope");
const body = id("body");
const dialog = id<HTMLDialogElement>("dialog");
const dialogBody = id("dialog-body");
const review = id<HTMLButtonElement>("review");
const revert = id<HTMLButtonElement>("revert");
const save = id<HTMLButtonElement>("save");
const parameters = new URLSearchParams(location.search);
const fixture = parameters.has("fixture");
const liveCheck = parameters.has("check");
type Recovery = { id: string; snapshot: Snapshot };
type Event = { type: "changed" | "disconnected" | "cancel" | "close" } | { type: "command"; command: BridgeCommand };
const host = window as Window & {
	webkit?: { messageHandlers?: { config?: { postMessage: (value: unknown) => Promise<unknown> } } };
	configEvent?: (event: Event) => void;
};
/**
 * The native shell forwards `body` as text and returns replies that carry settings as `json` text. Its own JSON
 * objects do not keep member order, and member order is part of a value that reaches the file.
 */
async function call<T>(op: string, payload: Record<string, unknown> = {}): Promise<T> {
	if (fixture) return (await (await import("../../dev/bridge.ts")).fixtureMessage(op, payload)) as T;
	const handler = host.webkit?.messageHandlers?.config;
	if (!handler) throw new Error("Open Config from a Pi session.");
	const reply = await handler.postMessage({ op, body: JSON.stringify(payload) });
	const text = reply !== null && typeof reply === "object" ? (reply as { json?: unknown }).json : undefined;
	return (typeof text === "string" ? JSON.parse(text) : reply) as T;
}

let context: ConfigContext | undefined;
let catalogue: Catalogue | undefined;
let tools: ToolsView | undefined;
let label = "";
let connected = false;
let busy = false;
let toolsBusy = false;
let closing = false;
let interrupted = false;
let scope: "global" | "project" = "global";
let section = "";
let activity = "";
let buildOld = false;
let retentionError = "";
let recoveries: Recovery[] = [];
let retention = Promise.resolve(true);
let rerender = false;
const drafts = new Map<string, Draft>();
const details = new Set<string>();
const catalogueGate = responseGate();
const toolsGate = responseGate();
const keyOf = (draft: Draft) => draftKey(draft.change.id, draft.change.scope);
const currentTarget = () => (context ? targetKey(context) : "");

function persist(): Promise<boolean> {
	const snapshot: Snapshot = { version: 1, drafts: [...drafts.values()], interrupted };
	retention = retention.then(async () => {
		try {
			await call("draftSave", { snapshot: JSON.stringify(snapshot) });
			retentionError = "";
			return true;
		} catch (error) {
			retentionError = `Draft recovery failed: ${message(error)}`;
			return false;
		} finally {
			paintStatus();
		}
	});
	return retention;
}
function changeDraft(draft: Draft): void {
	if (busy || closing) return;
	drafts.set(keyOf(draft), draft);
	activity = "";
	void persist();
	paintStatus();
}
function dropDraft(draft: Draft): void {
	if (busy || closing) return;
	drafts.delete(keyOf(draft));
	void persist();
	paint();
}
function paintStatus(): void {
	id("pending").textContent =
		drafts.size === 0 ? "No pending changes" : `${drafts.size} pending ${drafts.size === 1 ? "change" : "changes"}`;
	id("notice").textContent =
		retentionError ||
		activity ||
		(interrupted
			? "Check current stored values before you retry an interrupted save."
			: buildOld
				? "Older build. Reopen Config for the update."
				: "");
	const disabled = busy || closing;
	review.disabled = disabled || (!drafts.size && !recoveries.length);
	revert.disabled = disabled || !drafts.size;
	save.disabled =
		disabled ||
		!connected ||
		!catalogue ||
		!drafts.size ||
		[...drafts.values()].some((draft) => blocker(draft, catalogue as Catalogue) !== undefined);
	review.textContent = !drafts.size && recoveries.length ? "Recover drafts" : "Review";
	save.textContent = busy ? "Working…" : "Save";
}

const advancedLabels: Record<string, string> = {
	"advanced:deprecated": "Deprecated",
	"advanced:internal": "Internal",
	"advanced:unregistered": "Unregistered",
	"advanced:unmanaged": "Unmanaged extensions",
};
let advancedOpen = false;
function sections() {
	const groups = new Map<string, { key: string; label: string; group: string }>();
	for (const entry of catalogue?.entries ?? []) {
		const key = sectionFor(entry);
		if (key === "custom" || key === "tools") continue;
		groups.set(key, {
			key,
			label: advancedLabels[key] ?? (entry.group === "pi" ? entry.category : entry.owner),
			group: advancedLabels[key] ? "Advanced" : entry.group === "pi" ? "Pi" : "Extensions",
		});
	}
	return [...groups.values()]
		.sort((a, b) => a.label.localeCompare(b.label))
		.concat([
			{ key: "custom", label: "Custom values", group: "Workspace" },
			{ key: "tools", label: "Tools", group: "Workspace" },
		]);
}
function select(key: string): void {
	section = key;
	if (key.startsWith("advanced:")) advancedOpen = true;
	search.value = "";
	paint();
	body.closest("main")?.scrollTo(0, 0);
	if (key === "tools") void refreshTools();
}
function heading(title: string, description: string, extra?: HTMLElement): void {
	const text = el("div");
	text.append(el("h1", title), el("p", description));
	id("heading").replaceChildren(text, ...(extra ? [extra] : []));
}
function paint(): void {
	paintStatus();
	if (!catalogue) return;
	const all = sections();
	if (!all.some((item) => item.key === section))
		section = all.find((item) => item.key === "pi:General")?.key ?? all[0]?.key ?? "custom";
	const current = all.find((item) => item.key === section);
	const query = search.value.trim();
	paintNav(all, query);
	const activeRow = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.row : undefined;
	body.setAttribute("aria-busy", "false");
	body.replaceChildren();
	const readOnly = !connected || busy || closing;
	if (!query && section === "tools") {
		heading("Tools", "Choose what this session offers to the model.");
		paintTools(readOnly);
		restoreRowFocus(activeRow);
		return;
	}
	const entries = query
		? searchCatalogue(catalogue.entries, query)
		: catalogue.entries.filter((entry) => sectionFor(entry) === section);
	paintHeading(query, entries, current, readOnly, catalogue);
	for (const entry of entries) body.append(rowFor(entry, readOnly));
	restoreRowFocus(activeRow);
	if (!entries.length)
		body.append(
			el(
				"p",
				query ? "No settings match. Try a label, exact key or extension name." : "No values in this section.",
				"empty",
			),
		);
}
function rowFor(entry: Entry, readOnly: boolean): HTMLElement {
	const cat = catalogue as Catalogue;
	const destination = entry.group === "pi" ? scope : "machine";
	const current = drafts.get(draftKey(entry.id, destination));
	const detailKey = entry.id;
	return entryRow({
		entry,
		catalogue: cat,
		scope: destination,
		draft: current,
		issue: current && blocker(current, cat),
		readOnly,
		open: details.has(detailKey),
		showDetails: (open) => {
			if (open) details.add(detailKey);
			else details.delete(detailKey);
		},
		getDraft: (target) => drafts.get(draftKey(entry.id, target)),
		edit: (rawText, error) => editDraft(entry, destination, cat.context, rawText, error),
		act: (action, target) => {
			const existing = drafts.get(draftKey(entry.id, target));
			const draft = existing ?? begin(entry, target, cat.context, action);
			changeDraft({
				...draft,
				rawText: undefined,
				error: undefined,
				change: { ...draft.change, action, value: undefined },
			});
			paint();
		},
		drop: () => {
			if (current) dropDraft(current);
		},
	});
}
function editDraft(entry: Entry, target: Scope, context: ConfigContext, rawText: string, error?: string): void {
	const draft = drafts.get(draftKey(entry.id, target)) ?? begin(entry, target, context, "set");
	const parsed = parseValue(
		rawText,
		entry.raw || entry.kind === "unregistered" ? { type: "json" } : (draft.valueSchema ?? entry.value),
	);
	changeDraft({
		...draft,
		rawText,
		error: error ?? ("error" in parsed ? parsed.error : undefined),
		change: { ...draft.change, action: "set", value: "value" in parsed ? parsed.value : undefined },
	});
}

function paintTools(readOnly: boolean): void {
	body.append(el("h2", "This session", "subheading"));
	paintSessionTools(readOnly);
	body.append(el("h2", "Pi tool settings", "subheading"));
	for (const entry of catalogue?.entries ?? []) if (sectionFor(entry) === "tools") body.append(rowFor(entry, readOnly));
}
function paintSessionTools(readOnly: boolean): void {
	if (!tools) {
		body.append(el("p", "Waiting for the tool list from Pi.", "empty"));
		return;
	}
	if (!tools.session && tools.reason) body.append(el("p", tools.reason, "note"));
	for (const note of tools.notes) body.append(el("p", note, "note"));
	for (const tool of tools.tools) {
		const row = el("article", undefined, "row row-top");
		row.tabIndex = 0;
		row.setAttribute("aria-label", tool.name);
		row.dataset.row = `tool:${tool.name}`;
		const detail = el("div");
		detail.append(el("h2", tool.name), el("p", tool.description, "help"));
		const more = el("details", undefined, "details");
		const exposure = {
			direct: "Direct",
			"model-only": "Model only",
			codemode: "Through Code Mode",
			deferred: "Available through discovery",
			hidden: "Hidden",
		};
		more.append(el("summary", "Details"), el("p", `${exposure[tool.exposure]} · ${tool.source}`, "muted"));
		detail.append(more);
		const actions = el("div");
		const action = button(
			tool.active ? "Deactivate" : "Activate for session",
			() => void applyTool(tool.name, tool.active),
		);
		action.disabled = readOnly || toolsBusy || !tools.session;
		actions.append(el("p", tool.active ? "Active for this session" : "Not offered to the model", "muted"), action);
		row.append(detail, actions);
		body.append(row);
	}
}
async function applyTool(name: string, active: boolean): Promise<void> {
	if (!connected || toolsBusy) return;
	toolsBusy = true;
	const target = currentTarget();
	paint();
	try {
		const { result } = await call<BridgeResponse["/tools/apply"]>("toolsApply", {
			change: active ? { deactivate: [name] } : { activate: [name] },
		});
		if (target !== currentTarget() || !connected) return;
		activity = [result.text, ...result.rejected.map(({ name, reason }) => `${name}: ${reason}`)].join(" ");
		await refreshTools();
	} catch (error) {
		activity = message(error);
	} finally {
		toolsBusy = false;
		paint();
	}
}
async function refreshTools(): Promise<void> {
	if (!connected) return;
	const ticket = toolsGate.issue(currentTarget());
	try {
		const reply = await call<BridgeResponse["/tools"]>("tools");
		if (!connected || !toolsGate.accepts(ticket, currentTarget())) return;
		tools = reply.tools;
		if (section === "tools" && !search.value) paint();
	} catch (error) {
		if (connected && toolsGate.accepts(ticket, currentTarget())) {
			activity = message(error);
			paintStatus();
		}
	}
}

function show(title: string, ...nodes: Node[]): void {
	id("dialog-title").textContent = title;
	dialogBody.replaceChildren(...nodes);
	if (!dialog.open) dialog.showModal();
}
function create(custom: boolean): void {
	if (!catalogue || closing || busy || !connected) return;
	const cat = catalogue;
	const destination = custom ? "machine" : scope;
	const file = documentFor(destination, cat.context);
	const form = el("form", undefined, "form");
	const name = el("input");
	name.required = true;
	const input = (label: string, control: HTMLElement) => {
		const container = el("label", label);
		container.append(control);
		return container;
	};
	const type = el("select");
	const kind = ["string", "number", "integer", "boolean", "array", "object", "json"] as const;
	for (const value of kind) type.append(option(value, value[0]?.toUpperCase() + value.slice(1)));
	const description = el("input");
	const field = el("div", undefined, "editor");
	const issue = el("p", undefined, "problem");
	issue.setAttribute("role", "status");
	let valueSchema: ValueSchema = { type: "json" };
	let rawText = "null";
	const configure = () => {
		const selected = kind.find((item) => item === type.value);
		valueSchema =
			!custom || !selected || selected === "json"
				? { type: "json" }
				: selected === "array"
					? { type: "array", items: { type: "json" } }
					: selected === "object"
						? { type: "map", values: { type: "json" } }
						: { type: selected };
		const seed = initialValue(valueSchema);
		rawText = JSON.stringify(seed, null, 2);
		issue.textContent = "";
		field.replaceChildren(
			editor(valueSchema, seed, rawText, "New value", (raw, error) => {
				rawText = raw;
				issue.textContent = error ?? "";
			}),
		);
	};
	configure();
	type.addEventListener("change", configure);
	form.append(input(custom ? "Name" : "Key or JSON pointer", name));
	if (custom) form.append(input("Type", type), input("Description (optional)", description));
	else form.append(el("p", "Enter a top-level key or a JSON pointer to a nested key, such as /section/key.", "help"));
	const submit = el("button", "Add to drafts", "primary");
	submit.type = "submit";
	form.append(el("span", "Value"), field, issue, submit);
	form.addEventListener("submit", (event) => {
		event.preventDefault();
		const parsed = parseValue(rawText, valueSchema);
		if ("error" in parsed) {
			issue.textContent = parsed.error;
			return;
		}
		if (!file?.writable || !name.value.length) return;
		const id = createId(name.value, custom, cat, destination, issue);
		if (!id) return;
		const chosen = kind.find((item) => item === type.value);
		changeDraft({
			label: name.value,
			path: file.path,
			valueSchema,
			rawText,
			change: {
				id,
				scope: destination,
				action: "create",
				base: { present: false },
				value: parsed.value,
				raw: custom ? undefined : true,
				description: custom ? description.value : undefined,
				type: custom ? chosen : undefined,
			},
		});
		dialog.close();
		openReview();
	});
	show(
		custom ? "Add custom value" : `Add Pi key to ${scopeLabel[destination]}`,
		el("p", file?.path ?? "File unavailable", "muted"),
		form,
	);
	name.focus();
}

function openReview(result?: EditResult, batch: Draft[] = [...drafts.values()]): void {
	const nodes: HTMLElement[] = [];
	if (result) nodes.push(el("p", result.summary));
	if (interrupted) {
		const warning = el("div", undefined, "review-line");
		warning.append(
			el("p", "An earlier save did not return a result. Compare the stored values below before you retry.", "note"),
		);
		nodes.push(warning);
	}
	nodes.push(...recoveryRows());
	for (const draft of batch) nodes.push(reviewDraft(draft, result));
	if (!nodes.length) nodes.push(el("p", "There are no drafts to review."));
	if (
		drafts.size &&
		connected &&
		catalogue &&
		![...drafts.values()].some((draft) => blocker(draft, catalogue as Catalogue))
	) {
		const actions = el("div", undefined, "field-actions");
		if (!result || result.mode === "commit") actions.append(button("Validate changes", () => void submit("preview")));
		if (result?.mode === "preview" && (result.outcome === "previewed" || result.outcome === "unchanged"))
			actions.append(button("Save changes", () => void submit("commit"), "primary"));
		nodes.push(actions);
	}
	show(result?.mode === "commit" ? "Save result" : "Review changes", ...nodes);
}
async function recover(recovery: Recovery, keep: boolean): Promise<void> {
	if (keep) {
		if (recovery.snapshot.drafts.some((draft) => drafts.has(keyOf(draft)))) {
			activity =
				"A draft in this pane uses the same setting and scope. Resolve it before you restore the earlier drafts.";
			openReview();
			dialogBody.prepend(el("p", activity, "note"));
			return;
		}
		for (const draft of recovery.snapshot.drafts) drafts.set(keyOf(draft), draft);
		interrupted ||= recovery.snapshot.interrupted === true;
		if (!(await persist())) {
			openReview();
			dialogBody.prepend(el("p", retentionError, "problem"));
			return;
		}
	}
	try {
		await call("draftDiscard", { id: recovery.id });
		recoveries = recoveries.filter((item) => item !== recovery);
	} catch (error) {
		activity = message(error);
	}
	paint();
	openReview();
}
async function submit(mode: "preview" | "commit"): Promise<EditResult | undefined> {
	if (busy || closing || !catalogue || !connected || !drafts.size) return;
	const batch = [...drafts.values()];
	if (batch.some((draft) => blocker(draft, catalogue as Catalogue))) {
		openReview();
		return;
	}
	const target = currentTarget();
	const requestId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	busy = true;
	paint();
	show(mode === "preview" ? "Validate changes" : "Save changes", el("p", "Waiting for Pi…"));
	try {
		if (mode === "commit") await markCommit(target);
		const { result } = await call<BridgeResponse["/edit"]>("edit", {
			request: { requestId, mode, changes: batch.map((draft) => draft.change) },
		});
		if (target !== currentTarget() || result.requestId !== requestId || result.mode !== mode)
			throw new Error("The response did not match this request. Check the stored values before retrying.");
		if (mode === "commit") await settleCommit(batch, result);
		activity = result.summary;
		openReview(result, batch);
		return result;
	} catch (error) {
		activity =
			mode === "commit" && interrupted
				? `${message(error)} Check the stored values before retrying. Your drafts stay here.`
				: message(error);
		openReview();
		dialogBody.prepend(el("p", activity, "problem"));
	} finally {
		busy = false;
		paint();
	}
}

async function refreshCatalogue(): Promise<void> {
	if (!connected) return;
	const ticket = catalogueGate.issue(currentTarget());
	try {
		const response = await call<BridgeResponse["/catalogue"]>("catalogue", { generation: ticket.serial });
		acceptCatalogue(ticket, response);
	} catch (error) {
		if (connected && catalogueGate.accepts(ticket, currentTarget())) {
			activity = `Catalogue unavailable: ${message(error)}`;
			if (!catalogue)
				body.replaceChildren(
					el("p", activity, "empty"),
					button("Retry catalogue", () => void refreshCatalogue()),
				);
			paintStatus();
		}
	}
}
function paintTarget(): void {
	if (!context) return;
	const title = label || context.host.session || (context.host.kind === "durable" ? "Durable session" : "Pi session");
	id("target").textContent = title;
	id("target").title = context.host.session ? `${title} · ${context.host.session}` : title;
	id("cwd").textContent = context.cwd;
	id("cwd").title = context.cwd;
	id("trust").textContent = context.projectTrusted ? "Trusted project" : "Untrusted project";
	scopeInput.disabled = !catalogue;
}
function disconnect(): void {
	connected = false;
	activity = "Session disconnected. Run /config again.";
	if (catalogue) paint();
	else {
		id("target").textContent = "Disconnected";
		body.replaceChildren(el("p", activity, "empty"));
		paintStatus();
	}
}
function reveal(query?: string): void {
	if (query !== undefined) {
		search.value = query;
		paint();
	}
	search.focus();
}
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	paintStatus();
	await retention;
	if (retentionError && drafts.size) {
		closing = false;
		show(
			"Drafts are not protected",
			el("p", retentionError, "problem"),
			button("Retry draft recovery", () => {
				dialog.close();
				void persist();
			}),
			button("Close without a recovery copy", () => void call("close")),
		);
		paintStatus();
		return;
	}
	await call("close");
}
async function start(): Promise<void> {
	const params = new URLSearchParams(location.search);
	if (fixture || liveCheck) document.documentElement.dataset.theme = params.get("theme") ?? "light";
	search.value = params.get("query") ?? "";
	try {
		const reply = await call<BridgeResponse["/connect"]>("connect");
		context = reply.context;
		label = reply.label;
		buildOld = reply.build?.current === false;
		connected = true;
		paintTarget();
		try {
			const result = await call<{ recoveries: { id: string; snapshot: string }[] }>("draftLoad");
			recoveries = result.recoveries
				.flatMap((item): Recovery[] => {
					try {
						return [{ id: item.id, snapshot: JSON.parse(item.snapshot) as Snapshot }];
					} catch {
						return [];
					}
				})
				.filter((item) => item.snapshot?.version === 1 && Array.isArray(item.snapshot.drafts));
		} catch (error) {
			retentionError = `Draft recovery unavailable: ${message(error)}`;
		}
		await refreshCatalogue();
		if (recoveries.length) {
			activity = "Earlier drafts are available for this folder.";
			paintStatus();
		}
		if (catalogue) document.documentElement.dataset.ready = "true";
	} catch {
		disconnect();
	} finally {
		if (!fixture) await call("ready");
	}
}

host.configEvent = (event) => {
	if (closing) return;
	if (event.type === "changed") {
		void refreshCatalogue();
		if (section === "tools") void refreshTools();
	} else if (event.type === "command") reveal(event.command.query);
	else if (event.type === "disconnected") disconnect();
	else if (event.type === "close") void close();
	else dismissActive();
};
body.addEventListener("focusout", () =>
	queueMicrotask(() => {
		if (rerender && !document.activeElement?.closest(".editor")) {
			rerender = false;
			paint();
		}
	}),
);
search.addEventListener("input", () => {
	paint();
	body.closest("main")?.scrollTo(0, 0);
});
scopeInput.addEventListener("change", () => {
	scope = scopeInput.value === "project" ? "project" : "global";
	paint();
});
review.addEventListener("click", () => {
	if (
		connected &&
		catalogue &&
		drafts.size &&
		!recoveries.length &&
		!interrupted &&
		![...drafts.values()].some((draft) => blocker(draft, catalogue as Catalogue))
	)
		void submit("preview");
	else openReview();
});
save.addEventListener("click", () => void submit("commit"));
revert.addEventListener("click", () =>
	show(
		"Revert all drafts?",
		el("p", "This removes unsaved changes in every scope. Saved values stay as they are."),
		button("Keep drafts", () => dialog.close()),
		button("Revert drafts", () => {
			drafts.clear();
			interrupted = false;
			activity = "Drafts reverted.";
			void persist();
			dialog.close();
			paint();
		}),
	),
);
id("dismiss").addEventListener("click", () => dialog.close());
id("close").addEventListener("click", () => void close());
document.addEventListener("keydown", (event) => {
	if (event.isComposing || event.altKey) return;
	if (!(event.metaKey || event.ctrlKey)) {
		navigateRows(event);
		return;
	}
	switch (event.key.toLowerCase()) {
		case "f":
			event.preventDefault();
			if (dialog.open) dialog.close();
			reveal();
			search.select();
			break;
		case "s":
			event.preventDefault();
			if (!save.disabled) void submit("commit");
			break;
		case "w":
			event.preventDefault();
			void close();
			break;
	}
});
if (fixture || liveCheck) installCheckSurface();
void start();

function rows(): HTMLElement[] {
	return Array.from(body.querySelectorAll<HTMLElement>("[data-row]"));
}

function restoreRowFocus(key?: string): void {
	if (key)
		rows()
			.find((row) => row.dataset.row === key)
			?.focus({ preventScroll: true });
}

function dismissActive(): boolean {
	if (dialog.open) {
		dialog.close();
		return true;
	}
	const active = document.activeElement;
	const row = active?.closest<HTMLElement>("[data-row]");
	const disclosure =
		active?.closest<HTMLDetailsElement>("details[open]") ??
		row?.querySelector<HTMLDetailsElement>("details[open]") ??
		body.querySelector<HTMLDetailsElement>("details[open]");
	if (!disclosure) return false;
	disclosure.open = false;
	if (row) row.focus({ preventScroll: true });
	else disclosure.querySelector("summary")?.focus({ preventScroll: true });
	return true;
}

function navigateRows(event: KeyboardEvent): void {
	if (event.key === "Escape" && dismissActive()) {
		event.preventDefault();
		return;
	}
	if (dialog.open || !(event.target instanceof HTMLElement)) return;
	const target = event.target;
	if (target.matches("[data-row]") && event.key === "Enter") {
		const disclosure = target.querySelector<HTMLDetailsElement>("details");
		if (disclosure) {
			event.preventDefault();
			disclosure.open = true;
		}
		return;
	}
	moveRowFocus(event, target);
}

function moveRowFocus(event: KeyboardEvent, target: HTMLElement): void {
	if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
	if (
		target !== search &&
		target !== document.body &&
		!target.matches("[data-row], main, nav button[aria-current=true]")
	)
		return;
	const list = rows();
	const index = list.indexOf(target);
	const step = event.key === "ArrowDown" ? 1 : -1;
	const next = index === -1 && step === -1 ? list.at(-1) : list[Math.max(0, Math.min(index + step, list.length - 1))];
	if (next) {
		event.preventDefault();
		next.focus();
	}
}

function paintNav(all: ReturnType<typeof sections>, query: string): void {
	const nav = id("nav");
	const previousFocus = (document.activeElement as HTMLElement | null)?.dataset.section;
	const menu = el("select");
	menu.id = "narrow-nav";
	menu.setAttribute("aria-label", "Settings section");
	menu.append(option("", query ? "Search results" : "Choose a section"));
	nav.replaceChildren(menu);
	for (const group of ["Pi", "Extensions", "Workspace"])
		appendNavGroup(
			nav,
			menu,
			all.filter((item) => item.group === group),
			group,
			query,
		);
	const advanced = all.filter((item) => item.group === "Advanced");
	if (advanced.length) {
		const disclosure = el("details", undefined, "advanced-nav");
		disclosure.open = advancedOpen;
		disclosure.addEventListener("toggle", () => {
			if (disclosure.isConnected) advancedOpen = disclosure.open;
		});
		const summary = el("summary", "Advanced");
		summary.dataset.section = "advanced";
		disclosure.append(summary);
		nav.append(disclosure);
		appendNavGroup(disclosure, menu, advanced, "Advanced", query);
	}
	menu.value = query ? "" : section;
	menu.dataset.section = "menu";
	menu.addEventListener("change", () => {
		if (menu.value) select(menu.value);
	});
	if (previousFocus)
		Array.from(nav.querySelectorAll<HTMLElement>("[data-section]"))
			.find((item) => item.dataset.section === previousFocus)
			?.focus();
}

function paintHeading(
	query: string,
	entries: Entry[],
	current: ReturnType<typeof sections>[number] | undefined,
	readOnly: boolean,
	catalogue: Catalogue,
): void {
	if (query) {
		heading("Search results", `${entries.length} ${entries.length === 1 ? "setting" : "settings"} match your search.`);
		return;
	}
	if (section === "custom")
		heading(
			"Custom values",
			"Values you name and manage. Pi does not use them automatically.",
			readOnly || !documentFor("machine", catalogue.context)?.writable
				? undefined
				: button("Add value", () => create(true)),
		);
	else if (section === "advanced:unmanaged")
		heading("Unmanaged extensions", "The extension owner is unavailable or its declaration changed.");
	else if (current?.group === "Pi" || section === "advanced:unregistered")
		heading(
			current?.label ?? "Pi",
			`New edits go to Pi ${scopeLabel[scope].toLowerCase()} settings.`,
			addKeyControl(readOnly, catalogue),
		);
	else heading(current?.label ?? "Extensions", "Changes go to machine settings.");
}

function addKeyControl(readOnly: boolean, catalogue: Catalogue): HTMLButtonElement | undefined {
	if (!readOnly && documentFor(scope, catalogue.context)?.writable) return button("Add key", () => create(false));
}

function createId(
	name: string,
	custom: boolean,
	cat: Catalogue,
	destination: Draft["change"]["scope"],
	issue: HTMLElement,
): string | undefined {
	const key = !custom && name.startsWith("/") ? name : pointer([name]);
	if (/~(?![01])/u.test(key)) {
		issue.textContent = "A JSON pointer uses ~0 for ~ and ~1 for /.";
		return;
	}
	const id = `${custom ? "custom" : "pi"}:${key}`;
	if (
		drafts.has(draftKey(id, destination)) ||
		cat.entries.some(
			(entry) => entry.id === id && (custom || entry.kind !== "unregistered" || entry.saved[destination]?.present),
		)
	) {
		issue.textContent = "This key already has an editor or a pending change in this scope.";
		return;
	}

	return id;
}

function recoveryRows(): HTMLElement[] {
	const nodes: HTMLElement[] = [];
	for (const recovery of recoveries) {
		const line = el("div", undefined, "review-line");
		line.append(
			el("h3", "Drafts from a closed Config pane"),
			el("p", recovery.snapshot.drafts.map((draft) => draft.label).join(", ")),
		);
		const actions = el("div", undefined, "field-actions");
		actions.append(
			button("Restore drafts", () => void recover(recovery, true)),
			button("Discard recovery", () => void recover(recovery, false)),
		);
		line.append(actions);
		nodes.push(line);
	}
	return nodes;
}

function reviewDraft(draft: Draft, result?: EditResult): HTMLElement {
	const { scope, action } = draft.change;
	const line = el("div", undefined, "review-line");
	const owner = catalogue?.entries.find((entry) => entry.id === draft.change.id)?.owner;
	const outcome = result ? resultLabel(result, draft, owner) : "Pending change";
	line.append(el("h3", draft.label), el("p", outcome, "result-outcome"));
	const destination = el(
		"p",
		`${scopeLabel[scope]} · ${draft.path.split("/").at(-1) || "File unavailable"}`,
		"muted destination",
	);
	destination.title = draft.path;
	line.append(destination);
	const { change, document } = result ? compareResult(draft, result) : {};
	appendProposedValue(line, draft, action);
	if (draft.change.raw) line.append(el("p", "The owner does not validate this edit.", "note"));
	if (document?.error) {
		const more = el("details", undefined, "details");
		more.append(el("summary", "File error"), el("p", document.error), el("pre", draft.path));
		line.append(more);
	}
	for (const note of [
		...(change?.problems ?? []),
		...(change?.notes ?? []),
		...(change?.apply?.text ? [change.apply.text] : []),
	])
		line.append(el("p", note, "note"));
	if (change?.current) line.append(el("p", "Current stored value"), el("pre", stored(change.current)));
	appendDraftActions(line, draft, change);

	return line;
}

function appendProposedValue(line: HTMLElement, draft: Draft, action: Draft["change"]["action"]): void {
	if (action === "unset") line.append(el("p", "Reset to the inherited value"));
	else if (action === "delete") line.append(el("p", "Remove this key"));
	else if (draft.error) line.append(el("p", "The draft has incomplete or invalid input.", "note"));
	else if (draft.change.value !== undefined)
		line.append(el("p", "Draft value", "muted"), el("pre", display(draft.change.value)));
}

function appendDraftActions(line: HTMLElement, draft: Draft, change: ReturnType<typeof compareResult>["change"]): void {
	const { id, scope, action } = draft.change;
	const pending = drafts.get(keyOf(draft)) === draft;
	if (pending) {
		const issue = catalogue && blocker(draft, catalogue);
		if (issue) line.append(el("p", issue, "note"));
		const entry = catalogue?.entries.find((item) => item.id === id);
		if (interrupted) line.append(el("p", "Current stored value"), el("pre", stored(entry?.saved[scope])));
		const actions = el("div", undefined, "field-actions");
		if (change?.current && action !== "create")
			actions.append(
				button("Keep my draft", () => {
					changeDraft({ ...draft, change: { ...draft.change, base: change.current } });
					openReview();
				}),
			);
		if (
			issue &&
			!draft.error &&
			entry?.scopes.includes(scope) &&
			catalogue &&
			entry.ownerState === "available" &&
			documentFor(scope, catalogue.context)?.path === draft.path &&
			action !== "create"
		)
			actions.append(button("Review against current setting", () => rebindDraft(entry, draft)));
		actions.append(
			button("Drop draft", () => {
				dropDraft(draft);
				openReview();
			}),
		);
		line.append(actions);
	}
}

function rebindDraft(entry: Entry, draft: Draft): void {
	if (!catalogue) return;
	const next = begin(entry, draft.change.scope, catalogue.context, draft.change.action);
	const parsed = draft.rawText === undefined ? undefined : parseValue(draft.rawText, entry.value);
	changeDraft({
		...next,
		rawText: draft.rawText,
		error: parsed && "error" in parsed ? parsed.error : undefined,
		change: { ...next.change, value: parsed && "value" in parsed ? parsed.value : undefined },
	});
	openReview();
}

async function markCommit(target: string): Promise<void> {
	interrupted = true;
	if (!(await persist())) throw new Error("No change was sent. Draft recovery must work before a save.");
	if (!connected || target !== currentTarget())
		throw new Error("The original session is no longer connected. No change was sent.");
}

async function settleCommit(batch: Draft[], result: EditResult): Promise<void> {
	for (const draft of batch) if (compareResult(draft, result).saved) drafts.delete(keyOf(draft));
	interrupted = false;
	await persist();
	if (connected) await refreshCatalogue();
}

function installCheckSurface(): void {
	const setRaw = (id: string, target: Scope, text: string) => {
		const cat = catalogue;
		const entry = cat?.entries.find((item) => item.id === id);
		if (!cat || !entry?.scopes.includes(target) || !connected || busy)
			throw new Error("The setting is not editable here.");
		editDraft(entry, target, cat.context, text);
		paint();
	};
	Object.assign(window, {
		__configCheck: {
			search: (text: string) => {
				if (dialog.open) dialog.close();
				reveal(text);
			},
			open: (id: string) => {
				const entry = catalogue?.entries.find((item) => item.id === id);
				if (!entry) throw new Error(`No setting: ${id}`);
				if (dialog.open) dialog.close();
				details.add(id);
				select(sectionFor(entry));
			},
			setDraft: (id: string, target: Scope, value: Json) => setRaw(id, target, JSON.stringify(value)),
			setRaw,
			revert: (id: string, target?: Scope) => {
				for (const draft of drafts.values())
					if (draft.change.id === id && (!target || draft.change.scope === target)) dropDraft(draft);
				if (dialog.open) dialog.close();
			},
			preview: () => submit("preview"),
			save: () => submit("commit"),
			refresh: refreshCatalogue,
			snapshot: (name: string) => call("checkSnapshot", { name }),
			state: () => ({
				connected,
				generation: catalogue?.generation,
				scope,
				section,
				query: search.value,
				drafts: [...drafts.values()],
				warnings: Array.from(document.querySelectorAll<HTMLElement>(".note, .problem, #notice"))
					.filter((node) => node.getClientRects().length)
					.map((node) => node.textContent),
			}),
		},
	});
}

function acceptCatalogue(ticket: ReturnType<typeof catalogueGate.issue>, response: BridgeResponse["/catalogue"]): void {
	if (!connected || !catalogueGate.accepts(ticket, currentTarget())) return;
	if (targetKey(response.catalogue.context) !== ticket.target) {
		disconnect();
		return;
	}
	if (response.generation !== ticket.serial || response.generation !== response.catalogue.generation) return;
	catalogue = response.catalogue;
	context = catalogue.context;
	paintTarget();
	// Do not replace the active editor while the operator types.
	if (body.contains(document.activeElement) && document.activeElement?.closest(".editor")) {
		rerender = true;
		paintStatus();
	} else paint();
}

function appendNavGroup(
	parent: HTMLElement,
	menu: HTMLSelectElement,
	items: ReturnType<typeof sections>,
	group: string,
	query: string,
): void {
	if (!items.length) return;
	const set = el("div", undefined, "nav-group");
	if (group !== "Advanced") set.append(el("h2", group));
	const optgroup = el("optgroup");
	optgroup.label = group;
	for (const item of items) {
		const control = button(item.label, () => select(item.key));
		control.dataset.section = item.key;
		control.setAttribute("aria-current", String(!query && item.key === section));
		set.append(control);
		optgroup.append(option(item.key, item.label));
	}
	parent.append(set);
	menu.append(optgroup);
}
