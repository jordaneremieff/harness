/**
 * Shapes of the settings operations. The model tools, the native bridge and the
 * native page use these shapes; only the backend in this slice implements them.
 */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** A file that holds settings, as the backend resolved it for one host context. */
export type DocumentName = "harness" | "pi-global" | "pi-project";
export type Scope = "machine" | "global" | "project";
export type DocumentState = {
	document: DocumentName;
	scope: Scope;
	path: string;
	status: "loaded" | "missing" | "invalid" | "unavailable";
	/** `sha256:<hex>` of the bytes read, or null when no complete read exists. */
	revision: string | null;
	writable: boolean;
	/** Why the document cannot be written, when `writable` is false. */
	reason?: string;
};

/** The exact context every operation binds to. */
export type SettingsContext = {
	version: 1;
	machine: string;
	agentDir: string;
	cwd: string;
	/** Pi's project configuration directory for `cwd`. */
	projectDir: string;
	host: {
		kind: "ordinary" | "durable";
		pid: number;
		session?: string;
		piVersion: string;
		piPackage: string;
	};
	/** The host's own project-trust state; the backend never raises it. */
	projectTrusted: boolean;
	documents: DocumentState[];
};

/** A form descriptor derived from the Pi schema, an owner declaration or a custom entry. */
export type ValueSchema =
	| { type: "boolean" }
	| { type: "string"; minLength?: number; maxLength?: number; path?: "any" | "absolute"; multiline?: boolean }
	| { type: "number" | "integer"; minimum?: number; maximum?: number }
	| { type: "enum"; choices: Json[] }
	| { type: "array"; items: ValueSchema; minItems?: number }
	| { type: "object"; properties: Record<string, ValueSchema>; required?: string[]; additional: boolean }
	| { type: "map"; values: ValueSchema }
	| { type: "union"; options: ValueSchema[] }
	/** Any JSON value. `unsupported` names schema keywords that the backend cannot check. */
	| { type: "json"; unsupported?: string[] };

export type Saved = { present: false } | { present: true; value: Json };
export type ResolvedSource = "env" | "machine" | "project" | "global" | "default" | "unset" | "combined";
export type Resolution = {
	/** Absent for secrets and for values that cannot be shown. */
	value?: Json;
	source: ResolvedSource;
	/** One plain sentence when resolution needs explanation, such as a global-only setting. */
	note?: string;
};
export type ApplyTiming = "use" | "reload" | "restart" | "pi" | "custom" | "unknown";
export type ApplyState = {
	state: "applied" | "next-use" | "pending-reload" | "pending-restart" | "masked" | "not-applicable" | "unknown";
	text: string;
};

export type EntryGroup = "pi" | "harness" | "custom";
export type EntryKind = "setting" | "deprecated" | "internal" | "unregistered";
export type OwnerAvailability = "available" | "absent" | "changed" | "unavailable";

export type Entry = {
	/** `<group>:<JSON pointer>`, for example `pi:/compaction/enabled` or `custom:/a~1b`. */
	id: string;
	group: EntryGroup;
	/** Display section, such as `Compaction` or an extension name. */
	category: string;
	/** Path segments inside the destination document. */
	path: string[];
	label: string;
	description: string;
	kind: EntryKind;
	value: ValueSchema;
	/** Scopes that can store this entry. Empty when the entry is read-only. */
	scopes: Scope[];
	owner: string;
	ownerState: OwnerAvailability;
	/** Owner declaration digest for harness entries; the Pi schema digest for Pi entries. */
	schema?: string;
	saved: Partial<Record<Scope, Saved>>;
	resolved: Resolution;
	/** The value this host's running session uses, when the host exposes it. */
	session?: { value?: Json; differs: boolean };
	default?: { value?: Json; text?: string };
	env?: { name: string; set: boolean; secret: boolean };
	apply: { timing: ApplyTiming; text: string };
	/** Short problems that affect the operator's decision, such as an invalid saved value. */
	diagnostics: string[];
	/** True when an edit needs `raw: true`, for example an unmanaged section. */
	raw?: boolean;
	/** Why the entry cannot be edited, when `scopes` is empty. */
	readOnly?: string;
};

export type OwnerState = {
	owner: string;
	group: "pi" | "harness";
	state: OwnerAvailability;
	schema?: string;
	/** True when the owner's section exists in the machine document. */
	section?: boolean;
	detail: string;
};

export type Catalogue = {
	version: 1;
	generation: number;
	observedAt: string;
	context: SettingsContext;
	entries: Entry[];
	owners: OwnerState[];
	/** Plain statements of what discovery could not establish. */
	coverage: string[];
};

export type Change = {
	id: string;
	/** Required for Pi entries; harness and custom entries use the machine scope. */
	scope?: Scope;
	action: "set" | "unset" | "create" | "delete";
	value?: Json;
	/** Custom entries only. */
	description?: string;
	type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "json";
	/** The stored value the author saw at this path. */
	base?: Saved;
	/** Owner declaration digest the author saw. */
	schema?: string;
	/** Explicit raw edit of a target that no available owner validates. */
	raw?: boolean;
};
export type EditRequest = {
	requestId?: string;
	mode: "preview" | "commit";
	changes: Change[];
	/** Expected document revisions, keyed by document name. */
	revisions?: Partial<Record<DocumentName, string | null>>;
};
export type ChangeResult = {
	id: string;
	scope: Scope;
	action: Change["action"];
	status: "ok" | "unchanged" | "invalid" | "conflict" | "refused";
	problems: string[];
	/** Present for a conflict: the value now stored at the path. */
	current?: Saved;
	/** The resolution after the change, observed (commit) or predicted (preview). */
	resolved?: Resolution;
	apply?: ApplyState;
	/** Validation notes that do not block the change. */
	notes: string[];
};
export type DocumentResult = {
	document: DocumentName;
	scope: Scope;
	path: string;
	outcome: "previewed" | "unchanged" | "committed" | "rejected" | "conflict" | "failed" | "not-attempted";
	before: string | null;
	after: string | null;
	changes: ChangeResult[];
	error?: string;
};
export type EditResult = {
	requestId?: string;
	mode: EditRequest["mode"];
	outcome: "previewed" | "unchanged" | "committed" | "partial" | "rejected" | "conflict" | "failed";
	documents: DocumentResult[];
	/** Plain sentences for the operator, such as what was not written. */
	summary: string;
};

export type ToolRow = {
	name: string;
	exposure: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
	active: boolean;
	source: string;
	description: string;
};
export type ToolsView = {
	/** False when the host exposes no current-session tool controls. */
	session: boolean;
	reason?: string;
	tools: ToolRow[];
	active: string[];
	defaults: { resolved: string[]; global: Saved; project: Saved };
	notes: string[];
};
export type ToolsChange = { activate?: string[]; deactivate?: string[] };
export type ToolsResult = {
	applied: boolean;
	active: string[];
	activated: string[];
	deactivated: string[];
	rejected: { name: string; reason: string }[];
	text: string;
};

/** Native bridge wire. Every request is an authorised JSON POST; `client` is the pane's UUID. */
export const BRIDGE_PATHS = ["/connect", "/poll", "/catalogue", "/edit", "/tools", "/tools/apply", "/close"] as const;
export type BridgePath = (typeof BRIDGE_PATHS)[number];
export type BridgeCommand = { op: "reveal"; query?: string };
export type BridgeRequest = {
	"/connect": { version: 1; client: string; build?: string };
	"/poll": { client: string; after: number };
	"/catalogue": { client: string; generation: number };
	"/edit": { client: string; request: EditRequest };
	"/tools": { client: string };
	"/tools/apply": { client: string; change: ToolsChange };
	"/close": { client: string };
};
export type BridgeResponse = {
	"/connect": { ok: true; context: SettingsContext; label: string; build?: { expected?: string; current: boolean } };
	"/poll": { ok: true; sequence: number; command: BridgeCommand | null; changed: boolean };
	"/catalogue": { ok: true; generation: number; catalogue: Catalogue };
	"/edit": { ok: true; result: EditResult };
	"/tools": { ok: true; tools: ToolsView };
	"/tools/apply": { ok: true; result: ToolsResult };
	"/close": { ok: true };
};
export type BridgeError = { ok: false; error: string };
export const BRIDGE_REQUEST_BYTES = 1048576;
export const BRIDGE_POLL_MS = 25000;
