import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { type DocumentRead, type DocumentSpec, readDocument } from "./documents.ts";
import { entryId, getAt, humanize, isObject, jsonEqual } from "./json.ts";
import {
	type Bus,
	type Collection,
	collectPublications,
	type Declaration,
	type Field,
	type Publication,
	type SettingRecord,
} from "./owners.ts";
import { loadPiSchema, type PiLeaf, type PiSchema, validateValue } from "./pi-schema.ts";
import type {
	ApplyState,
	Catalogue,
	DocumentName,
	DocumentState,
	Entry,
	Json,
	OwnerState,
	Resolution,
	Saved,
	Scope,
	SettingsContext,
	ToolRow,
	ValueSchema,
} from "./protocol.ts";
import { CUSTOM_TYPES, type CustomEntry, type CustomType, settings as ownSettings } from "./settings.ts";

export type Environment = Readonly<Record<string, string | undefined>>;
export type ToolInfoLike = {
	name: string;
	description?: string;
	exposure: ToolRow["exposure"];
	sourceInfo?: { source?: string; path?: string };
};
/** The public facts and controls of one host that the backend binds to. */
export type SettingsHost = {
	kind: "ordinary" | "durable";
	agentDir: string;
	cwd: string;
	session?: string;
	projectTrusted: boolean;
	bus: Bus;
	env: Environment;
	pi: {
		version: string;
		packageDir: string;
		configDir: string;
		// biome-ignore lint/suspicious/noExplicitAny: Pi's public SettingsManager class, passed by the host.
		SettingsManager: any;
	};
	/** The running session's or host's loaded Pi settings. */
	sessionSettings?: () => unknown;
	/** Current-session tool controls; ordinary sessions only. */
	tools?: { all(): ToolInfoLike[]; active(): string[]; setActive(names: string[]): void };
};

export type Snapshot = {
	catalogue: Catalogue;
	host: SettingsHost;
	specs: Record<DocumentName, DocumentSpec>;
	reads: Record<DocumentName, DocumentRead>;
	schema: PiSchema;
	collection: Collection;
	entries: Map<string, Entry>;
	leaves: Map<string, PiLeaf>;
	builtinTools: string[];
};

export function documentSpecs(host: SettingsHost): Record<DocumentName, DocumentSpec> {
	const override = host.env.PI_HARNESS_FILE;
	return {
		harness: {
			name: "harness",
			scope: "machine",
			kind: "harness",
			path: resolve(host.agentDir, override ?? "harness.json"),
		},
		"pi-global": { name: "pi-global", scope: "global", kind: "pi", path: join(host.agentDir, "settings.json") },
		"pi-project": {
			name: "pi-project",
			scope: "project",
			kind: "pi",
			path: join(resolve(host.cwd), host.pi.configDir, "settings.json"),
		},
	};
}
export const SCOPE_DOCUMENT: Record<Scope, DocumentName> = {
	machine: "harness",
	global: "pi-global",
	project: "pi-project",
};

function documentState(spec: DocumentSpec, read: DocumentRead, host: SettingsHost): DocumentState {
	const state: DocumentState = {
		document: spec.name,
		scope: spec.scope,
		path: spec.path,
		status: read.status,
		revision: read.revision,
		writable: read.status === "loaded" || read.status === "missing",
	};
	if (!state.writable) state.reason = `${read.problem ?? "The file is unavailable."} Settings does not replace it.`;
	if (spec.name === "harness" && host.env.PI_HARNESS_FILE !== undefined && !host.env.PI_HARNESS_FILE.length) {
		state.writable = false;
		state.reason = "PI_HARNESS_FILE is empty in this process.";
	}
	if (spec.name === "pi-project" && !host.projectTrusted) {
		state.writable = false;
		state.reason =
			"This session does not trust the project, so Pi ignores its settings file and Settings does not write it.";
	}
	return state;
}

/** Pi's resolution over exact file content through its public SettingsManager. */
// biome-ignore lint/suspicious/noExplicitAny: Pi's public SettingsManager class, passed by the host.
export function piManager(SettingsManager: any, global: unknown, project: unknown, trusted: boolean) {
	const text = (value: unknown) => (value === undefined ? undefined : JSON.stringify(value));
	const storage = {
		withLock(scope: "global" | "project", fn: (current: string | undefined) => string | undefined) {
			fn(scope === "global" ? text(global) : text(project));
		},
	};
	return SettingsManager.fromStorage(storage, { projectTrusted: trusted });
}
// biome-ignore lint/suspicious/noExplicitAny: Pi's public SettingsManager class, passed by the host.
function builtinDefaultTools(SettingsManager: any): string[] {
	// A list of only -name entries applies to Pi's built-in selection, so this reads it unchanged.
	const probe = SettingsManager.inMemory({ defaultTools: ["-\u0000"] });
	const tools = probe.getDefaultTools();
	return Array.isArray(tools) ? tools.filter((tool: unknown) => typeof tool === "string") : [];
}

function fieldSchema(field: Field): ValueSchema {
	switch (field.type) {
		case "boolean":
			return { type: "boolean" };
		case "enum":
			return { type: "enum", choices: field.choices ?? [] };
		case "integer":
		case "number":
			return {
				type: field.type,
				...(field.min !== undefined ? { minimum: field.min } : {}),
				...(field.max !== undefined ? { maximum: field.max } : {}),
			};
		case "string":
			return {
				type: "string",
				...(field.minLength !== undefined ? { minLength: field.minLength } : {}),
				...(field.maxLength !== undefined ? { maxLength: field.maxLength } : {}),
			};
		case "path":
			return { type: "string", minLength: 1, path: field.absolute ? "absolute" : "any" };
		case "json":
			return { type: "json" };
	}
}
function customSchema(type: CustomType | undefined): ValueSchema {
	switch (type) {
		case "string":
			return { type: "string" };
		case "number":
		case "integer":
			return { type };
		case "boolean":
			return { type: "boolean" };
		case "array":
			return { type: "array", items: { type: "json" } };
		case "object":
			return { type: "map", values: { type: "json" } };
		default:
			return { type: "json" };
	}
}

export const APPLY_TEXT = {
	use: "Applies at the next use in each process that loads the extension.",
	reload: "Applies after /reload or a new session; Durable agent hosts read it when they start.",
	restart: "Applies when the process that reads it starts again.",
	pi: "Pi reads its settings files at startup and at /reload. Some settings take effect only in a new process.",
	custom: "Nothing reads custom settings automatically; agents and the Settings app read them when asked.",
} as const;

export function applyFor(entry: Entry, host: SettingsHost): ApplyState {
	if (entry.env?.set)
		return {
			state: "masked",
			text: `${entry.env.name} is set in this process, so it keeps the environment value here. The saved value applies where ${entry.env.name} is unset.`,
		};
	if (entry.group === "custom") return { state: "not-applicable", text: APPLY_TEXT.custom };
	if (entry.group === "pi") {
		if (entry.resolved.source === "project" && !entry.saved.project?.present)
			return { state: "masked", text: "The project file overrides this setting here." };
		if (!entry.session) return { state: "unknown", text: "This host does not expose its loaded Pi settings." };
		if (entry.session.differs)
			return host.kind === "ordinary"
				? {
						state: "pending-reload",
						text: "This session still uses its loaded value. /reload loads the saved settings; session flags still apply.",
					}
				: {
						state: "pending-restart",
						text: "This agent host keeps the settings it loaded. A new host loads the saved value.",
					};
		return {
			state: "applied",
			text: "This session's loaded settings hold this value. Settings that Pi reads only at startup apply in a new process.",
		};
	}
	switch (entry.apply.timing) {
		case "use":
			return { state: "next-use", text: APPLY_TEXT.use };
		case "reload":
			return { state: "pending-reload", text: APPLY_TEXT.reload };
		case "restart":
			return { state: "pending-restart", text: APPLY_TEXT.restart };
		default:
			return { state: "unknown", text: "No owner declares when this value applies." };
	}
}

function harnessDiagnostics(publication: Publication, key: string, env: string): string[] {
	const name = `${publication.slice}.${key}`;
	const notes: string[] = [];
	for (const fact of publication.diagnostics) {
		if (fact.field !== name) continue;
		if (fact.code === "invalid")
			notes.push(
				fact.source === "env"
					? `${env} holds an invalid value in this process, so the default applies.`
					: "The saved value is invalid, so the default applies.",
			);
		else if (fact.code === "secret")
			notes.push("The machine document holds a value for this environment-only secret. Pi ignores it; remove it.");
		else if (fact.code === "relation") notes.push(`This value conflicts with another ${publication.slice} setting.`);
	}
	return notes;
}

type PiManager = {
	getSettings(): unknown;
	getGlobalSettings(): unknown;
	getDefaultTools(): string[] | undefined;
};

/** Reports saved values that the installed schema rejects, one problem per scope. */
function savedScopeProblems(
	snapshot: Pick<Snapshot, "host" | "schema">,
	leaf: PiLeaf,
	saved: Partial<Record<Scope, Saved>>,
): string[] {
	const problems: string[] = [];
	for (const scope of ["global", "project"] as const) {
		const value = saved[scope];
		if (value?.present && validateValue(snapshot.schema.root, leaf.schema, value.value, leaf.path.join(".")).length)
			problems.push(`The ${scope} value does not match the schema of Pi ${snapshot.host.pi.version}.`);
	}
	return problems;
}

function defaultToolsResolution(
	snapshot: Pick<Snapshot, "host" | "builtinTools">,
	manager: PiManager,
	saved: Partial<Record<Scope, Saved>>,
): Resolution {
	const trusted = snapshot.host.projectTrusted;
	const tools = manager.getDefaultTools();
	return tools
		? {
				value: tools,
				source: saved.project?.present && trusted ? (saved.global?.present ? "combined" : "project") : "global",
			}
		: { value: snapshot.builtinTools, source: "default" };
}

function globalOnlyResolution(
	migratedGlobal: unknown,
	leaf: PiLeaf,
	saved: Partial<Record<Scope, Saved>>,
	problems: string[],
): Resolution {
	const value = getAt(migratedGlobal, leaf.path);
	if (saved.project?.present)
		problems.push("Pi reads this setting only from agent-directory settings, so the project value has no effect.");
	return value.present ? { value: value.value, source: "global" } : defaultResolution(leaf);
}

function combinedResolution(leaf: PiLeaf, saved: Partial<Record<Scope, Saved>>, trusted: boolean): Resolution {
	const parts = (["global", "project"] as const).filter(
		(scope) => saved[scope]?.present && (scope === "global" || trusted),
	);
	const value = parts.flatMap((scope) => {
		const item = (saved[scope] as { value: Json }).value;
		return Array.isArray(item) ? item : [];
	});
	return parts.length
		? {
				value,
				source: parts.length === 2 ? "combined" : parts[0],
				note: "Pi's resource loader combines the global and project lists.",
			}
		: defaultResolution(leaf);
}

function storedResolution(
	merged: unknown,
	leaf: PiLeaf,
	saved: Partial<Record<Scope, Saved>>,
	trusted: boolean,
): Resolution {
	const value = getAt(merged, leaf.path);
	const source = trusted && saved.project?.present ? "project" : saved.global?.present ? "global" : undefined;
	if (leaf.deprecated && (saved.global?.present || saved.project?.present) && !value.present)
		return { source: "unset", note: "Pi migrates this legacy setting to its replacement when it loads settings." };
	return value.present && source ? { value: value.value, source } : defaultResolution(leaf);
}

function leafResolution(
	snapshot: Pick<Snapshot, "host" | "reads" | "schema" | "builtinTools">,
	manager: PiManager,
	merged: unknown,
	migratedGlobal: unknown,
	leaf: PiLeaf,
	saved: Partial<Record<Scope, Saved>>,
	problems: string[],
): Resolution {
	const trusted = snapshot.host.projectTrusted;
	if (leaf.path.length === 1 && leaf.path[0] === "defaultTools")
		return defaultToolsResolution(snapshot, manager, saved);
	if (leaf.globalOnly) return globalOnlyResolution(migratedGlobal, leaf, saved, problems);
	if (leaf.combined) return combinedResolution(leaf, saved, trusted);
	return storedResolution(merged, leaf, saved, trusted);
}

/** The session's loaded value and whether it differs from the resolved one. */
function sessionState(resolved: Resolution, sessionValue: { present: boolean; value?: Json }): Entry["session"] {
	const resolvedSaved: Saved =
		resolved.value === undefined ? { present: false } : { present: true, value: resolved.value };
	return {
		...(sessionValue.present ? { value: sessionValue.value } : {}),
		differs:
			resolved.source === "default" || resolved.source === "unset"
				? sessionValue.present && !(resolvedSaved.present && jsonEqual(sessionValue.value, resolvedSaved.value))
				: !(sessionValue.present && resolvedSaved.present && jsonEqual(sessionValue.value, resolvedSaved.value)),
	};
}

function leafEntry(
	snapshot: Pick<Snapshot, "host" | "schema">,
	leaf: PiLeaf,
	saved: Partial<Record<Scope, Saved>>,
	resolved: Resolution,
	diagnostics: string[],
	session: unknown,
): Entry {
	const visible = leaf.documented || !snapshot.schema.docs.available;
	const sessionValue = session === undefined ? undefined : getAt(session, leaf.path);
	const entry: Entry = {
		id: entryId("pi", leaf.path),
		group: "pi",
		category: leaf.deprecated ? "Deprecated" : visible ? leaf.category : "Internal",
		path: leaf.path,
		label: humanize(leaf.path[leaf.path.length - 1]),
		description: leaf.description,
		kind: leaf.deprecated ? "deprecated" : visible ? "setting" : "internal",
		value: leaf.value,
		scopes: leaf.globalOnly ? ["global"] : ["global", "project"],
		owner: "pi",
		ownerState: "available",
		schema: snapshot.schema.digest,
		saved,
		resolved,
		default: leaf.default,
		apply: { timing: "pi", text: APPLY_TEXT.pi },
		diagnostics,
	};
	if (entry.kind !== "setting") entry.raw = true;
	if (sessionValue) entry.session = sessionState(resolved, sessionValue);
	return entry;
}

/** One key stored under a schema object that the schema itself does not declare. */
function unregisteredPiEntry(
	snapshot: Pick<Snapshot, "host" | "schema">,
	manager: PiManager,
	trusted: boolean,
	global: unknown,
	project: unknown,
	objectPath: string[],
	key: string,
	known: Set<string>,
	seen: Set<string>,
): Entry | undefined {
	const path = [...objectPath, key];
	const id = entryId("pi", path);
	if (known.has(id) || seen.has(id) || (objectPath.length === 0 && key === "$schema")) return;
	if (
		snapshot.schema.leaves.some(
			(leaf) => leaf.path.length > path.length && leaf.path.slice(0, path.length).join("\0") === path.join("\0"),
		)
	)
		return;
	seen.add(id);
	const saved = { global: getAt(global, path), project: getAt(project, path) };
	const merged = getAt(manager.getSettings(), path);
	return {
		id,
		group: "pi",
		category: "Unregistered",
		path,
		label: path.join("."),
		description: `Pi ${snapshot.host.pi.version}'s settings schema does not declare this key. Pi keeps it; another extension may read it.`,
		kind: "unregistered",
		value: { type: "json" },
		scopes: ["global", "project"],
		owner: "pi",
		ownerState: "available",
		schema: snapshot.schema.digest,
		saved,
		resolved: merged.present
			? { value: merged.value, source: trusted && saved.project.present ? "project" : "global" }
			: { source: "unset" },
		apply: { timing: "pi", text: APPLY_TEXT.pi },
		diagnostics: [],
		raw: true,
	};
}

function unregisteredObjectEntries(
	snapshot: Pick<Snapshot, "host" | "schema">,
	manager: PiManager,
	trusted: boolean,
	global: unknown,
	project: unknown,
	objectPath: string[],
	known: Set<string>,
): Entry[] {
	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const scope of ["global", "project"] as const) {
		const container = getAt(scope === "global" ? global : project, objectPath);
		if (!container.present || !isObject(container.value)) continue;
		for (const key of Object.keys(container.value)) {
			const entry = unregisteredPiEntry(snapshot, manager, trusted, global, project, objectPath, key, known, seen);
			if (entry) entries.push(entry);
		}
	}
	return entries;
}

function unregisteredPiEntries(
	snapshot: Pick<Snapshot, "host" | "schema">,
	manager: PiManager,
	global: unknown,
	project: unknown,
	known: Set<string>,
): Entry[] {
	const trusted = snapshot.host.projectTrusted;
	const entries: Entry[] = [];
	for (const objectPath of snapshot.schema.objects)
		entries.push(...unregisteredObjectEntries(snapshot, manager, trusted, global, project, objectPath, known));
	return entries;
}

export function piEntries(
	snapshot: Pick<Snapshot, "host" | "reads" | "schema" | "builtinTools">,
	manager: PiManager,
	session: unknown,
): { entries: Entry[]; leaves: Map<string, PiLeaf> } {
	const { host, reads, schema } = snapshot;
	const global = reads["pi-global"].value;
	const project = reads["pi-project"].value;
	const merged = manager.getSettings();
	const migratedGlobal = manager.getGlobalSettings();
	const trusted = host.projectTrusted;
	const entries: Entry[] = [];
	const leaves = new Map<string, PiLeaf>();
	const known = new Set<string>();
	for (const leaf of schema.leaves) {
		const id = entryId("pi", leaf.path);
		known.add(id);
		leaves.set(id, leaf);
		const saved: Partial<Record<Scope, Saved>> = {
			global: getAt(global, leaf.path),
			project: getAt(project, leaf.path),
		};
		const diagnostics = savedScopeProblems(snapshot, leaf, saved);
		const resolved = leafResolution(snapshot, manager, merged, migratedGlobal, leaf, saved, diagnostics);
		if (saved.project?.present && !trusted)
			diagnostics.push("Pi ignores the project value because this session does not trust the project.");
		entries.push(leafEntry(snapshot, leaf, saved, resolved, diagnostics, session));
	}
	// Keys that the installed schema does not declare stay visible as unregistered entries.
	entries.push(...unregisteredPiEntries(snapshot, manager, global, project, known));
	return { entries, leaves };
}
function defaultResolution(leaf: PiLeaf): Resolution {
	return leaf.default?.value !== undefined
		? { value: leaf.default.value, source: "default" }
		: { source: "unset", ...(leaf.default?.text ? { note: `Pi's default: ${leaf.default.text}.` } : {}) };
}

function secretResolution(record: SettingRecord): Resolution {
	return {
		source: record.origin === "env" ? "env" : "unset",
		note: record.secretState === "set" ? "Set in the environment; the value is never shown." : undefined,
	};
}

function plainRecordResolution(record: SettingRecord): Resolution {
	return {
		...(record.value !== undefined ? { value: record.value } : {}),
		source:
			record.origin === "env"
				? "env"
				: record.origin === "file"
					? "machine"
					: record.value === undefined
						? "unset"
						: "default",
	};
}

function fieldResolution(record: SettingRecord | undefined): Resolution {
	const resolved: Resolution = !record
		? { source: "unset" }
		: record.secret
			? secretResolution(record)
			: plainRecordResolution(record);
	if (resolved.note === undefined) delete resolved.note;
	return resolved;
}

/** The default the declaration names, with the observed value when the owner confirmed it. */
function fieldDefault(field: Field, record: SettingRecord | undefined): Entry["default"] {
	if (field.default !== undefined) return { value: field.default };
	if (field.defaultText === undefined) return;
	return {
		text: field.defaultText,
		...(record && record.origin === "default" && record.value !== undefined ? { value: record.value } : {}),
	};
}

function harnessFieldEntry(
	host: SettingsHost,
	document: unknown,
	publication: Publication,
	key: string,
	field: Field,
	changed: boolean,
): Entry {
	const slice = publication.slice;
	const record = publication.records.find((item) => item.key === key);
	const saved = getAt(document, [slice, key]);
	const standard = fieldDefault(field, record);
	const entry: Entry = {
		id: entryId("harness", [slice, key]),
		group: "harness",
		category: slice,
		path: [slice, key],
		label: humanize(key),
		description: field.description,
		kind: "setting",
		value: fieldSchema(field),
		scopes: field.secret ? [] : ["machine"],
		owner: slice,
		ownerState: changed ? "changed" : "available",
		schema: publication.schema,
		saved: { machine: field.secret ? (saved.present ? { present: true, value: "[hidden]" } : saved) : saved },
		resolved: fieldResolution(record),
		...(standard ? { default: standard } : {}),
		env: { name: field.env, set: host.env[field.env] !== undefined, secret: Boolean(field.secret) },
		apply: { timing: field.apply, text: APPLY_TEXT[field.apply] },
		diagnostics: harnessDiagnostics(publication, key, field.env),
	};
	if (field.secret) entry.readOnly = `Secret: set ${field.env} in the environment. Settings never stores it.`;
	return entry;
}

/** Sections of the machine document that no loaded owner answers for, with their entries. */
function orphanSections(document: unknown, collection: Collection): { entries: Entry[]; owners: OwnerState[] } {
	const entries: Entry[] = [];
	const owners: OwnerState[] = [];
	if (!isObject(document)) return { entries, owners };
	for (const slice of Object.keys(document)) {
		if (slice === "version" || collection.publications.has(slice)) continue;
		const section = document[slice];
		owners.push({
			owner: slice,
			group: "harness",
			state: "absent",
			section: true,
			detail: "No loaded extension in this process answers for this section. Its values stay as they are.",
		});
		if (isObject(section))
			for (const key of Object.keys(section))
				entries.push(unmanagedEntry(slice, key, getAt(document, [slice, key]), "absent"));
		else
			entries.push({
				...unmanagedEntry(slice, "", { present: true, value: section as Json }, "absent"),
				id: entryId("harness", [slice]),
				path: [slice],
				label: slice,
			});
	}
	return { entries, owners };
}

function publicationOwner(
	slice: string,
	publication: Publication,
	section: Saved,
	changed: boolean | undefined,
): OwnerState {
	return {
		owner: slice,
		group: "harness",
		state: changed ? "changed" : "available",
		schema: publication.schema,
		section: section.present,
		detail: changed
			? "The extension's settings declaration changed since the previous read."
			: "The extension answered in this process.",
	};
}

/** Keys stored under an owned section that its declaration does not name. */
function unmanagedSectionKeys(document: unknown, publication: Publication, slice: string, section: Saved): Entry[] {
	const entries: Entry[] = [];
	if (!section.present || !isObject(section.value)) return entries;
	for (const key of Object.keys(section.value)) {
		if (Object.hasOwn(publication.declaration.fields, key)) continue;
		entries.push(unmanagedEntry(slice, key, getAt(document, [slice, key]), "available", publication.schema));
	}
	return entries;
}

function harnessEntries(
	host: SettingsHost,
	read: DocumentRead,
	collection: Collection,
	previous?: Map<string, string>,
): { entries: Entry[]; owners: OwnerState[] } {
	const document = read.value;
	const entries: Entry[] = [];
	const owners: OwnerState[] = [];
	for (const publication of [...collection.publications.values()].sort((a, b) => a.slice.localeCompare(b.slice))) {
		const slice = publication.slice;
		const section = getAt(document, [slice]);
		const changed = previous?.has(slice) && previous.get(slice) !== publication.schema;
		owners.push(publicationOwner(slice, publication, section, changed));
		for (const [key, field] of Object.entries(publication.declaration.fields)) {
			if (slice === ownSettings.slice && key === "custom") continue;
			entries.push(harnessFieldEntry(host, document, publication, key, field, Boolean(changed)));
		}
		entries.push(...unmanagedSectionKeys(document, publication, slice, section));
	}
	const orphans = orphanSections(document, collection);
	return { entries: [...entries, ...orphans.entries], owners: [...owners, ...orphans.owners] };
}
function unmanagedEntry(
	slice: string,
	key: string,
	saved: Saved,
	ownerState: "available" | "absent",
	schema?: string,
): Entry {
	return {
		id: entryId("harness", [slice, key]),
		group: "harness",
		category: slice,
		path: [slice, key],
		label: key,
		description:
			ownerState === "available"
				? `The ${slice} extension does not declare this key. It stays unregistered until the extension declares it.`
				: `No loaded extension answers for the ${slice} section. Settings keeps its values and edits them only as raw JSON.`,
		kind: "unregistered",
		value: { type: "json" },
		scopes: ["machine"],
		owner: slice,
		ownerState,
		...(schema ? { schema } : {}),
		saved: { machine: saved },
		resolved: saved.present ? { value: saved.value, source: "machine" } : { source: "unset" },
		apply: { timing: "unknown", text: "No loaded owner reads this value in this process." },
		diagnostics: ownerState === "available" ? ["The owner reports this key as unknown."] : [],
		raw: true,
	};
}

/** The value an owner recorded for the custom map, or the stored one when no environment masks it. */
function customLiveValue(
	masked: boolean,
	effective: Record<string, CustomEntry>,
	item: CustomEntry | undefined,
	name: string,
): CustomEntry | undefined {
	return masked ? effective[name] : item;
}

function customEntryRow(
	publication: Publication | undefined,
	masked: boolean,
	effective: Record<string, CustomEntry>,
	stored: Record<string, unknown>,
	name: string,
): Entry {
	const item = isObject(stored[name]) ? (stored[name] as CustomEntry) : undefined;
	const live = customLiveValue(masked, effective, item, name);
	const type = item?.type && (CUSTOM_TYPES as readonly string[]).includes(item.type) ? item.type : undefined;
	const entrySaved: Saved =
		item && Object.hasOwn(item, "value") ? { present: true, value: item.value as Json } : { present: false };
	return {
		id: entryId("custom", [name]),
		group: "custom",
		category: "Custom",
		path: [ownSettings.slice, "custom", name],
		label: name,
		description: typeof item?.description === "string" ? item.description : "",
		kind: "setting",
		value: customSchema(type),
		scopes: ["machine"],
		owner: ownSettings.slice,
		ownerState: publication ? "available" : "unavailable",
		...(publication ? { schema: publication.schema } : {}),
		saved: { machine: entrySaved },
		resolved:
			live && Object.hasOwn(live, "value")
				? { value: live.value as Json, source: masked ? "env" : "machine" }
				: { source: "unset" },
		env: { name: ownSettings.fields.custom.env, set: masked, secret: false },
		apply: { timing: "custom", text: APPLY_TEXT.custom },
		diagnostics: [],
	};
}

function customEntries(host: SettingsHost, read: DocumentRead, collection: Collection): Entry[] {
	const saved = getAt(read.value, [ownSettings.slice, "custom"]);
	const stored = saved.present && isObject(saved.value) ? (saved.value as Record<string, unknown>) : {};
	const publication = collection.publications.get(ownSettings.slice);
	const record = publication?.records.find((item) => item.key === "custom");
	const effective =
		record?.value !== undefined && isObject(record.value) ? (record.value as Record<string, CustomEntry>) : {};
	const masked = host.env[ownSettings.fields.custom.env] !== undefined;
	const names = new Set([...Object.keys(stored), ...(masked ? Object.keys(effective) : [])]);
	return [...names]
		.sort((a, b) => a.localeCompare(b))
		.map((name) => customEntryRow(publication, masked, effective, stored, name));
}

let generation = 0;
const schemaHistory = new WeakMap<Bus, Map<string, string>>();

/** Reads every source once and builds the catalogue for one host context. */
export function buildSnapshot(host: SettingsHost): Snapshot {
	const specs = documentSpecs(host);
	const reads = {
		harness: readDocument(specs.harness),
		"pi-global": readDocument(specs["pi-global"]),
		"pi-project": readDocument(specs["pi-project"]),
	};
	const schema = loadPiSchema(host.pi.packageDir);
	const collection = collectPublications(host.bus);
	const builtinTools = builtinDefaultTools(host.pi.SettingsManager);
	const manager = piManager(
		host.pi.SettingsManager,
		reads["pi-global"].value,
		reads["pi-project"].value,
		host.projectTrusted,
	);
	let session: unknown;
	try {
		session = host.sessionSettings?.();
	} catch {
		session = undefined;
	}
	const pi = piEntries({ host, reads, schema, builtinTools }, manager, session);
	const previous = schemaHistory.get(host.bus);
	const harness = harnessEntries(host, reads.harness, collection, previous);
	schemaHistory.set(host.bus, new Map([...collection.publications.values()].map((item) => [item.slice, item.schema])));
	const custom = customEntries(host, reads.harness, collection);
	const all = [...pi.entries, ...harness.entries, ...custom];
	const context: SettingsContext = {
		version: 1,
		machine: hostname(),
		agentDir: host.agentDir,
		cwd: host.cwd,
		projectDir: join(resolve(host.cwd), host.pi.configDir),
		host: {
			kind: host.kind,
			pid: process.pid,
			...(host.session ? { session: host.session } : {}),
			piVersion: host.pi.version,
			piPackage: host.pi.packageDir,
		},
		projectTrusted: host.projectTrusted,
		documents: (Object.keys(specs) as DocumentName[]).map((name) => documentState(specs[name], reads[name], host)),
	};
	const coverage = [
		`Pi settings come from the schema of Pi ${host.pi.version} at ${schema.path}.`,
		schema.docs.available
			? "Sections, descriptions and documented defaults come from the installed settings reference."
			: "The installed settings reference is unavailable, so Pi entries lack sections and internal records are not separated.",
		...schema.problems,
		`Harness settings come from ${collection.publications.size} extension${collection.publications.size === 1 ? "" : "s"} that answered in this process. Extensions that this process does not load cannot answer; their saved sections appear as unmanaged.`,
		...(collection.malformed
			? [
					`${collection.malformed} publication${collection.malformed === 1 ? " was" : "s were"} malformed or used another contract version.`,
				]
			: []),
		...(collection.omitted ? [`${collection.omitted} publications were omitted at the owner limit.`] : []),
	];
	const owners: OwnerState[] = [
		{ owner: "pi", group: "pi", state: "available", schema: schema.digest, detail: `Pi ${host.pi.version}` },
		...harness.owners,
	];
	const catalogue: Catalogue = {
		version: 1,
		generation: ++generation,
		observedAt: new Date().toISOString(),
		context,
		entries: all,
		owners,
		coverage,
	};
	return {
		catalogue,
		host,
		specs,
		reads,
		schema,
		collection,
		entries: new Map(all.map((entry) => [entry.id, entry])),
		leaves: pi.leaves,
		builtinTools,
	};
}

export function declarationOf(snapshot: Snapshot, slice: string): Declaration | undefined {
	return snapshot.collection.publications.get(slice)?.declaration;
}
