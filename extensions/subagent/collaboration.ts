import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
	CollaborationEvent,
	CollaborationParticipant,
	CollaborationQuery,
	CollaborationSnapshot,
} from "./collaboration-types.ts";
import type { WorkerRecord } from "./index.ts";
import type { PeerReceipt } from "./peers.ts";
import {
	outstandingRequiredObligations,
	projectObligations,
	sanitizeWorkReference,
	unacceptedObligations,
	type ReferencedExchange,
} from "./work-references.ts";
import {
	type EntryReader,
	type EntrySnapshot,
	readSelectedSession,
	selectedEntries,
	SESSION_SNAPSHOT_BYTES,
} from "./session-evidence.ts";

export const COLLABORATION_LIMITS = {
	records: 512,
	members: 64,
	events: 1024,
	eventBytes: 256 * 1024,
	textBytes: 8192,
	historyBytes: 8 * SESSION_SNAPSHOT_BYTES,
} as const;

export interface CollaborationSources {
	current: EntryReader;
	/** Already known records, prioritized for the requested family before the source cap. */
	records: (preferredSession?: string) => Iterable<WorkerRecord>;
	/** Handles already owned by live sessions, including nested workers. */
	managers: () => Iterable<EntryReader>;
	receipt?: (sessionId: string, messageId: string) => PeerReceipt | null;
	messageText?: (text: string, actorId: string) => string;
}

function object(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function string(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 && value.length <= 200 ? value : null;
}
function clip(text: string, bytes: number = COLLABORATION_LIMITS.textBytes): string {
	// Limit traversal before UTF-8 accounting, including very large live content.
	const prefix = text.slice(0, bytes);
	let used = 0;
	let out = "";
	for (const char of prefix) {
		const size = Buffer.byteLength(char);
		if (used + size > bytes - 20) return `${out}\n[content omitted]`;
		used += size;
		out += char;
	}
	return prefix.length < text.length ? `${out}\n[content omitted]` : out;
}

/** One description owns its traversal budget across nested arguments. */
class ArgumentProjection {
	visits = 0;

	project(item: unknown, depth: number): unknown {
		if (++this.visits > 128 || depth > 5) return "[content omitted]";
		if (typeof item === "string") return clip(item);
		if (item === null || typeof item === "number" || typeof item === "boolean") return item;
		if (Array.isArray(item)) return this.array(item, depth);
		return this.record(object(item), depth);
	}

	array(items: unknown[], depth: number): unknown[] {
		const result: unknown[] = [];
		for (let i = 0; i < Math.min(items.length, 32) && this.visits <= 128; i++) result.push(this.project(items[i], depth + 1));
		if (items.length > result.length) result.push("[content omitted]");
		return result;
	}

	record(source: Record<string, unknown>, depth: number): unknown {
		if (source.type === "image") return "[image]";
		const result: Record<string, unknown> = {};
		let count = 0;
		for (const key in source) {
			if (!Object.hasOwn(source, key)) continue;
			if (count++ >= 32 || this.visits > 128) {
				result.omitted = true;
				break;
			}
			result[clip(key, 200)] = this.project(source[key], depth + 1);
		}
		return result;
	}
}

/** Bounded traversal of tool arguments and text parts; images never copy their payload. */
function describe(value: unknown): string {
	if (typeof value === "string") return clip(value);
	if (Array.isArray(value)) {
		const text: string[] = [];
		for (let i = 0; i < Math.min(value.length, 32); i++) {
			const part = object(value[i]);
			if (part.type === "text" && typeof part.text === "string") text.push(clip(part.text));
			else if (part.type === "image") text.push("[image]");
		}
		if (text.length > 0) return clip(text.join("\n"));
	}
	return clip(JSON.stringify(new ArgumentProjection().project(value, 0)));
}

const toolNames = new Set([
	"subagent",
	"subagent_status",
	"subagent_inspect",
	"subagent_steer",
	"subagent_interrupt",
	"subagent_continue",
	"subagent_collect",
	"subagent_kill",
	"subagent_report",
	"subagent_peers",
	"subagent_message",
	"submit_result",
]);
const customTypes = new Set(["subagent_peer", "subagent_report", "subagent_result", "subagent_paused"]);
const receiptStates = new Set(["sent_unconfirmed", "context_seen", "target_closed"]);

/** Walk a session's ownership ancestry (self first), cycle-safe and bounded by membership. */
export function collaborationFamilyChain(sessionId: string, bySession: ReadonlyMap<string, WorkerRecord>): string[] {
	const chain: string[] = [];
	const seen = new Set<string>();
	let id: string | null = sessionId;
	while (id && !seen.has(id)) {
		const record = bySession.get(id);
		if (!record) break;
		seen.add(id);
		chain.push(id);
		id = record.ownerSession;
	}
	return chain;
}

/** Resolve ownership without treating continuation as parentage. */
export function collaborationFamilyId(sessionId: string, bySession: ReadonlyMap<string, WorkerRecord>, notice: (text: string) => void = () => {}): string {
	const chain = collaborationFamilyChain(sessionId, bySession);
	const last = chain.at(-1);
	if (last === undefined) return sessionId;
	const record = bySession.get(last);
	if (!record) return sessionId;
	const next = record.ownerSession;
	if (!next) return `unavailable:${record.id}`;
	if (bySession.has(next)) {
		notice("Worker ownership contains a cycle; its family uses an unavailable manager.");
		return `unavailable:${[...chain].sort()[0]}`;
	}
	return next;
}

type EventBase = Omit<CollaborationEvent, "id" | "kind" | "text">;
type CustomEntry = Extract<SessionEntry, { type: "custom" | "custom_message" }>;
interface SelectedSource {
	sessionId: string;
	record: WorkerRecord | null;
}

function participantState(record: WorkerRecord): string {
	if (record.state !== "running") return record.state;
	if (record.interruptedAt) return "paused";
	return record.idleSince != null ? "idle" : "active";
}

function outcomeText(record: WorkerRecord): string {
	const submitted = record.state === "done" && record.stopReason === "submitted" &&
		typeof record.resultBytes === "number" && Number.isFinite(record.resultBytes) && record.resultBytes >= 0;
	return [
		`Recorded terminal state: ${record.state}.`,
		`Recorded exit time: ${record.exitedAt ?? "unavailable"}.`,
		submitted
			? `Submitted-result preview (worker record; unverified): ${clip(record.resultPreview || "(empty submitted result)", 2048)}`
			: `Final output (not a submitted result): ${clip(record.lastOutput || record.resultPreview || "(no final output recorded)", 2048)}`,
		...(record.error ? [`Recorded error: ${clip(record.error, 1024)}`] : []),
	].join("\n");
}

function recordedReceipt(status: unknown): string | null {
	const value = string(status);
	return value && receiptStates.has(value) ? `recorded ${value}` : null;
}

function exchangeKind(customType: string): "peer" | "report" | "result" | "pause" {
	switch (customType) {
		case "subagent_peer": return "peer";
		case "subagent_report": return "report";
		case "subagent_result": return "result";
		default: return "pause";
	}
}

/** A query owns all bounds, identity maps, and observations; no state crosses queries. */
class CollaborationProjection {
	readonly sources: CollaborationSources;
	readonly query: CollaborationQuery;
	readonly notices = new Set<string>();
	readonly records = new Map<string, WorkerRecord>();
	readonly bySession = new Map<string, WorkerRecord>();
	readonly familyMap = new Map<string, string>();
	readonly managers = new Map<string, EntryReader>();
	readonly members: WorkerRecord[] = [];
	readonly events: CollaborationEvent[] = [];
	readonly references: ReferencedExchange[] = [];
	readonly peerEnvelopes = new Map<string, string>();
	readonly receiptIds = new Set<string>();
	readonly currentId: string;
	familyId = "";
	eventBytes = 0;
	historyBytes = 0;
	exhausted = false;

	constructor(sources: CollaborationSources, query: CollaborationQuery) {
		this.sources = sources;
		this.query = query;
		this.readRecords();
		this.currentId = sources.current.getSessionId();
		this.selectFamily();
		this.readManagers();
	}

	notice(text: string): void {
		if (this.notices.size < 128) this.notices.add(clip(text, 512));
	}

	readRecords(): void {
		let visits = 0;
		for (const record of this.sources.records(this.query.familyId ?? this.sources.current.getSessionId())) {
			if (++visits > COLLABORATION_LIMITS.records) {
				this.notice("The known-record limit was reached; additional families or members were omitted.");
				break;
			}
			if ([record.id, record.sessionId, record.ownerSession ?? ""].some((id) => id.length > 200)) {
				this.notice("A record with an oversized identity was omitted.");
				continue;
			}
			if (!this.records.has(record.id)) this.records.set(record.id, record);
		}
		for (const record of this.records.values()) if (record.sessionId) this.bySession.set(record.sessionId, record);
	}

	root(sessionId: string): string {
		return collaborationFamilyId(sessionId, this.bySession, (text) => this.notice(text));
	}

	recordFamily(record: WorkerRecord): string {
		return record.ownerSession ? this.root(record.ownerSession) : `unavailable:${record.id}`;
	}

	selectFamily(): void {
		const currentRoot = this.root(this.currentId);
		this.familyMap.set(currentRoot, currentRoot === this.currentId ? "Current session" : "Current dispatch family");
		for (const record of this.records.values()) {
			const id = this.recordFamily(record);
			if (!this.familyMap.has(id)) this.familyMap.set(id, `Family ${clip(id, 100)}`);
		}
		const requested = this.query.familyId;
		this.familyId = requested && this.familyMap.has(requested) ? requested : currentRoot;
		if (requested && !this.familyMap.has(requested)) this.notice("The selected family is unavailable; the current family is shown.");
		this.selectMembers();
	}

	selectMembers(): void {
		for (const record of this.records.values()) {
			if (this.recordFamily(record) !== this.familyId) continue;
			if (this.members.length === COLLABORATION_LIMITS.members) {
				this.notice("The family member limit was reached; additional members were omitted.");
				break;
			}
			this.members.push(record);
		}
	}

	readManagers(): void {
		this.managers.set(this.currentId, this.sources.current);
		let visits = 0;
		for (const manager of this.sources.managers()) {
			if (++visits > COLLABORATION_LIMITS.records) {
				this.notice("The live manager limit was reached.");
				break;
			}
			this.managers.set(manager.getSessionId(), manager);
		}
	}

	address(id: string | null): string | null {
		return id ? (this.bySession.get(id)?.id ?? id) : null;
	}

	participants(): CollaborationParticipant[] {
		const participants: CollaborationParticipant[] = [{
			id: this.familyId, parentId: null, label: this.managers.has(this.familyId) ? "Manager" : "Manager unavailable",
			task: "", model: "", state: this.managers.has(this.familyId) ? "live" : "unavailable", workerId: null, continuedFrom: null,
		}];
		for (const record of this.members) participants.push({
			id: record.id, parentId: this.address(record.ownerSession) ?? this.familyId, label: record.label ?? record.id,
			task: clip(record.task, 2048), model: clip(record.model, 256), state: participantState(record),
			workerId: record.id, continuedFrom: string(record.continuedFrom),
		});
		return participants;
	}

	add(event: CollaborationEvent): boolean {
		const bytes = Buffer.byteLength(JSON.stringify(event));
		if (this.events.length >= COLLABORATION_LIMITS.events || this.eventBytes + bytes > COLLABORATION_LIMITS.eventBytes) {
			this.notice("The event count or byte limit was reached; additional evidence was omitted.");
			this.exhausted = true;
			return false;
		}
		this.events.push(event);
		this.eventBytes += bytes;
		return true;
	}

	recordEvents(): void {
		for (const record of this.members) this.add({
			id: `dispatch:${record.id}`, actorId: this.address(record.ownerSession) ?? this.familyId, recipientId: record.id,
			kind: "dispatch", text: clip(record.task, 2048), timestamp: record.createdAt, source: "worker record",
			sourceSessionId: record.ownerSession ?? this.familyId, entryId: null, messageId: null, replyTo: null, workerId: record.id, receipt: null,
		});
		for (const record of this.members) {
			if (record.state === "running") continue;
			this.add({
				id: `outcome:${record.id}`, actorId: record.id, recipientId: this.address(record.ownerSession) ?? this.familyId,
				kind: "worker outcome", text: outcomeText(record), timestamp: record.exitedAt ?? record.createdAt, source: "worker record",
				sourceSessionId: record.sessionId, entryId: null, messageId: null, replyTo: null, workerId: record.id, receipt: null,
			});
		}
	}

	readSource(selected: SelectedSource): { snapshot: EntrySnapshot; source: string } | null {
		const { sessionId, record } = selected;
		const manager = this.managers.get(sessionId);
		if (this.query.history && record?.sessionFile) {
			const snapshot = readSelectedSession(record.sessionFile, sessionId,
				Math.min(SESSION_SNAPSHOT_BYTES, COLLABORATION_LIMITS.historyBytes - this.historyBytes));
			this.historyBytes += snapshot.bytes;
			if (!snapshot.entries.length && snapshot.notices.length && manager) {
				for (const text of snapshot.notices) this.notice(`${record.id}: ${text}`);
				this.notice(`${record.id}: available live entries remain visible; file history is unavailable.`);
				return { snapshot: selectedEntries(manager), source: "live session entry" };
			}
			return { snapshot, source: "selected session file" };
		}
		if (manager) return { snapshot: selectedEntries(manager), source: "live session entry" };
		this.notice(`${record?.id ?? "Manager"}: ${this.query.history ? "no known session file or live manager is available" : "no live session entries; select history for known worker files"}.`);
		return null;
	}

	sessionEvents(): void {
		const selectedSources: SelectedSource[] = [{ sessionId: this.familyId, record: null },
			...this.members.map((record) => ({ sessionId: record.sessionId, record }))];
		for (const selected of selectedSources) {
			if (this.exhausted) break;
			const read = this.readSource(selected);
			if (!read) continue;
			for (const text of read.snapshot.notices) this.notice(`${selected.record?.id ?? "Manager"}: ${text}`);
			for (const entry of read.snapshot.entries) {
				if (this.exhausted) break;
				this.entryEvent(entry, selected, read.source);
			}
		}
	}

	entryEvent(entry: SessionEntry, selected: SelectedSource, source: string): void {
		if (!string(entry.id)) {
			this.notice("An entry with an invalid identity was omitted.");
			return;
		}
		const base: EventBase = {
			actorId: selected.record?.id ?? this.familyId, recipientId: null, timestamp: Date.parse(entry.timestamp) || 0,
			source, sourceSessionId: selected.sessionId, entryId: entry.id, messageId: null, replyTo: null,
			workerId: selected.record?.id ?? null, receipt: null,
		};
		if (entry.type === "message") this.messageEvent(object(entry.message), base, selected.record);
		else if ((entry.type === "custom_message" || entry.type === "custom") && customTypes.has(entry.customType))
			this.customEvent(entry, base, selected.record);
	}

	messageEvent(message: Record<string, unknown>, base: EventBase, record: WorkerRecord | null): void {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content.slice(0, 64)) this.callEvent(object(part), base, record);
		} else if (message.role === "toolResult" && typeof message.toolName === "string" && toolNames.has(message.toolName)) {
			const details = object(message.details);
			this.add({
				...base, id: `${base.sourceSessionId}:${base.entryId}:result:${string(message.toolCallId) ?? "unknown"}`,
				kind: `result ${message.toolName}`, text: describe(message.content), messageId: string(details.id) ?? string(message.toolCallId),
				recipientId: this.address(string(details.to)), replyTo: string(details.replyTo), receipt: recordedReceipt(details.status),
			});
		}
	}

	callEvent(call: Record<string, unknown>, base: EventBase, record: WorkerRecord | null): void {
		if (call.type !== "toolCall" || typeof call.name !== "string" || !toolNames.has(call.name)) return;
		if (!string(call.id)) {
			this.notice("A tool call with an invalid identity was omitted.");
			return;
		}
		const args = object(call.arguments);
		const event: CollaborationEvent = {
			...base, id: `${base.sourceSessionId}:${base.entryId}:call:${call.id}`, kind: `call ${call.name}`,
			text: describe(call.arguments), messageId: string(call.id),
			recipientId: this.address(args.to === "parent" ? (record?.ownerSession ?? null) : (string(args.to) ?? string(args.id))),
			replyTo: string(args.replyTo),
		};
		if ((call.name === "subagent_message" || call.name === "subagent_steer") && typeof args.message === "string")
			event.exchange = { kind: call.name === "subagent_message" ? "peer" : "steer", text: clip(args.message) };
		this.add(event);
	}

	reference(details: Record<string, unknown>, author: string, timestamp: number): void {
		if (details.reference === undefined) return;
		const result = sanitizeWorkReference(details.reference);
		if ("error" in result) this.notice(`A peer message reference was omitted: ${result.error}`);
		else this.references.push({ author, reference: result.reference, timestamp });
	}

	customEvent(entry: CustomEntry, base: EventBase, record: WorkerRecord | null): void {
		const details = object(entry.type === "custom_message" ? entry.details : entry.data);
		const peer = entry.customType === "subagent_peer";
		const messageId = peer ? string(details.id) : null;
		const body = describe(entry.type === "custom_message" ? entry.content : entry.data);
		const fingerprint = JSON.stringify([string(details.from), string(details.to), string(details.replyTo), body]);
		const prior = messageId ? this.peerEnvelopes.get(messageId) : undefined;
		const duplicate = prior === fingerprint;
		const conflict = prior !== undefined && !duplicate;
		if (messageId && prior === undefined) this.peerEnvelopes.set(messageId, fingerprint);
		if (conflict) this.notice("A peer message identity has conflicting envelope evidence; both observations are shown.");
		const messageActor = this.address(string(peer ? details.from : details.id)) ?? base.actorId;
		if (peer) this.reference(details, messageActor, Date.parse(entry.timestamp) || 0);
		const displayText = this.sources.messageText?.(body, messageActor) ?? body;
		this.addCustomEvent({ entry, base, record, details, peer, messageId, prior, duplicate, conflict, body, messageActor, displayText });
		if (messageId) this.receiptEvent(messageId, base);
	}

	addCustomEvent(input: {
		entry: CustomEntry; base: EventBase; record: WorkerRecord | null; details: Record<string, unknown>; peer: boolean;
		messageId: string | null; prior: string | undefined; duplicate: boolean; conflict: boolean; body: string; messageActor: string; displayText: string;
	}): void {
		const { entry, base, record, details, peer, messageId, prior, duplicate, conflict, body, messageActor, displayText } = input;
		this.add({
			...base, id: messageId && prior === undefined ? `peer:${messageId}` : `${base.sourceSessionId}:${entry.id}:${entry.customType}`,
			kind: conflict ? "peer conflicting envelope" : duplicate ? "peer occurrence" : entry.customType,
			text: duplicate ? "The same peer envelope occurs in this session ancestry." : body,
			actorId: messageActor, recipientId: this.address(string(peer ? details.to : details.ownerSession)) ?? base.actorId,
			messageId, replyTo: string(details.replyTo), workerId: peer ? (record?.id ?? null) : string(details.id),
			...(!duplicate ? { exchange: { kind: exchangeKind(entry.customType), text: displayText } } : {}),
			receipt: peer ? "recorded envelope; no context acknowledgement" : recordedReceipt(details.status),
		});
	}

	receiptEvent(messageId: string, base: EventBase): void {
		if (this.receiptIds.has(messageId)) return;
		const receipt = this.sources.receipt?.(base.sourceSessionId, messageId) ?? this.sources.receipt?.(this.currentId, messageId);
		if (!receipt) return;
		this.receiptIds.add(messageId);
		this.add({
			...base, id: `receipt:${messageId}`, kind: "peer receipt", actorId: receipt.from, recipientId: receipt.to,
			text: "Process-local receipt. Context observation is not model understanding or durable acknowledgement.",
			source: "live peer receipt", messageId, replyTo: receipt.replyTo, receipt: `live ${receipt.status}`,
		});
	}

	snapshot(): CollaborationSnapshot {
		const participants = this.participants();
		this.recordEvents();
		this.sessionEvents();
		const obligations = projectObligations(this.references);
		return {
			familyId: this.familyId, families: [...this.familyMap].map(([id, label]) => ({ id, label })), participants,
			events: this.events, obligations, outstandingRequired: outstandingRequiredObligations(obligations),
			unaccepted: unacceptedObligations(obligations), notices: [...this.notices],
		};
	}
}

/** A fresh projection; the panel owns explicit history snapshots and their lifetime. */
export function createCollaborationReader(sources: CollaborationSources): (query: CollaborationQuery) => Promise<CollaborationSnapshot> {
	return async (query) => new CollaborationProjection(sources, query).snapshot();
}
