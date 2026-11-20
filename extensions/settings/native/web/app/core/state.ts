import type {
	Catalogue,
	Change,
	ChangeResult,
	EditResult,
	Entry,
	Json,
	Saved,
	Scope,
	SettingsContext,
	ValueSchema,
} from "../../../../protocol.ts";

export type Draft = {
	change: Change & { scope: Scope };
	label: string;
	path: string;
	ownerState?: Entry["ownerState"];
	valueSchema?: ValueSchema;
	rawText?: string;
	error?: string;
};
export type Snapshot = { version: 1; drafts: Draft[]; interrupted?: boolean };
export const draftKey = (id: string, scope: Scope): string => JSON.stringify([id, scope]);
export const scopeLabel: Record<Scope, string> = { global: "Global", project: "Project", machine: "Machine" };
export const documentFor = (scope: Scope, context: SettingsContext) =>
	context.documents.find((document) => document.scope === scope);
export function pointer(parts: string[]): string {
	return parts.map((part) => `/${part.replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}
export function begin(entry: Entry, scope: Scope, context: SettingsContext, action: Change["action"]): Draft {
	return {
		label: entry.label,
		path: documentFor(scope, context)?.path ?? "",
		ownerState: entry.ownerState,
		valueSchema: entry.value,
		change: {
			id: entry.id,
			scope,
			action,
			base: entry.saved[scope] ?? { present: false },
			schema: entry.schema,
			raw: entry.raw,
		},
	};
}
function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}
export function blocker(draft: Draft, catalogue: Catalogue): string | undefined {
	const { id, scope, schema, action } = draft.change;
	const document = documentFor(scope, catalogue.context);
	if (document?.path !== draft.path || !document.writable)
		return document?.reason ?? "The original file is no longer available for edits.";
	if (scope === "project" && !catalogue.context.projectTrusted) return "This session does not trust the project.";
	const entry = catalogue.entries.find((item) => item.id === id);
	if (action === "create")
		return entry?.saved[scope]?.present ? "This key now exists in the chosen scope." : draft.error;
	if (!entry?.scopes.includes(scope)) return "This setting is no longer editable in the chosen scope.";
	if (
		draft.ownerState !== entry.ownerState ||
		schema !== entry.schema ||
		canonical(draft.valueSchema) !== canonical(entry.value)
	) {
		return "The owner or accepted value changed. Review this draft against the current setting or drop it.";
	}
	return draft.error;
}
export const targetKey = (context: SettingsContext): string =>
	JSON.stringify([
		context.machine,
		context.agentDir,
		context.cwd,
		context.projectDir,
		context.host.kind,
		context.host.pid,
		context.host.session,
	]);
export function responseGate() {
	let serial = 0;
	return {
		issue: (target: string) => ({ serial: ++serial, target }),
		accepts: (ticket: { serial: number; target: string }, target: string) =>
			ticket.serial === serial && ticket.target === target,
	};
}
export function compareResult(draft: Draft, result: EditResult) {
	const document = result.documents.find(
		(document) => document.scope === draft.change.scope && document.path === draft.path,
	);
	const change = document?.changes.find(
		({ id, scope, action }) => id === draft.change.id && scope === draft.change.scope && action === draft.change.action,
	);
	return {
		document,
		change,
		saved:
			result.mode === "commit" &&
			(document?.outcome === "committed" || document?.outcome === "unchanged") &&
			(change?.status === "ok" || change?.status === "unchanged"),
	};
}
export function resultLabel(result: EditResult, draft: Draft, owner?: string): string {
	const { saved, change, document } = compareResult(draft, result);
	if (saved) return change?.status === "unchanged" ? "Already saved" : "Saved";
	if (change?.status === "conflict") return "Not saved: changed elsewhere";
	const rejection = rejectionLabel(change?.status, draft, owner);
	if (rejection) return rejection;
	if (document?.outcome === "failed") return "Not saved: could not write the file";
	if (result.mode === "preview" && document?.outcome === "previewed") return "Ready to save";
	if (result.mode === "preview" && document?.outcome === "unchanged") return "Already saved";
	if (change?.status === "ok" || change?.status === "unchanged") return "Not saved: another change needs attention";
	return "Not saved";
}

function rejectionLabel(status: ChangeResult["status"] | undefined, draft: Draft, owner?: string): string | undefined {
	if (status !== "invalid" && status !== "refused") return;
	if (owner && draft.change.id.startsWith("harness:")) return `Rejected by ${owner}`;
	return status === "invalid" ? "Not saved: invalid value" : "Not saved: this change is not allowed";
}

export function searchCatalogue(entries: Entry[], query: string): Entry[] {
	const terms = query.toLowerCase().trim().split(/\s+/u).filter(Boolean);
	return entries.filter((entry) => {
		const text = [
			entry.label,
			entry.id,
			entry.description,
			entry.category,
			entry.owner,
			entry.kind,
			entry.env?.name,
			...entry.path,
		]
			.join(" ")
			.toLowerCase();
		return terms.every((term) => text.includes(term));
	});
}
export function display(value: Json | undefined): string {
	if (value === undefined) return "Not shown";
	if (typeof value === "string") return value === "" ? "(empty text)" : value;
	if (Array.isArray(value)) return value.length ? value.map(display).join("\n") : "No items";
	if (value && typeof value === "object") {
		const pairs = Object.entries(value);
		return pairs.length
			? pairs.map(([key, item]) => `${key}: ${display(item).replaceAll("\n", "\n  ")}`).join("\n")
			: "No entries";
	}
	return String(value);
}
export function sectionFor(
	entry: Pick<Entry, "group" | "ownerState" | "kind" | "category" | "owner" | "path">,
): string {
	if (entry.group === "harness" && entry.ownerState !== "available") return "advanced:unmanaged";
	if (entry.kind !== "setting") return `advanced:${entry.kind}`;
	if (entry.group === "custom") return "custom";
	if (entry.group === "harness") return `extension:${entry.owner}`;
	if (entry.category === "Tools" || entry.path[0] === "defaultTools" || entry.path[0] === "codemode") return "tools";
	return `pi:${entry.category}`;
}

export function scopeNotice(entry: Entry, scope: Scope): string | undefined {
	if (entry.group !== "pi") return;
	if (scope === "project" && !entry.scopes.includes("project") && entry.scopes.includes("global")) return "Global only";
	if (scope === "global" && entry.saved.project?.present) {
		if (entry.resolved.source === "project") return "Overridden in Project";
		if (entry.resolved.source === "combined") return "A project value also applies";
	}
	if (scope === "project" && !entry.saved.project?.present && entry.saved.global?.present) return "Set in Global";
}

export function stored(saved: Saved | undefined): string {
	return saved?.present ? display(saved.value) : "Not set";
}
