import type { Catalogue, Entry, Json, Scope } from "../../../../protocol.ts";
import { type Draft, display, documentFor, scopeLabel, scopeNotice, stored } from "../core/state.ts";
import { editor, wideEditor } from "../form/control.ts";
import { button, el } from "./dom.ts";

const sources = {
	env: "Environment",
	machine: "Machine",
	project: "Project",
	global: "Global",
	default: "Default",
	unset: "Not set",
	combined: "Combined",
};
type RowOptions = {
	entry: Entry;
	catalogue: Catalogue;
	scope: Scope;
	draft?: Draft;
	issue?: string;
	readOnly: boolean;
	open: boolean;
	showDetails: (open: boolean) => void;
	getDraft: (scope: Scope) => Draft | undefined;
	edit: (raw: string, error?: string) => void;
	act: (action: "unset" | "delete", scope: Scope) => void;
	drop: () => void;
};

export function entryRow(options: RowOptions): HTMLElement {
	const { entry } = options;
	const row = el("article", undefined, wideEditor(editorSchema(entry, options.draft)) ? "row wide" : "row");
	row.dataset.row = entry.id;
	row.tabIndex = 0;
	row.setAttribute("aria-label", entry.label);
	const top = el("div", undefined, "row-top");
	const about = el("div");
	about.append(el("h2", entry.label));
	if (entry.description) about.append(el("p", entry.description, "help"));
	for (const warning of entry.diagnostics) about.append(el("p", warning, "note"));
	if (entry.env?.set) about.append(el("p", "The environment overrides this value in this process.", "note"));
	if (entry.ownerState !== "available")
		about.append(
			el(
				"p",
				entry.ownerState === "changed"
					? "The extension owner changed its settings declaration."
					: "The extension owner is unavailable.",
				"note",
			),
		);
	const scope = scopeNotice(entry, options.scope);
	if (scope) about.append(el("p", scope, "muted scope-note"));
	top.append(about, editorField(options));
	row.append(top, entryDetails(options));
	return row;
}

function editorField(options: RowOptions): HTMLElement {
	const { entry, scope, draft } = options;
	const field = el("div", undefined, "editor");
	const saved = entry.saved[scope];
	// A displayed default is only an initial editor value. It is never a write until the user edits it.
	const seed = editorSeed(entry, scope);
	const editable = canEdit(options);
	const label = entry.label;
	if (draft && draft.change.action !== "set" && draft.change.action !== "create") {
		field.append(el("p", draft.change.action === "unset" ? "Reset pending" : "Removal pending", "muted"));
	} else if (editable && entry.raw && !draft) {
		field.append(
			el("pre", stored(saved)),
			button("Edit as raw JSON", () => {
				options.edit(JSON.stringify(seed ?? null, null, 2));
				field.replaceChildren(
					editor({ type: "json" }, seed, JSON.stringify(seed ?? null, null, 2), label, options.edit, true),
				);
				field.querySelector("textarea")?.focus();
			}),
		);
	} else if (editable) {
		field.append(editor(editorSchema(entry, draft), seed, draft?.rawText, label, options.edit, true));
	} else {
		field.append(
			el(
				"pre",
				draft
					? display(draft.change.value)
					: entry.resolved.source === "unset"
						? "Not set"
						: display(entry.resolved.value),
			),
		);
		appendReadOnlyReason(field, options);
	}
	appendDraftNotice(field, options);
	if (editable && saved?.present && entry.kind !== "unregistered" && draft?.change.action !== "unset") {
		const reset = button("Reset", () => options.act("unset", scope), "quiet");
		reset.setAttribute("aria-label", `Reset ${entry.label}`);
		field.append(reset);
	}
	return field;
}

function entryDetails(options: RowOptions): HTMLElement {
	const { entry, catalogue } = options;
	const details = el("details", undefined, "details");
	details.open = options.open;
	details.addEventListener("toggle", () => options.showDetails(details.open));
	details.append(el("summary", "Details"));
	const facts = el("dl");
	const add = (key: string, value: string, code = false) => {
		const control = el("dd");
		control.append(code ? el("pre", value) : document.createTextNode(value));
		facts.append(el("dt", key), control);
		return control;
	};
	add("Exact key", entry.id, true);
	add(
		"Resolved",
		`${sources[entry.resolved.source]} · ${entry.resolved.source === "unset" ? "Not set" : display(entry.resolved.value)}`,
		true,
	);
	if (entry.resolved.note) add("Resolution", entry.resolved.note);
	if (entry.env)
		add(
			"Environment",
			`${entry.env.name} (${entry.env.set ? "set" : "not set"}${entry.env.secret ? ", value hidden" : ""})`,
		);
	if (entry.session)
		add(
			"In this session",
			`${display(entry.session.value)}${entry.session.differs ? " · differs from resolved value" : ""}`,
			true,
		);
	add(
		"Default",
		entry.default?.text ?? (entry.default?.value !== undefined ? display(entry.default.value) : "Not reported"),
		entry.default?.value !== undefined,
	);
	const owner = catalogue.owners.find((owner) => owner.owner === entry.owner && owner.group === entry.group);
	add("Owner", `${entry.owner} · ${entry.ownerState}${owner?.detail ? ` · ${owner.detail}` : ""}`);
	if (entry.kind !== "setting")
		add("Kind", { deprecated: "Deprecated", internal: "Pi internal", unregistered: "Unregistered key" }[entry.kind]);
	add("When it applies", entry.apply.text);
	if (entry.raw) add("Validation", "No available owner validates raw edits.");
	appendDocumentDetails(options, add);
	details.append(facts);
	return details;
}

function canEdit({ entry, catalogue, scope, readOnly }: RowOptions): boolean {
	return (
		!readOnly &&
		entry.scopes.includes(scope) &&
		documentFor(scope, catalogue.context)?.writable === true &&
		(scope !== "project" || catalogue.context.projectTrusted) &&
		!(entry.group === "harness" && entry.kind === "unregistered" && !entry.raw)
	);
}

function appendReadOnlyReason(field: HTMLElement, { entry, scope, catalogue }: RowOptions): void {
	const reason = entry.readOnly;
	if (reason) field.append(el("p", reason, "muted"));
	else if (documentFor(scope, catalogue.context)?.reason)
		field.append(el("p", documentFor(scope, catalogue.context)?.reason, "note"));
}

function appendDocumentDetails(
	options: RowOptions,
	add: (key: string, value: string, code?: boolean) => HTMLElement,
): void {
	const { entry, catalogue } = options;
	for (const document of catalogue.context.documents.filter((document) =>
		entry.group === "pi" ? document.scope !== "machine" : document.scope === "machine",
	)) {
		appendDocument(options, add, document);
	}
}

function appendDraftNotice(field: HTMLElement, { draft, issue, drop }: RowOptions): void {
	if (issue && issue !== draft?.error) field.append(el("p", issue, "note"));
	if (draft && draft.change.action !== "set") field.append(button("Discard draft", drop));
}

function editorSeed(entry: Entry, scope: Scope): Json | undefined {
	const saved = entry.saved[scope];
	if (saved?.present) return saved.value;
	return entry.env?.set ? undefined : entry.resolved.value;
}
function editorSchema(entry: Entry, draft?: Draft) {
	return entry.kind === "unregistered" || entry.raw ? ({ type: "json" } as const) : (draft?.valueSchema ?? entry.value);
}

function appendDocument(
	options: RowOptions,
	add: (key: string, value: string, code?: boolean) => HTMLElement,
	document: Catalogue["context"]["documents"][number],
): void {
	const { entry } = options;
	const target = document.scope;
	const value = add(`${scopeLabel[target]} file`, document.path, true);
	value.append(el("pre", stored(entry.saved[target])));
	const pending = options.getDraft(target);
	if (pending)
		value.append(
			el(
				"p",
				`${{ unset: "Reset", delete: "Removal", set: "Edit", create: "New value" }[pending.change.action]} pending`,
				"muted",
			),
		);
	const controls = el("div", undefined, "field-actions");
	if (
		!options.readOnly &&
		document.writable &&
		(target !== "project" || options.catalogue.context.projectTrusted) &&
		entry.scopes.includes(target) &&
		entry.saved[target]?.present
	) {
		if (entry.kind !== "unregistered" && target !== options.scope)
			controls.append(button(`Reset ${scopeLabel[target]}`, () => options.act("unset", target)));
		if (entry.group === "custom" || entry.kind === "unregistered")
			controls.append(button(`Remove from ${scopeLabel[target]}`, () => options.act("delete", target)));
	}
	if (controls.childNodes.length) value.append(controls);
	if (document.reason) value.append(el("p", document.reason, "note"));
}
