import { createHash } from "node:crypto";

export interface ServerRef {
	endpoint: string;
	hostId: string;
	instanceId: string;
	selection: string;
}

export interface ResourceRef {
	kind: "session" | "window" | "block";
	sessionId: string;
	windowId?: string;
	blockId?: string;
}

export interface OwnershipRecord {
	callId: string;
	requestDigest: string;
	ownerId: string;
	server: ServerRef;
	operation: string;
	phase: "pending" | "confirmed" | "unknown" | "closed" | "released";
	resources: ResourceRef[];
	createdAt: string;
	updatedAt: string;
	note?: string;
	pendingCleanupCallId?: string;
}

export interface OwnershipState {
	version: 1;
	records: OwnershipRecord[];
}

/** The adapter serialises updates atomically for each owner, including concurrent calls. */
export interface OwnershipStore {
	read(ownerId: string): Promise<OwnershipState>;
	update(ownerId: string, change: (current: OwnershipState) => OwnershipState): Promise<OwnershipState>;
}

export function initialOwnershipState(): OwnershipState {
	return { version: 1, records: [] };
}

export function requestDigest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function validateOwnershipState(value: unknown, maxRecords = 128): OwnershipState {
	currentFields(value, ["version", "records"], "state");
	const state = value as OwnershipState;
	if (state.version !== 1 || !Array.isArray(state.records) || state.records.length > maxRecords) {
		throw new Error("Rex ownership state is invalid or exceeds its record limit.");
	}
	const calls = new Set<string>();
	for (const record of state.records) {
		validateRecord(record);
		if (calls.has(record.callId)) throw new Error("Rex ownership call is duplicated.");
		calls.add(record.callId);
		for (const resource of record.resources) validateResource(resource);
	}
	if (Buffer.byteLength(JSON.stringify(state), "utf8") > 1048576)
		throw new Error("Rex ownership state exceeds its byte limit.");
	return structuredClone(state);
}

function validateRecord(record: OwnershipRecord): void {
	currentFields(record, ["callId", "requestDigest", "ownerId", "server", "operation", "phase", "resources", "createdAt", "updatedAt", "note", "pendingCleanupCallId"], "record");
	if (
		!record ||
		typeof record !== "object" ||
		!boundedText(record.callId, 1024) ||
		!boundedText(record.ownerId, 1024) ||
		!/^[a-f0-9]{64}$/.test(record.requestDigest) ||
		!boundedText(record.operation, 128) ||
		!["pending", "confirmed", "unknown", "closed", "released"].includes(record.phase)
	)
		throw new Error("Rex ownership record is invalid.");
	if (record.pendingCleanupCallId !== undefined && !boundedText(record.pendingCleanupCallId, 1024)) throw new Error("Rex pending cleanup identity is invalid.");
	validateServer(record.server);
	if (
		!Array.isArray(record.resources) ||
		record.resources.length > 32 ||
		!boundedText(record.createdAt, 64) ||
		!boundedText(record.updatedAt, 64) ||
		(record.note !== undefined && !boundedText(record.note, 2048))
	)
		throw new Error("Rex ownership record bounds are invalid.");
}
function validateServer(server: ServerRef): void {
	currentFields(server, ["endpoint", "hostId", "instanceId", "selection"], "server");
	if (
		!server ||
		!boundedText(server.endpoint, 4096) ||
		!boundedText(server.hostId, 128) ||
		!boundedText(server.instanceId, 128) ||
		!boundedText(server.selection, 4096)
	)
		throw new Error("Rex ownership server is invalid.");
}
function validateResource(resource: ResourceRef): void {
	currentFields(resource, ["kind", "sessionId", "windowId", "blockId"], "resource");
	if (!resource || !["session", "window", "block"].includes(resource.kind) || !fullId(resource.sessionId, "session"))
		throw new Error("Rex ownership resource is invalid.");
	if (resource.windowId !== undefined && !fullId(resource.windowId, "window"))
		throw new Error("Rex ownership window is invalid.");
	if (resource.blockId !== undefined && !fullId(resource.blockId, "block"))
		throw new Error("Rex ownership block is invalid.");
	if ((resource.kind === "window" && !resource.windowId) || (resource.kind === "block" && !resource.blockId))
		throw new Error("Rex ownership resource ID is missing.");
}

function currentFields(value: unknown, fields: readonly string[], name: string): void {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Rex ownership ${name} is invalid.`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) throw new Error(`Rex ownership ${name} is not a current plain object.`);
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string" || !fields.includes(key)) throw new Error(`Rex ownership ${name} has unsupported fields.`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor?.enumerable || descriptor.get || descriptor.set) throw new Error(`Rex ownership ${name} is not a current data object.`);
	}
}

export function fullId(value: unknown, kind: string): value is string {
	return (
		typeof value === "string" &&
		new RegExp(`^${kind}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`, "i").test(value)
	);
}

export function boundedText(value: unknown, max: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

export function beginOwnership(state: OwnershipState, record: OwnershipRecord, maxRecords = 128): OwnershipState {
	const next = validateOwnershipState(state, maxRecords);
	const previous = next.records.find((item) => item.callId === record.callId);
	if (previous) {
		throw new Error(
			previous.requestDigest === record.requestDigest
				? "This Rex call already has retained effects. Inspect or reconcile it; do not replay it."
				: "This Rex call ID already names different input.",
		);
	}
	if (next.records.length >= maxRecords)
		throw new Error("Rex ownership record limit reached. Forget closed records before more effects.");
	next.records.push(record);
	return validateOwnershipState(next, maxRecords);
}

export function changeOwnership(
	state: OwnershipState,
	callId: string,
	change: Partial<Pick<OwnershipRecord, "phase" | "resources" | "note" | "pendingCleanupCallId">>,
	maxRecords = 128,
): OwnershipState {
	const next = validateOwnershipState(state, maxRecords);
	const record = next.records.find((item) => item.callId === callId);
	if (!record) throw new Error("Rex ownership call does not exist.");
	Object.assign(record, change, { updatedAt: new Date().toISOString() });
	return validateOwnershipState(next, maxRecords);
}

export function sameServer(a: ServerRef, b: ServerRef): boolean {
	return a.endpoint === b.endpoint && a.hostId === b.hostId && a.instanceId === b.instanceId;
}
