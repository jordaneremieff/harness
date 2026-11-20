import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	applyFor,
	buildSnapshot,
	documentSpecs,
	piEntries,
	piManager,
	SCOPE_DOCUMENT,
	type ConfigHost,
	type Snapshot,
	type ToolInfoLike,
} from "./catalogue.ts";
import { type DocumentRead, type DocumentSpec, readDocument, withLockedDocument } from "./documents.ts";
import { boundedJson, getAt, isObject, jsonEqual, parseEntryId, preview, savedEqual, setAt, unsetAt } from "./json.ts";
import { type Diagnostic, type Field, type Judgement, judgeCandidate, type Publication } from "./owners.ts";
import { validateValue } from "./json-schema.ts";
import type { PiLeaf } from "./pi-schema.ts";
import type {
	Catalogue,
	Change,
	ChangeResult,
	DocumentName,
	DocumentResult,
	EditRequest,
	EditResult,
	Entry,
	Json,
	Saved,
	Scope,
	ToolsChange,
	ToolsResult,
	ToolsView,
} from "./protocol.ts";
import { customEntryProblem, settings as ownSettings } from "./settings.ts";

export const MAX_CHANGES = 64;
const ACTIONS = ["set", "unset", "create", "delete"] as const;
const CUSTOM_TYPE_NAMES = ["string", "number", "integer", "boolean", "array", "object", "json"];

/** One planned change: what it does to which document path, and how it is judged. */
type Planned = {
	change: Change;
	entry?: Entry;
	document: DocumentName;
	scope: Scope;
	/** The document path whose stored value `base` describes. */
	valuePath: string[];
	/** The document path that the change rewrites, for no-op detection. */
	targetPath: string[];
	/** Applies the change to a document value in place. */
	mutate: (document: Record<string, unknown>) => void;
	/** The stored value at `valuePath` after the change. */
	desired: Saved;
	slice?: string;
	secret?: boolean;
	result: ChangeResult;
};

function refuse(planned: Pick<Planned, "result">, status: ChangeResult["status"], problem: string): void {
	planned.result.status = status;
	planned.result.problems.push(problem);
}
function blocked(item: Planned): boolean {
	return item.result.status !== "ok" && item.result.status !== "unchanged";
}

/** Rejects a change whose shape no document can serve, before any id is parsed. */
function shapeRefusal(change: Change): { status: ChangeResult["status"]; problem: string } | undefined {
	if (!isObject(change) || typeof change.id !== "string" || !(ACTIONS as readonly string[]).includes(change.action))
		return { status: "refused", problem: "A change names an id and one of the actions set, unset, create or delete." };
	if (
		(change.action === "set" || change.action === "create") &&
		change.value !== undefined &&
		!boundedJson(change.value)
	)
		return { status: "invalid", problem: "The value is not bounded JSON." };
}

/** Why a commit still needs the revision or base value the author saw, or undefined. */
function revisionRefusal(
	planned: Planned,
	change: Change,
	mode: EditRequest["mode"],
	revisions: EditRequest["revisions"],
): string | undefined {
	if (mode !== "commit" || blocked(planned) || change.base !== undefined) return;
	if (revisions !== undefined && Object.hasOwn(revisions, planned.document)) return;
	return `A commit needs the ${planned.document} revision from config_get or the base value this change replaces.`;
}

function plan(
	snapshot: Snapshot,
	change: Change,
	mode: EditRequest["mode"],
	revisions: EditRequest["revisions"],
): Planned {
	const result: ChangeResult = {
		id: typeof change?.id === "string" ? change.id : "",
		scope: "machine",
		action: change?.action,
		status: "ok",
		problems: [],
		notes: [],
	};
	const planned: Planned = {
		change,
		document: "harness",
		scope: "machine",
		valuePath: [],
		targetPath: [],
		mutate: () => {},
		desired: { present: false },
		result,
	};
	const shape = shapeRefusal(change);
	if (shape) {
		refuse(planned, shape.status, shape.problem);
		return planned;
	}
	let parsed: { group: string; path: string[] };
	try {
		parsed = parseEntryId(change.id);
	} catch (error) {
		refuse(planned, "refused", (error as Error).message);
		return planned;
	}
	const entry = snapshot.entries.get(change.id);
	planned.entry = entry;
	if (entry?.schema && change.schema !== undefined && change.schema !== entry.schema) {
		refuse(
			planned,
			"conflict",
			"The owner's settings declaration changed after this edit began. Review the entry and apply the edit again.",
		);
		return planned;
	}
	if (parsed.group === "pi") planPi(snapshot, planned, parsed.path);
	else if (parsed.group === "harness") planHarness(snapshot, planned, parsed.path);
	else planCustom(snapshot, planned, parsed.path);
	result.scope = planned.scope;
	const revision = revisionRefusal(planned, change, mode, revisions);
	if (revision) refuse(planned, "refused", revision);
	if (change.base !== undefined && !validSaved(change.base))
		refuse(planned, "refused", "base is {present:false} or {present:true,value}.");
	return planned;
}
function validSaved(value: unknown): value is Saved {
	return (
		isObject(value) &&
		(value.present === false || (value.present === true && Object.hasOwn(value, "value") && boundedJson(value.value)))
	);
}

/** Records the value a set or create stores, and the rewrite that stores it. */
function assignMutate(planned: Planned, change: Change, path: string[]): void {
	const value = change.value as Json;
	if (change.action === "set" || change.action === "create") {
		planned.desired = { present: true, value };
		planned.mutate = (document) => setAt(document, path, value);
	} else planned.mutate = (document) => void unsetAt(document, path);
}

function rawPiGuard(entry: Entry): string {
	return `${entry.kind === "internal" ? "Pi maintains this record itself" : entry.kind === "deprecated" ? "This setting is deprecated" : "Pi's schema does not declare this key"}; set raw: true to change it anyway.`;
}

function planPiSet(
	snapshot: Snapshot,
	planned: Planned,
	path: string[],
	entry: Entry | undefined,
	leaf: PiLeaf | undefined,
	insideLeaf: boolean,
	scope: "global" | "project",
): void {
	const { change } = planned;
	if (!entry) {
		refuse(
			planned,
			"refused",
			insideLeaf
				? "Set the whole value of the containing setting."
				: "No such Pi setting; use create for a new unregistered key.",
		);
		return;
	}
	if (entry.raw && !change.raw) {
		refuse(planned, "refused", rawPiGuard(entry));
		return;
	}
	if (!entry.scopes.includes(scope)) {
		refuse(planned, "refused", "Pi reads this setting only from agent-directory settings; use scope global.");
		return;
	}
	if (change.value === undefined) {
		refuse(planned, "invalid", "set needs a value.");
		return;
	}
	if (!leaf) return;
	const problems = validateValue(snapshot.schema.root, leaf.schema, change.value, path.join("."));
	if (problems.length) {
		planned.result.status = "invalid";
		planned.result.problems.push(...problems);
	}
}

function planPiCreate(
	snapshot: Snapshot,
	planned: Planned,
	path: string[],
	entry: Entry | undefined,
	insideLeaf: boolean,
): void {
	if (entry && entry.kind !== "unregistered") {
		refuse(planned, "refused", "This key is part of Pi's schema; use set.");
		return;
	}
	if (insideLeaf) {
		refuse(planned, "refused", "Set the whole value of the containing setting.");
		return;
	}
	const parent = path.slice(0, -1);
	if (parent.length && !snapshot.schema.objects.some((item) => item.join("\0") === parent.join("\0"))) {
		refuse(planned, "refused", "New Pi keys go at the top level or inside an object that Pi's schema declares.");
		return;
	}
	if (planned.change.value === undefined) {
		refuse(planned, "invalid", "create needs a value.");
		return;
	}
	planned.result.notes.push(
		"Pi's schema does not declare this key; Pi keeps it, and only a reader that knows it uses it.",
	);
}

function planPi(snapshot: Snapshot, planned: Planned, path: string[]): void {
	const { change } = planned;
	const scope = change.scope;
	if (scope !== "global" && scope !== "project") {
		refuse(planned, "refused", "Pi settings need scope global or project.");
		return;
	}
	planned.scope = scope;
	planned.document = SCOPE_DOCUMENT[scope];
	planned.valuePath = path;
	planned.targetPath = path;
	const entry = planned.entry;
	const leaf = snapshot.leaves.get(change.id);
	const insideLeaf = snapshot.schema.leaves.some(
		(item) => item.path.length < path.length && item.path.every((segment, index) => segment === path[index]),
	);
	if (change.action === "set") planPiSet(snapshot, planned, path, entry, leaf, insideLeaf, scope);
	else if (change.action === "create") planPiCreate(snapshot, planned, path, entry, insideLeaf);
	else if (change.action === "delete" && entry?.kind !== "unregistered")
		refuse(planned, "refused", "delete removes unregistered keys; use unset to remove a stored Pi setting.");
	if (planned.result.status === "ok") assignMutate(planned, change, path);
}
/** Applies the owning section's rules; returns false when it refused the change. */
function planOwnedSection(
	planned: Planned,
	publication: Publication,
	path: string[],
	field: Field | undefined,
): boolean {
	const { change } = planned;
	const slice = publication.slice;
	if (path.length === 1) {
		refuse(planned, "refused", `The ${slice} extension owns this section; change its settings one at a time.`);
		return false;
	}
	if (!field) {
		if (change.action === "set" || change.action === "create") {
			refuse(
				planned,
				"refused",
				`The ${slice} extension does not declare ${path[1]}; it stays unregistered until the extension declares it.`,
			);
			return false;
		}
		return true;
	}
	if (change.action === "create" || change.action === "delete") {
		refuse(planned, "refused", "Declared settings use set and unset.");
		return false;
	}
	if (field.secret) {
		planned.secret = true;
		if (change.action === "set") {
			refuse(planned, "refused", `${field.env} is a secret and lives only in the environment; Config never stores it.`);
			return false;
		}
	}
	// The declared schema states what the owner accepts; its plain-word problems come before the owner's judgement.
	if (field.schema && change.action === "set" && change.value !== undefined) {
		const problems = validateValue(field.schema, field.schema, change.value, `${slice}.${path[1]}`);
		if (problems.length) {
			planned.result.status = "invalid";
			planned.result.problems.push(...problems);
			return false;
		}
	}
	return true;
}

function planHarness(snapshot: Snapshot, planned: Planned, path: string[]): void {
	const { change } = planned;
	if (change.scope !== undefined && change.scope !== "machine") {
		refuse(planned, "refused", "Harness settings live in the machine document; omit scope or use machine.");
		return;
	}
	const slice = path[0];
	if (slice === "version") {
		refuse(planned, "refused", "The document's version envelope is not a setting.");
		return;
	}
	if (path.length > 2) {
		refuse(planned, "refused", "Harness settings are stored whole; set the complete value of the setting.");
		return;
	}
	if (slice === ownSettings.slice && path[1] === "custom") {
		refuse(planned, "refused", "Change custom settings through their custom: ids.");
		return;
	}
	planned.valuePath = path;
	planned.targetPath = path;
	planned.slice = slice;
	const publication = snapshot.collection.publications.get(slice);
	const field = path.length === 2 ? publication?.declaration.fields[path[1]] : undefined;
	if (publication) {
		if (!planOwnedSection(planned, publication, path, field)) return;
	} else if (!change.raw) {
		refuse(
			planned,
			"refused",
			`No loaded extension answers for the ${slice} section, so no owner can validate this edit. Set raw: true to edit it as unvalidated JSON.`,
		);
		return;
	} else planned.result.notes.push(`No loaded extension validated this value; the ${slice} section is unmanaged here.`);
	if ((change.action === "set" || change.action === "create") && change.value === undefined) {
		refuse(planned, "invalid", `${change.action} needs a value.`);
		return;
	}
	assignMutate(planned, change, path);
}
/** Rewrites one custom entry in place from the change's value, description and type. */
function applyCustomChange(change: Change, entryPath: string[], document: Record<string, unknown>): void {
	const current = getAt(document, entryPath);
	const entry: Record<string, unknown> =
		current.present && isObject(current.value) ? structuredClone(current.value) : {};
	if (change.action === "delete") return void unsetAt(document, entryPath);
	if (change.action === "unset") delete entry.value;
	else if (change.value !== undefined) entry.value = change.value;
	if (change.description !== undefined) {
		if (change.description === "") delete entry.description;
		else entry.description = change.description;
	}
	if (change.type !== undefined) entry.type = change.type;
	setAt(document, entryPath, entry as Json);
}

/** The stored value the change leaves behind, for no-op detection. */
function customDesired(snapshot: Snapshot, planned: Planned, change: Change): Saved {
	if (change.action === "delete" || change.action === "unset" || change.value === undefined) {
		if (change.action !== "set") return { present: false };
		return getAt(snapshot.reads.harness.value, planned.valuePath);
	}
	return { present: true, value: change.value as Json };
}

/** Applies the change to a probe document and judges the entry with the owner's own rules. */
function probeCustomProblem(
	snapshot: Snapshot,
	name: string,
	entryPath: string[],
	change: Change,
	mutate: (document: Record<string, unknown>) => void,
): string | undefined {
	const probe: Record<string, unknown> = structuredClone(snapshot.reads.harness.value ?? { version: 1 });
	try {
		mutate(probe);
	} catch (error) {
		return (error as Error).message;
	}
	if (change.action === "delete") return;
	const result = getAt(probe, entryPath);
	if (result.present) return customEntryProblem(name, result.value);
}

function planCustom(snapshot: Snapshot, planned: Planned, path: string[]): void {
	const { change } = planned;
	if (change.scope !== undefined && change.scope !== "machine") {
		refuse(planned, "refused", "Custom settings live in the machine document; omit scope or use machine.");
		return;
	}
	if (path.length !== 1) {
		refuse(planned, "refused", "A custom id names one setting: custom:/<name>, with ~1 for / and ~0 for ~.");
		return;
	}
	const name = path[0];
	const entryPath = [ownSettings.slice, "custom", name];
	planned.slice = ownSettings.slice;
	planned.valuePath = [...entryPath, "value"];
	planned.targetPath = entryPath;
	const exists = snapshot.entries.has(change.id) || getAt(snapshot.reads.harness.value, entryPath).present;
	if (change.action === "create" && exists) {
		refuse(planned, "refused", `A custom setting named ${JSON.stringify(name)} exists; use set.`);
		return;
	}
	if (change.action !== "create" && !exists) {
		refuse(planned, "refused", `No custom setting named ${JSON.stringify(name)} exists; use create.`);
		return;
	}
	if (change.type !== undefined && !CUSTOM_TYPE_NAMES.includes(change.type)) {
		refuse(planned, "invalid", `type is one of ${CUSTOM_TYPE_NAMES.join(", ")}.`);
		return;
	}
	if (
		change.action === "set" &&
		change.value === undefined &&
		change.description === undefined &&
		change.type === undefined
	) {
		refuse(planned, "invalid", "set needs a value, a description or a type.");
		return;
	}
	planned.mutate = (document) => applyCustomChange(change, entryPath, document);
	planned.desired = customDesired(snapshot, planned, change);
	const problem = probeCustomProblem(snapshot, name, entryPath, change, planned.mutate);
	if (problem) refuse(planned, "invalid", problem);
}
function fieldName(item: Planned): string | undefined {
	if (!item.slice) return;
	return item.slice === ownSettings.slice && item.valuePath[1] === "custom"
		? `${item.slice}.custom`
		: `${item.slice}.${item.valuePath[1]}`;
}
function diagnosticKey(fact: Diagnostic): string {
	return `${fact.field}\0${fact.source}\0${fact.code}`;
}
/** The conflicts an owner reports between its own settings, absent before this edit. */
function newRelations(baseline: Publication | undefined, candidate: Publication): Diagnostic[] {
	const before = new Set((baseline?.diagnostics ?? []).map(diagnosticKey));
	return candidate.diagnostics.filter((fact) => fact.code === "relation" && !before.has(diagnosticKey(fact)));
}

function refuseAll(items: Planned[], status: ChangeResult["status"], problem: string): void {
	for (const item of items) if (!blocked(item)) refuse(item, status, problem);
}

function applyMutations(items: Planned[], next: Record<string, unknown>): void {
	for (const item of items) {
		if (blocked(item)) continue;
		try {
			item.mutate(next);
		} catch (error) {
			refuse(item, "invalid", (error as Error).message);
		}
	}
}

/** Groups the surviving changes by the owning section they must answer to. */
function ownedSlices(snapshot: Snapshot, items: Planned[]): Map<string, Planned[]> {
	const bySlice = new Map<string, Planned[]>();
	for (const item of items)
		if (item.slice && !blocked(item) && snapshot.collection.publications.has(item.slice))
			bySlice.set(item.slice, [...(bySlice.get(item.slice) ?? []), item]);
	return bySlice;
}

/** Predicts what this process selects after the change, from the owner's judgement and the environment. */
function predictedResolution(snapshot: Snapshot, item: Planned, name: string, candidate: Publication): void {
	if (!item.slice || item.valuePath.includes("custom")) return;
	const field = snapshot.collection.publications.get(item.slice)?.declaration.fields[item.valuePath[1]];
	if (field && snapshot.host.env[field.env] !== undefined) {
		const live = snapshot.collection.publications.get(item.slice)?.records.find((record) => record.name === name);
		item.result.notes.push(`${field.env} is set in this process, so this process keeps the environment value.`);
		item.result.resolved = {
			...(live?.value !== undefined && !live.secret ? { value: live.value } : {}),
			source: "env",
		};
		return;
	}
	const record = candidate.records.find((value) => value.name === name);
	if (!record) return;
	item.result.resolved = {
		...(record.value !== undefined && !record.secret ? { value: record.value } : {}),
		source: record.origin === "file" ? "machine" : record.value === undefined ? "unset" : "default",
	};
}

/** Refusals that the owner's judgement of one changed field supports. */
function fieldProblems(item: Planned, name: string, slice: string, candidate: Publication): void {
	for (const fact of candidate.diagnostics) {
		if (fact.field !== name || fact.source !== "file") continue;
		if (fact.code === "invalid") refuse(item, "invalid", `The ${slice} extension rejects this value.`);
		else if (fact.code === "secret") refuse(item, "refused", "This setting is environment-only.");
		else if (fact.code === "unknown" && (item.change.action === "set" || item.change.action === "create"))
			refuse(item, "refused", `The ${slice} extension does not declare this key.`);
	}
	if (candidate.diagnostics.some((fact) => fact.code === "document"))
		refuse(item, "refused", "The owner could not read the proposed settings document.");
	if (candidate.records.some((record) => record.name === name && record.origin === "env"))
		refuse(
			item,
			"refused",
			`The ${slice} extension kept an environment value, so it could not judge the stored value.`,
		);
}

/** Applies one owner's ordinary publication of the candidate document to the changes in its section. */
function judgeSlice(snapshot: Snapshot, slice: string, items: Planned[], judgement: Judgement): void {
	const candidate = judgement.candidate.get(slice);
	if (!candidate || judgement.unread.includes(slice)) {
		refuseAll(
			items,
			"refused",
			`The ${slice} extension did not read the proposed settings in this process, so it could not judge them. Nothing was written.`,
		);
		return;
	}
	const relations = newRelations(judgement.baseline.get(slice), candidate);
	const related = [...new Set(relations.map((fact) => fact.field))].join(", ");
	for (const item of items) {
		const name = fieldName(item) ?? "";
		fieldProblems(item, name, slice, candidate);
		if (related)
			refuse(
				item,
				"invalid",
				`The ${slice} extension reports a conflict between its settings after this change: ${related}.`,
			);
		if (!blocked(item)) predictedResolution(snapshot, item, name, candidate);
	}
}

/**
 * Lets each owner of a changed section judge the complete candidate document through its
 * ordinary publication, with the environment names of its fields removed, so the stored
 * values themselves are judged even where an environment value masks them here.
 */
function judgeOwners(snapshot: Snapshot, next: Record<string, unknown>, items: Planned[]): void {
	const bySlice = ownedSlices(snapshot, items);
	if (!bySlice.size) return;
	const unmask = [...bySlice.keys()].flatMap((slice) =>
		Object.values(snapshot.collection.publications.get(slice)?.declaration.fields ?? {}).map((field) => field.env),
	);
	const directory = join(snapshot.host.agentDir, "config-candidates");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, `${randomUUID()}.json`);
	writeFileSync(path, JSON.stringify(next), { mode: 0o600, flag: "wx" });
	try {
		const judgement = judgeCandidate(
			snapshot.host.bus,
			snapshot.host.env as Record<string, string | undefined>,
			path,
			unmask,
			[...bySlice.keys()],
		);
		for (const [slice, sectionItems] of bySlice) judgeSlice(snapshot, slice, sectionItems, judgement);
	} finally {
		rmSync(path, { force: true });
	}
}

/** Loads the candidate Pi documents through Pi's own manager and reports its complaints. */
function checkPiLoad(
	snapshot: Snapshot,
	document: DocumentName,
	next: Record<string, unknown>,
	items: Planned[],
): void {
	const scope = document === "pi-global" ? "global" : "project";
	const other = document === "pi-global" ? snapshot.reads["pi-project"].value : snapshot.reads["pi-global"].value;
	try {
		const manager = piManager(
			snapshot.host.pi.SettingsManager,
			scope === "global" ? next : other,
			scope === "project" ? next : other,
			snapshot.host.projectTrusted,
		);
		for (const error of manager.drainErrors() as { error: Error }[])
			refuseAll(items, "invalid", `Pi cannot load the result: ${String(error.error?.message ?? error).slice(0, 200)}`);
	} catch (error) {
		refuseAll(items, "invalid", `Pi cannot load the result: ${String((error as Error).message).slice(0, 200)}`);
	}
}

/** Validates every change against the document value it would produce. */
function validateDocument(
	snapshot: Snapshot,
	document: DocumentName,
	current: DocumentRead,
	items: Planned[],
): Record<string, unknown> | undefined {
	const base: Record<string, unknown> = current.value
		? structuredClone(current.value)
		: document === "harness"
			? { version: 1 }
			: {};
	const next = structuredClone(base);
	applyMutations(items, next);
	if (document === "harness") {
		if (Buffer.byteLength(JSON.stringify(next, null, 2)) > 131072)
			refuseAll(items, "invalid", "The machine document would exceed 131072 bytes.");
		else judgeOwners(snapshot, next, items);
	} else checkPiLoad(snapshot, document, next, items);
	return next;
}

function documentWritable(snapshot: Snapshot, document: DocumentName): string | undefined {
	const state = snapshot.catalogue.context.documents.find((item) => item.document === document);
	return state?.writable ? undefined : (state?.reason ?? "The document is unavailable.");
}

const DOCUMENT_NAMES: Record<DocumentName, string> = {
	harness: "harness settings",
	"pi-global": "Pi global settings",
	"pi-project": "Pi project settings",
};
function names(changes: ChangeResult[], label: (id: string) => string): string {
	const list = [...new Set(changes.map((change) => label(change.id)))];
	return list.length <= 3 ? list.join(", ") : `${list.slice(0, 3).join(", ")} and ${list.length - 3} more`;
}
function documentSummary(document: DocumentResult, label: (id: string) => string): string {
	const target = DOCUMENT_NAMES[document.document];
	const all = names(document.changes, label);
	switch (document.outcome) {
		case "committed":
			return `Saved ${all} in ${target}.`;
		case "unchanged":
			return `${all}: ${target} already held ${document.changes.length === 1 ? "this value" : "these values"}; nothing was written.`;
		case "previewed":
			return `${all}: valid for ${target}.`;
		case "conflict":
			return `Not saved: ${names(
				document.changes.filter((item) => item.status === "conflict"),
				label,
			)} changed in ${target} after the edit began.`;
		case "rejected":
			return `Not saved: ${names(document.changes.filter(blockedResult), label) || all} did not pass validation for ${target}.`;
		case "failed":
			return `Not saved in ${target}: ${document.error ?? "the write failed"}.`;
		case "not-attempted":
			return `Not saved: ${all} for ${target}, because another change in this request did not pass validation.`;
	}
}
function blockedResult(change: ChangeResult): boolean {
	return change.status !== "ok" && change.status !== "unchanged";
}
function summarize(result: EditResult, label: (id: string) => string): string {
	return result.documents.map((document) => documentSummary(document, label)).join(" ");
}
function labeller(snapshot: Snapshot): (id: string) => string {
	return (id) => {
		const known = snapshot.entries.get(id)?.label;
		if (known) return known;
		try {
			return parseEntryId(id).path.at(-1) ?? id;
		} catch {
			return id;
		}
	};
}

export type FindRow = {
	id: string;
	label: string;
	category: string;
	group: Entry["group"];
	kind: Entry["kind"];
	value: string;
	source: string;
	scopes: Scope[];
};

/** Rejects requests whose shape or size no operation can serve. */
function requestShapeProblem(request: EditRequest): string | undefined {
	if (
		!isObject(request) ||
		(request.mode !== "preview" && request.mode !== "commit") ||
		!Array.isArray(request.changes)
	)
		return "An edit request has mode preview or commit and a list of changes.";
	if (!request.changes.length || request.changes.length > MAX_CHANGES)
		return `An edit request has 1 to ${MAX_CHANGES} changes.`;
}

/** Plans every change and refuses two changes that target the same setting. */
function planChanges(snapshot: Snapshot, request: EditRequest): Planned[] {
	const items = request.changes.map((change) => plan(snapshot, change, request.mode, request.revisions));
	const seen = new Map<string, Planned>();
	for (const item of items) {
		if (blocked(item)) continue;
		const key = `${item.document}\0${item.valuePath.join("\0")}`;
		if (seen.has(key)) refuse(item, "refused", "Another change in this request targets the same setting.");
		seen.set(key, item);
	}
	return items;
}

function groupByDocument(items: Planned[]): Map<DocumentName, Planned[]> {
	const byDocument = new Map<DocumentName, Planned[]>();
	for (const item of items) byDocument.set(item.document, [...(byDocument.get(item.document) ?? []), item]);
	return byDocument;
}

function checkDocuments(snapshot: Snapshot, byDocument: Map<DocumentName, Planned[]>): void {
	for (const [document, documentItems] of byDocument) {
		const reason = documentWritable(snapshot, document);
		if (reason) refuseAll(documentItems, "refused", reason);
		validateDocument(snapshot, document, snapshot.reads[document], documentItems);
	}
}

function documentResults(
	snapshot: Snapshot,
	byDocument: Map<DocumentName, Planned[]>,
	rejected: boolean,
	mode: EditRequest["mode"],
): DocumentResult[] {
	return [...byDocument].map(([document, documentItems]) => ({
		document,
		scope: snapshot.specs[document].scope,
		path: snapshot.specs[document].path,
		outcome: rejected
			? documentItems.some(blocked)
				? "rejected"
				: "not-attempted"
			: mode === "preview"
				? "previewed"
				: "not-attempted",
		before: snapshot.reads[document].revision,
		after: null,
		changes: documentItems.map((item) => item.result),
	}));
}

/** The combined outcome of a commit across every document it touched. */
function commitOutcome(results: DocumentResult[], committed: boolean): EditResult["outcome"] {
	const outcomes = results.map((item) => item.outcome);
	if (outcomes.every((item) => item === "committed" || item === "unchanged"))
		return outcomes.includes("committed") ? "committed" : "unchanged";
	if (committed) return "partial";
	if (outcomes.includes("conflict")) return "conflict";
	if (outcomes.includes("rejected")) return "rejected";
	return "failed";
}

/** Judges one change against the locked document; returns what to do with it. */
function classifyItem(
	item: Planned,
	start: Record<string, unknown>,
	sameRevision: boolean,
	path: string,
): "refused" | "unchanged" | "pending" | "conflict" {
	const probe = structuredClone(start);
	try {
		item.mutate(probe);
	} catch (error) {
		refuse(item, "invalid", (error as Error).message);
		return "refused";
	}
	if (jsonEqual(getAt(probe, item.targetPath), getAt(start, item.targetPath))) {
		item.result.status = "unchanged";
		return "unchanged";
	}
	const stored = getAt(start, item.valuePath);
	const base = item.change.base;
	const matches =
		sameRevision || (base !== undefined && (item.secret ? stored.present === base.present : savedEqual(stored, base)));
	if (matches) return "pending";
	item.result.status = "conflict";
	item.result.current = item.secret && stored.present ? { present: true, value: "[hidden]" } : stored;
	item.result.problems.push(
		base !== undefined
			? "The stored value changed after this edit began."
			: `${path} changed after the revision this edit expected.`,
	);
	return "conflict";
}

/** Sorts the changes into pending writes and conflicts against the locked document. */
function classifyAll(
	items: Planned[],
	start: Record<string, unknown>,
	sameRevision: boolean,
	path: string,
): { pending: Planned[]; conflict: boolean } {
	const pending: Planned[] = [];
	let conflict = false;
	for (const item of items) {
		const decision = classifyItem(item, start, sameRevision, path);
		if (decision === "conflict") conflict = true;
		else if (decision === "pending") pending.push(item);
	}
	return { pending, conflict };
}

/** Applies activate and deactivate names to the current selection. */
function selectTools(
	all: Map<string, ToolInfoLike>,
	before: string[],
	activate: string[],
	deactivate: string[],
): { wanted: Set<string>; rejected: ToolsResult["rejected"] } {
	const rejected: ToolsResult["rejected"] = [];
	const wanted = new Set(before);
	for (const name of activate) {
		const tool = all.get(name);
		if (!tool) rejected.push({ name, reason: "No configured tool has this name in this session." });
		else if (tool.exposure === "hidden")
			rejected.push({ name, reason: "Hidden tools are never declared to the model." });
		else wanted.add(name);
	}
	for (const name of deactivate) {
		if (!all.has(name)) rejected.push({ name, reason: "No configured tool has this name in this session." });
		else wanted.delete(name);
	}
	return { wanted, rejected };
}

/** The one implementation of settings operations for tools, commands and the native bridge. */
export class ConfigBackend {
	private readonly listeners = new Set<() => void>();
	private readonly receipts = new Map<string, { fingerprint: string; result: EditResult }>();
	private readonly host: () => ConfigHost;

	constructor(host: () => ConfigHost) {
		this.host = host;
	}

	snapshot(): Snapshot {
		return buildSnapshot(this.host());
	}
	catalogue(): Catalogue {
		return this.snapshot().catalogue;
	}
	/** Reads only the three documents, to notice changes that another process made. */
	revisions(): Record<DocumentName, string | null> {
		const specs = documentSpecs(this.host());
		return {
			harness: readDocument(specs.harness).revision,
			"pi-global": readDocument(specs["pi-global"]).revision,
			"pi-project": readDocument(specs["pi-project"]).revision,
		};
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	find(query: { text?: string; group?: Entry["group"]; limit?: number; offset?: number }) {
		const snapshot = this.snapshot();
		const words = (query.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
		const ranked = snapshot.catalogue.entries
			.filter((entry) => !query.group || entry.group === query.group)
			.map((entry) => {
				const key = entry.path[entry.path.length - 1].toLowerCase();
				const haystack = [
					entry.id,
					entry.label,
					entry.category,
					entry.description,
					entry.env?.name ?? "",
					entry.path.join("."),
				]
					.join("\n")
					.toLowerCase();
				if (!words.every((word) => haystack.includes(word))) return undefined;
				const joined = words.join(" ");
				const score =
					(joined && (key === joined || entry.id.toLowerCase() === joined) ? 0 : 3) -
					(joined && entry.label.toLowerCase().startsWith(joined) ? 1 : 0) +
					(entry.kind === "setting" ? 0 : 1);
				return { entry, score };
			})
			.filter((item) => item !== undefined)
			.sort((a, b) => a.score - b.score || a.entry.id.localeCompare(b.entry.id));
		const limit = Math.min(Math.max(query.limit ?? 20, 1), 50);
		const offset = Math.max(query.offset ?? 0, 0);
		const rows: FindRow[] = ranked.slice(offset, offset + limit).map(({ entry }) => ({
			id: entry.id,
			label: entry.label,
			category: entry.category,
			group: entry.group,
			kind: entry.kind,
			value: entry.env?.secret
				? "(secret)"
				: entry.resolved.value === undefined
					? "(unset)"
					: preview(entry.resolved.value, 80),
			source: entry.resolved.source,
			scopes: entry.scopes,
		}));
		return {
			total: ranked.length,
			offset,
			rows,
			next: offset + rows.length < ranked.length ? offset + rows.length : undefined,
			coverage: snapshot.catalogue.coverage,
		};
	}

	get(ids: string[]) {
		const snapshot = this.snapshot();
		const entries: Entry[] = [];
		const missing: string[] = [];
		for (const id of ids) {
			const entry = snapshot.entries.get(id);
			if (!entry) {
				missing.push(id);
				continue;
			}
			entries.push(entry);
		}
		return {
			context: snapshot.catalogue.context,
			entries: entries.map((entry) => ({ ...entry, applyState: applyFor(entry, snapshot.host) })),
			missing,
			owners: snapshot.catalogue.owners.filter((owner) => entries.some((entry) => entry.owner === owner.owner)),
		};
	}

	/** Rejects malformed requests and replays a known requestId's stored result. */
	private replay(request: EditRequest, fingerprint: string): EditResult | undefined {
		if (request.requestId === undefined) return;
		const requestId = request.requestId;
		if (typeof requestId !== "string" || !requestId.length || requestId.length > 128)
			throw new Error("requestId has 1 to 128 characters.");
		const known = this.receipts.get(requestId);
		if (!known) return;
		if (known.fingerprint !== fingerprint) throw new Error("This requestId was used for different changes.");
		return structuredClone(known.result);
	}

	private earlyResult(
		request: EditRequest,
		snapshot: Snapshot,
		byDocument: Map<DocumentName, Planned[]>,
		rejected: boolean,
		results: DocumentResult[],
	): EditResult {
		if (!rejected) this.predict(snapshot, byDocument);
		const result: EditResult = {
			...(request.requestId ? { requestId: request.requestId } : {}),
			mode: request.mode,
			outcome: rejected ? "rejected" : "previewed",
			documents: results,
			summary: "",
		};
		result.summary = summarize(result, labeller(snapshot));
		return result;
	}

	/** Writes each document under its lock and reports what each write decided. */
	private async commitDocuments(
		snapshot: Snapshot,
		byDocument: Map<DocumentName, Planned[]>,
		results: DocumentResult[],
		revisions: EditRequest["revisions"],
	): Promise<boolean> {
		let committed = false;
		for (const documentResult of results) {
			const document = documentResult.document;
			const documentItems = byDocument.get(document) ?? [];
			const spec = snapshot.specs[document];
			try {
				const outcome = await withLockedDocument(
					spec,
					(current) => this.decide(snapshot, spec, current, documentItems, revisions?.[document]),
					{ createParent: document !== "harness" },
				);
				documentResult.outcome = outcome.written ? "committed" : outcome.result;
				if (outcome.written) {
					committed = true;
					documentResult.before = outcome.before;
					documentResult.after = outcome.after;
					if (outcome.readback === "changed")
						documentResult.error = "Another writer changed the file right after this write; read it again.";
				}
			} catch (error) {
				documentResult.outcome = "failed";
				documentResult.error = error instanceof Error ? error.message.slice(0, 300) : "The write failed.";
			}
		}
		return committed;
	}

	/** Refreshes resolutions from the written files and notifies listeners. */
	private afterCommit(items: Planned[]): void {
		const after = this.snapshot();
		for (const item of items) {
			const entry = after.entries.get(item.change.id);
			if (!entry) continue;
			item.result.resolved = entry.resolved;
			item.result.apply = applyFor(entry, after.host);
		}
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {}
		}
	}

	private remember(requestId: string | undefined, fingerprint: string, result: EditResult): void {
		if (!requestId) return;
		this.receipts.set(requestId, { fingerprint, result: structuredClone(result) });
		if (this.receipts.size > 128) this.receipts.delete(this.receipts.keys().next().value as string);
	}

	async edit(request: EditRequest): Promise<EditResult> {
		const problem = requestShapeProblem(request);
		if (problem) throw new Error(problem);
		const fingerprint = JSON.stringify(request);
		const replayed = this.replay(request, fingerprint);
		if (replayed) return replayed;
		const snapshot = this.snapshot();
		const items = planChanges(snapshot, request);
		const byDocument = groupByDocument(items);
		checkDocuments(snapshot, byDocument);
		const rejected = items.some(blocked);
		const results = documentResults(snapshot, byDocument, rejected, request.mode);
		if (rejected || request.mode === "preview")
			return this.earlyResult(request, snapshot, byDocument, rejected, results);
		const committed = await this.commitDocuments(snapshot, byDocument, results, request.revisions);
		if (committed) this.afterCommit(items);
		const result: EditResult = {
			...(request.requestId ? { requestId: request.requestId } : {}),
			mode: "commit",
			outcome: commitOutcome(results, committed),
			documents: results,
			summary: "",
		};
		result.summary = summarize(result, labeller(snapshot));
		this.remember(request.requestId, fingerprint, result);
		return result;
	}

	/** Decides the write under the document's lock from the file as it is now. */
	private decide(
		snapshot: Snapshot,
		spec: DocumentSpec,
		current: DocumentRead,
		items: Planned[],
		expected: string | null | undefined,
	):
		| { write: false; result: DocumentResult["outcome"] }
		| { write: true; value: Record<string, unknown>; result: DocumentResult["outcome"] } {
		if (current.status === "invalid" || current.status === "unavailable") {
			refuseAll(items, "refused", `${spec.path} is ${current.status}; Config does not replace it.`);
			return { write: false, result: "failed" };
		}
		const start: Record<string, unknown> = current.value
			? structuredClone(current.value)
			: spec.name === "harness"
				? { version: 1 }
				: {};
		const sameRevision = expected !== undefined && expected === current.revision;
		const sorted = classifyAll(items, start, sameRevision, spec.path);
		const pending = sorted.pending;
		if (items.some((item) => item.result.status === "invalid")) return { write: false, result: "rejected" };
		if (sorted.conflict) {
			for (const item of pending)
				item.result.notes.push("Not written because another change in this document conflicts.");
			return { write: false, result: "conflict" };
		}
		if (!pending.length) return { write: false, result: "unchanged" };
		const next = validateDocument(snapshot, spec.name, current, pending);
		if (pending.some(blocked) || !next) return { write: false, result: "rejected" };
		return { write: true, value: next, result: "committed" };
	}

	/** Fills predicted resolutions for a preview from the candidate documents. */
	private predict(snapshot: Snapshot, byDocument: Map<DocumentName, Planned[]>): void {
		if (byDocument.has("pi-global") || byDocument.has("pi-project")) this.predictPi(snapshot, byDocument);
		for (const item of byDocument.get("harness") ?? []) {
			const entry = item.entry;
			if (!entry) continue;
			item.result.apply = applyFor(entry, snapshot.host);
		}
	}

	private predictPi(snapshot: Snapshot, byDocument: Map<DocumentName, Planned[]>): void {
		const candidate = (document: "pi-global" | "pi-project") => {
			const value: Record<string, unknown> = structuredClone(snapshot.reads[document].value ?? {});
			for (const item of byDocument.get(document) ?? []) if (!blocked(item)) item.mutate(value);
			return value;
		};
		const global = candidate("pi-global");
		const project = candidate("pi-project");
		const manager = piManager(snapshot.host.pi.SettingsManager, global, project, snapshot.host.projectTrusted);
		let session: unknown;
		try {
			session = snapshot.host.sessionSettings?.();
		} catch {}
		const loaded = (value: Record<string, unknown>): DocumentRead => ({
			status: "loaded",
			revision: "",
			value,
			layout: { indent: "  ", newline: true },
		});
		const { entries } = piEntries(
			{
				host: snapshot.host,
				reads: { ...snapshot.reads, "pi-global": loaded(global), "pi-project": loaded(project) },
				schema: snapshot.schema,
				builtinTools: snapshot.builtinTools,
			},
			manager,
			session,
		);
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		for (const document of ["pi-global", "pi-project"] as const)
			for (const item of byDocument.get(document) ?? []) {
				const entry = byId.get(item.change.id);
				if (!entry) continue;
				item.result.resolved = entry.resolved;
				item.result.apply = applyFor(entry, snapshot.host);
			}
	}

	tools(): ToolsView {
		const host = this.host();
		const snapshot = buildSnapshot(host);
		const entry = snapshot.entries.get("pi:/defaultTools");
		const defaults = {
			resolved: Array.isArray(entry?.resolved.value) ? (entry.resolved.value as string[]) : snapshot.builtinTools,
			global: entry?.saved.global ?? { present: false as const },
			project: entry?.saved.project ?? { present: false as const },
		};
		const notes = [
			"Active tools are the tools declared to the model in this session. Tools with codemode or deferred exposure stay callable from codemode scripts while inactive.",
			"defaultTools selects the tools a new session starts with. /reload activates tools newly added to it and keeps the current selection otherwise.",
			"Loading extensions and packages is a separate resource setting (extensions, packages); a tool exists only when its extension loads.",
			"Whether a call is allowed is decided by policy and project trust, not by this selection.",
		];
		if (!host.tools)
			return {
				session: false,
				reason: "This host exposes no current-session tool controls.",
				tools: [],
				active: [],
				defaults,
				notes,
			};
		const active = host.tools.active();
		const tools = host.tools
			.all()
			.map((tool) => ({
				name: tool.name,
				exposure: tool.exposure,
				active: active.includes(tool.name),
				source: tool.sourceInfo?.source ?? "",
				description: (tool.description ?? "").split("\n", 1)[0].slice(0, 200),
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
		return { session: true, tools, active, defaults, notes };
	}

	applyTools(change: ToolsChange): ToolsResult {
		const host = this.host();
		if (!host.tools)
			return {
				applied: false,
				active: [],
				activated: [],
				deactivated: [],
				rejected: [],
				text: "This host exposes no current-session tool controls.",
			};
		const activate = Array.isArray(change?.activate) ? change.activate.filter((name) => typeof name === "string") : [];
		const deactivate = Array.isArray(change?.deactivate)
			? change.deactivate.filter((name) => typeof name === "string")
			: [];
		if (activate.length + deactivate.length > 128) throw new Error("A tool change names at most 128 tools.");
		const all = new Map(host.tools.all().map((tool) => [tool.name, tool]));
		const before = host.tools.active();
		const selection = selectTools(all, before, activate, deactivate);
		const next = [
			...before.filter((name) => selection.wanted.has(name)),
			...[...selection.wanted].filter((name) => !before.includes(name)),
		];
		const changed = !jsonEqual(next, before);
		if (changed) host.tools.setActive(next);
		const after = host.tools.active();
		const activated = after.filter((name) => !before.includes(name));
		const deactivated = before.filter((name) => !after.includes(name));
		const applied = jsonEqual([...after].sort(), [...next].sort());
		if (changed) for (const listener of this.listeners) listener();
		return {
			applied,
			active: after,
			activated,
			deactivated,
			rejected: selection.rejected,
			text: !changed
				? "The active tools already matched this request."
				: applied
					? "The session's active tools changed now. This change is not saved; defaultTools sets the selection for new sessions."
					: "Pi did not apply the whole selection; the active list shows what it applied.",
		};
	}
}
