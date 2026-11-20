import type {
	BridgeResponse,
	Change,
	ChangeResult,
	DocumentResult,
	EditRequest,
	EditResult,
	Entry,
	Saved,
	Scope,
	ToolsChange,
	ToolsResult,
	ValueSchema,
} from "../../../protocol.ts";
import { parseValue } from "../app/form/control.ts";
import { catalogue, context, toolView } from "./fixture.ts";

const conflictId = "harness:/viewer/commitConflict";
const failureId = "harness:/viewer/commitFailure";
const absent: Saved = { present: false };
const ok = { ok: true } as const;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let simulatedWriter = false;
let revision = 1;

function directTool(name: string): boolean {
	return toolView.tools.some((tool) => tool.name === name && tool.exposure === "direct");
}

function toolChange(change: ToolsChange): ToolsResult {
	const activated: string[] = [];
	const deactivated: string[] = [];
	const rejected: ToolsResult["rejected"] = [];
	const active = new Set(toolView.active);
	for (const [activate, names] of [
		[true, change.activate ?? []],
		[false, change.deactivate ?? []],
	] as const) {
		for (const name of names) {
			if (!directTool(name)) {
				rejected.push({ name, reason: "This fixture only changes direct tools." });
				continue;
			}
			updateTool(active, name, activate, activate ? activated : deactivated);
		}
	}
	toolView.active = [...active];
	for (const row of toolView.tools) row.active = active.has(row.name);
	const applied = Boolean(activated.length || deactivated.length);
	return {
		applied,
		active: toolView.active,
		activated,
		deactivated,
		rejected,
		text: applied ? "Session tools updated." : "Session tools did not change.",
	};
}

function updateTool(active: Set<string>, name: string, activate: boolean, changed: string[]): void {
	if (active.has(name) === activate) return;
	if (activate) active.add(name);
	else active.delete(name);
	changed.push(name);
}

function schemaFor(type: Change["type"]): ValueSchema {
	if (type === "array") return { type, items: { type: "json" } };
	if (type === "object") return { type, properties: {}, additional: true };
	return { type: type ?? "json" };
}
function newEntry(change: Change, scope: Scope): Entry {
	const [group, pointer] = change.id.split(/:(.*)/s);
	const path = pointer
		.slice(1)
		.split("/")
		.map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
	const custom = group === "custom";
	return {
		id: change.id,
		group: custom ? "custom" : "pi",
		category: custom ? "Custom" : "General",
		label: path.at(-1) ?? change.id,
		path: custom ? ["settings", "custom", ...path] : path,
		description: change.description ?? "",
		owner: custom ? "settings" : "Pi",
		ownerState: "available",
		kind: custom ? "setting" : "unregistered",
		value: schemaFor(change.type),
		scopes: [scope],
		saved: {},
		resolved: { source: "unset" },
		diagnostics: [],
		raw: !custom,
		apply: custom
			? { timing: "custom", text: "No tool reads this value automatically." }
			: { timing: "pi", text: "Pi reads this setting at startup or reload." },
	};
}
function storedAfter(change: Change): Saved {
	return (change.action === "set" || change.action === "create") && change.value !== undefined
		? { present: true, value: change.value }
		: absent;
}
function resolve(entry: Entry, saved: Entry["saved"]): Entry["resolved"] {
	if (entry.env?.set) return entry.resolved;
	for (const scope of ["project", "global", "machine"] as const) {
		const current = saved[scope];
		if (current?.present) return { source: scope, value: current.value };
	}
	return entry.default?.value !== undefined ? { source: "default", value: entry.default.value } : { source: "unset" };
}

type Batch = { result: DocumentResult; writes: (() => void)[]; fail: boolean };
type File = (typeof context.documents)[number];

function edit(request: EditRequest): EditResult {
	const files = new Map<Scope, Batch>();
	for (const change of request.changes) {
		const scope = change.scope ?? "machine";
		const file = context.documents.find((document) => document.scope === scope);
		if (!file) throw new Error("Unknown fixture scope.");
		let batch = files.get(scope);
		if (!batch) {
			batch = {
				result: {
					document: file.document,
					scope,
					path: file.path,
					outcome: "unchanged",
					before: file.revision,
					after: file.revision,
					changes: [],
				},
				writes: [],
				fail: false,
			};
			files.set(scope, batch);
		}
		stage(change, request, batch, file);
	}
	const batches = [...files.values()];
	const conflict = batches.some(({ result }) => result.changes.some((change) => change.status === "conflict"));
	const invalid = batches.some(({ result }) =>
		result.changes.some((change) => change.status === "refused" || change.status === "invalid"),
	);
	for (const batch of files.values()) finishBatch(batch, request.mode === "commit", conflict || invalid);
	const documents = batches.map(({ result }) => result);
	const outcome = editOutcome(documents, conflict, invalid);
	const summary = {
		conflict: "A stored value changed. No fixture edits were saved.",
		rejected: "The fixture rejected the request.",
		failed: "The fixture did not save the edits.",
		partial: "The fixture saved changes in some files.",
		committed: "The fixture saved the edits.",
		previewed: "The fixture accepted the preview. No values were saved.",
		unchanged: "No fixture values changed.",
	}[outcome];
	return { requestId: request.requestId, mode: request.mode, outcome, documents, summary };
}

function stage(change: Change, request: EditRequest, batch: Batch, file: File): void {
	const scope = file.scope;
	const result: ChangeResult = { id: change.id, scope, action: change.action, status: "ok", problems: [], notes: [] };
	batch.result.changes.push(result);
	const existing = catalogue.entries.find((entry) => entry.id === change.id);
	const entry = editableEntry(change, existing, scope);
	if (!entry) {
		result.status = "refused";
		result.problems.push("The fixture does not allow this change.");
		return;
	}
	if (request.mode === "commit") simulateWriter(change, entry, batch, file);
	const saved = entry.saved[scope] ?? absent;
	const expected = request.revisions?.[file.document];
	if (
		(change.base && JSON.stringify(change.base) !== JSON.stringify(saved)) ||
		(expected !== undefined && expected !== file.revision)
	) {
		result.status = "conflict";
		result.current = saved;
		result.problems.push("The stored value or file revision changed.");
		return;
	}
	const next = storedAfter(change);
	const shape = shapeProblem(change, entry, next);
	if (shape) {
		result.status = "invalid";
		result.problems.push(shape);
		return;
	}
	const nextSaved = { ...entry.saved, [scope]: next };
	result.resolved = resolve(entry, nextSaved);
	result.apply = applyState(entry);
	if (entry.raw) result.notes.push("No available owner validates this raw edit.");
	if (change.action !== "create" && change.action !== "delete" && JSON.stringify(next) === JSON.stringify(saved)) {
		result.status = "unchanged";
		return;
	}
	if (request.mode === "commit" && change.id === failureId) batch.fail = true;
	batch.writes.push(() => writeEntry(change, entry, existing, scope, next));
}

function editableEntry(change: Change, existing: Entry | undefined, scope: Scope): Entry | undefined {
	if (change.action === "create") return existing ? undefined : newEntry(change, scope);
	if (!existing?.scopes.includes(scope) || (existing.raw && !change.raw)) return;
	return existing;
}

function writeEntry(change: Change, entry: Entry, existing: Entry | undefined, scope: Scope, saved: Saved): void {
	if (change.action === "delete") {
		catalogue.entries = catalogue.entries.filter((item) => item !== existing);
		return;
	}
	entry.saved[scope] = saved;
	entry.resolved = resolve(entry, entry.saved);
	if (!existing) catalogue.entries.push(entry);
}

function simulateWriter(change: Change, entry: Entry, batch: Batch, file: File): void {
	const scope = file.scope;
	if (change.id !== conflictId || simulatedWriter) return;
	const current = { present: true, value: "Another writer" } as const;
	entry.saved[scope] = current;
	entry.resolved = resolve(entry, entry.saved);
	file.revision = `fixture-${scope}-${++revision}`;
	batch.result.before = file.revision;
	batch.result.after = file.revision;
	catalogue.generation++;
	simulatedWriter = true;
}

function shapeProblem(change: Change, entry: Entry, next: Saved): string | undefined {
	if (change.action !== "set" && change.action !== "create") return;
	const shape = parseValue(next.present ? JSON.stringify(next.value) : "", entry.raw ? { type: "json" } : entry.value);
	return "error" in shape ? shape.error : undefined;
}

function applyState(entry: Entry): ChangeResult["apply"] {
	return entry.env?.set
		? { state: "masked", text: "The environment still overrides this value." }
		: entry.apply.timing === "pi" || entry.apply.timing === "reload"
			? { state: "pending-reload", text: entry.apply.text }
			: { state: "next-use", text: entry.apply.text };
}

function finishBatch({ result, writes, fail }: Batch, commit: boolean, blocked: boolean): void {
	const scope = result.scope;
	if (result.changes.some((change) => change.status === "conflict")) result.outcome = "conflict";
	else if (result.changes.some((change) => change.status === "refused" || change.status === "invalid"))
		result.outcome = "rejected";
	else if (blocked) result.outcome = "not-attempted";
	else if (!writes.length) result.outcome = "unchanged";
	else if (!commit) result.outcome = "previewed";
	else if (fail) {
		result.outcome = "failed";
		result.error = "The fixture could not write the file.";
	} else {
		for (const write of writes) write();
		const file = context.documents.find((document) => document.scope === scope);
		if (file) {
			file.status = "loaded";
			file.revision = `fixture-${scope}-${++revision}`;
			result.after = file.revision;
		}
		catalogue.generation++;
		result.outcome = "committed";
	}
}

function editOutcome(documents: DocumentResult[], conflict: boolean, invalid: boolean): EditResult["outcome"] {
	const committed = documents.some((document) => document.outcome === "committed");
	const failed = documents.some((document) => document.outcome === "failed");
	if (conflict) return "conflict";
	if (invalid) return "rejected";
	if (failed) return committed ? "partial" : "failed";
	if (committed) return "committed";
	return documents.some((document) => document.outcome === "previewed") ? "previewed" : "unchanged";
}

export async function fixtureMessage(op: string, payload: Record<string, unknown>): Promise<unknown> {
	switch (op) {
		case "connect":
			return clone({
				...ok,
				context,
				label: "Settings demo",
				build: { current: true },
			} satisfies BridgeResponse["/connect"]);
		case "catalogue":
			return clone({ ...ok, generation: catalogue.generation, catalogue } satisfies BridgeResponse["/catalogue"]);
		case "edit":
			return clone({ ...ok, result: edit(clone(payload.request as EditRequest)) } satisfies BridgeResponse["/edit"]);
		case "tools":
			return clone({ ...ok, tools: toolView } satisfies BridgeResponse["/tools"]);
		case "toolsApply":
			return clone({
				...ok,
				result: toolChange(payload.change as ToolsChange),
			} satisfies BridgeResponse["/tools/apply"]);
		case "draftLoad":
			return { recoveries: [] };
		case "poll":
			return { ...ok, sequence: 0, command: null, changed: false } satisfies BridgeResponse["/poll"];
		default:
			return ok;
	}
}
