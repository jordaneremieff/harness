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

/** Bounded traversal of tool arguments and text parts; images never copy their payload. */
function describe(value: unknown): string {
	let visits = 0;
	function project(item: unknown, depth: number): unknown {
		if (++visits > 128 || depth > 5) return "[content omitted]";
		if (typeof item === "string") return clip(item);
		if (item === null || typeof item === "number" || typeof item === "boolean") return item;
		if (Array.isArray(item)) {
			const result: unknown[] = [];
			for (let i = 0; i < Math.min(item.length, 32) && visits <= 128; i++) result.push(project(item[i], depth + 1));
			if (item.length > result.length) result.push("[content omitted]");
			return result;
		}
		const source = object(item);
		if (source.type === "image") return "[image]";
		const result: Record<string, unknown> = {};
		let count = 0;
		for (const key in source) {
			if (!Object.hasOwn(source, key)) continue;
			if (count++ >= 32 || visits > 128) {
				result.omitted = true;
				break;
			}
			result[clip(key, 200)] = project(source[key], depth + 1);
		}
		return result;
	}
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
	return clip(JSON.stringify(project(value, 0)));
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
	while (id && bySession.has(id) && !seen.has(id)) {
		seen.add(id);
		chain.push(id);
		id = bySession.get(id)!.ownerSession;
	}
	return chain;
}

/** Resolve ownership without treating continuation as parentage. */
export function collaborationFamilyId(sessionId: string, bySession: ReadonlyMap<string, WorkerRecord>, notice: (text: string) => void = () => {}): string {
	const chain = collaborationFamilyChain(sessionId, bySession);
	if (chain.length === 0) return sessionId;
	const last = chain.at(-1)!;
	const next = bySession.get(last)!.ownerSession;
	if (!next) return `unavailable:${bySession.get(last)!.id}`;
	if (bySession.has(next)) {
		notice("Worker ownership contains a cycle; its family uses an unavailable manager.");
		return `unavailable:${[...chain].sort()[0]}`;
	}
	return next;
}

/** A fresh projection; the panel owns explicit history snapshots and their lifetime. */
export function createCollaborationReader(
	sources: CollaborationSources,
): (query: CollaborationQuery) => Promise<CollaborationSnapshot> {
	return async (query) => {
		const notices = new Set<string>();
		const notice = (text: string) => {
			if (notices.size < 128) notices.add(clip(text, 512));
		};
		const records = new Map<string, WorkerRecord>();
		let visits = 0;
		for (const record of sources.records(query.familyId ?? sources.current.getSessionId())) {
			if (++visits > COLLABORATION_LIMITS.records) {
				notice("The known-record limit was reached; additional families or members were omitted.");
				break;
			}
			if ([record.id, record.sessionId, record.ownerSession ?? ""].some((id) => id.length > 200)) {
				notice("A record with an oversized identity was omitted.");
				continue;
			}
			if (!records.has(record.id)) records.set(record.id, record);
		}
		const bySession = new Map<string, WorkerRecord>();
		for (const record of records.values()) if (record.sessionId) bySession.set(record.sessionId, record);
		const currentId = sources.current.getSessionId();
		const root = (sessionId: string) => collaborationFamilyId(sessionId, bySession, notice);
		const familyMap = new Map<string, string>();
		const currentRoot = root(currentId);
		familyMap.set(currentRoot, currentRoot === currentId ? "Current session" : "Current dispatch family");
		for (const record of records.values()) {
			const id = record.ownerSession ? root(record.ownerSession) : `unavailable:${record.id}`;
			if (!familyMap.has(id)) familyMap.set(id, `Family ${clip(id, 100)}`);
		}
		const familyId = query.familyId && familyMap.has(query.familyId) ? query.familyId : currentRoot;
		if (query.familyId && !familyMap.has(query.familyId))
			notice("The selected family is unavailable; the current family is shown.");
		const members: WorkerRecord[] = [];
		for (const record of records.values()) {
			const id = record.ownerSession ? root(record.ownerSession) : `unavailable:${record.id}`;
			if (id !== familyId) continue;
			if (members.length === COLLABORATION_LIMITS.members) {
				notice("The family member limit was reached; additional members were omitted.");
				break;
			}
			members.push(record);
		}
		const managers = new Map<string, EntryReader>([[currentId, sources.current]]);
		visits = 0;
		for (const manager of sources.managers()) {
			if (++visits > COLLABORATION_LIMITS.records) {
				notice("The live manager limit was reached.");
				break;
			}
			managers.set(manager.getSessionId(), manager);
		}
		const participants: CollaborationParticipant[] = [
			{
				id: familyId,
				parentId: null,
				label: managers.has(familyId) ? "Manager" : "Manager unavailable",
				task: "",
				model: "",
				state: managers.has(familyId) ? "live" : "unavailable",
				workerId: null,
				continuedFrom: null,
			},
		];
		function address(id: string | null): string | null {
			return id ? (bySession.get(id)?.id ?? id) : null;
		}
		for (const record of members) {
			const parent = address(record.ownerSession);
			participants.push({
				id: record.id,
				parentId: parent ?? familyId,
				label: record.label ?? record.id,
				task: clip(record.task, 2048),
				model: clip(record.model, 256),
				state: record.state === "running" ? (record.interruptedAt ? "paused" : record.idleSince != null ? "idle" : "active") : record.state,
				workerId: record.id,
				continuedFrom: string(record.continuedFrom),
			});
		}
		const events: CollaborationEvent[] = [];
		const references: ReferencedExchange[] = [];
		let eventBytes = 0;
		let exhausted = false;
		function add(event: CollaborationEvent): boolean {
			const bytes = Buffer.byteLength(JSON.stringify(event));
			if (events.length >= COLLABORATION_LIMITS.events || eventBytes + bytes > COLLABORATION_LIMITS.eventBytes) {
				notice("The event count or byte limit was reached; additional evidence was omitted.");
				exhausted = true;
				return false;
			}
			events.push(event);
			eventBytes += bytes;
			return true;
		}
		for (const record of members)
			add({
				id: `dispatch:${record.id}`,
				actorId: address(record.ownerSession) ?? familyId,
				recipientId: record.id,
				kind: "dispatch",
				text: clip(record.task, 2048),
				timestamp: record.createdAt,
				source: "worker record",
				sourceSessionId: record.ownerSession ?? familyId,
				entryId: null,
				messageId: null,
				replyTo: null,
				workerId: record.id,
				receipt: null,
			});
		for (const record of members) {
			if (record.state === "running") continue;
			const submitted =
				record.state === "done" &&
				record.stopReason === "submitted" &&
				typeof record.resultBytes === "number" &&
				Number.isFinite(record.resultBytes) &&
				record.resultBytes >= 0;
			const text = [
				`Recorded terminal state: ${record.state}.`,
				`Recorded exit time: ${record.exitedAt ?? "unavailable"}.`,
				submitted
					? `Submitted-result preview (worker record; unverified): ${clip(record.resultPreview || "(empty submitted result)", 2048)}`
					: `Final output (not a submitted result): ${clip(record.lastOutput || record.resultPreview || "(no final output recorded)", 2048)}`,
				...(record.error ? [`Recorded error: ${clip(record.error, 1024)}`] : []),
			].join("\n");
			add({
				id: `outcome:${record.id}`,
				actorId: record.id,
				recipientId: address(record.ownerSession) ?? familyId,
				kind: "worker outcome",
				text,
				timestamp: record.exitedAt ?? record.createdAt,
				source: "worker record",
				sourceSessionId: record.sessionId,
				entryId: null,
				messageId: null,
				replyTo: null,
				workerId: record.id,
				receipt: null,
			});
		}
		const peerEnvelopes = new Map<string, string>();
		const receiptIds = new Set<string>();
		let historyBytes = 0;
		const selectedSources = [
			{ sessionId: familyId, record: null as WorkerRecord | null },
			...members.map((record) => ({ sessionId: record.sessionId, record })),
		];
		for (const selected of selectedSources) {
			if (exhausted) break;
			const { sessionId, record } = selected;
			const manager = managers.get(sessionId);
			let snapshot: EntrySnapshot;
			let source = "live session entry";
			if (query.history && record?.sessionFile) {
				snapshot = readSelectedSession(
					record.sessionFile,
					sessionId,
					Math.min(SESSION_SNAPSHOT_BYTES, COLLABORATION_LIMITS.historyBytes - historyBytes),
				);
				historyBytes += snapshot.bytes;
				source = "selected session file";
				if (!snapshot.entries.length && snapshot.notices.length && manager) {
					for (const text of snapshot.notices) notice(`${record.id}: ${text}`);
					notice(`${record.id}: available live entries remain visible; file history is unavailable.`);
					snapshot = selectedEntries(manager);
					source = "live session entry";
				}
			} else if (manager) snapshot = selectedEntries(manager);
			else {
				notice(
					`${record?.id ?? "Manager"}: ${query.history ? "no known session file or live manager is available" : "no live session entries; select history for known worker files"}.`,
				);
				continue;
			}
			for (const text of snapshot.notices) notice(`${record?.id ?? "Manager"}: ${text}`);
			for (const entry of snapshot.entries) {
				if (exhausted) break;
				if (!string(entry.id)) {
					notice("An entry with an invalid identity was omitted.");
					continue;
				}
				const actorId = record?.id ?? familyId;
				const base = {
					actorId,
					recipientId: null,
					timestamp: Date.parse(entry.timestamp) || 0,
					source,
					sourceSessionId: sessionId,
					entryId: entry.id,
					messageId: null,
					replyTo: null,
					workerId: record?.id ?? null,
					receipt: null,
				};
				if (entry.type === "message") {
					const message = object(entry.message);
					if (message.role === "assistant" && Array.isArray(message.content)) {
						for (const part of message.content.slice(0, 64)) {
							const call = object(part);
							if (call.type !== "toolCall" || typeof call.name !== "string" || !toolNames.has(call.name)) continue;
							if (!string(call.id)) {
								notice("A tool call with an invalid identity was omitted.");
								continue;
							}
							const args = object(call.arguments);
							add({
								...base,
								id: `${sessionId}:${entry.id}:call:${call.id}`,
								kind: `call ${call.name}`,
								text: describe(call.arguments),
								messageId: string(call.id),
								recipientId: address(
									args.to === "parent" ? (record?.ownerSession ?? null) : (string(args.to) ?? string(args.id)),
								),
								replyTo: string(args.replyTo),
								...((call.name === "subagent_message" || call.name === "subagent_steer") &&
								typeof args.message === "string"
									? {
											exchange: {
												kind: call.name === "subagent_message" ? ("peer" as const) : ("steer" as const),
												text: clip(args.message),
											},
										}
									: {}),
							});
						}
					} else if (
						message.role === "toolResult" &&
						typeof message.toolName === "string" &&
						toolNames.has(message.toolName)
					) {
						const details = object(message.details);
						const status = string(details.status);
						add({
							...base,
							id: `${sessionId}:${entry.id}:result:${string(message.toolCallId) ?? "unknown"}`,
							kind: `result ${message.toolName}`,
							text: describe(message.content),
							messageId: string(details.id) ?? string(message.toolCallId),
							recipientId: address(string(details.to)),
							replyTo: string(details.replyTo),
							receipt: status && receiptStates.has(status) ? `recorded ${status}` : null,
						});
					}
				} else if ((entry.type === "custom_message" || entry.type === "custom") && customTypes.has(entry.customType)) {
					const details = object(entry.type === "custom_message" ? entry.details : entry.data);
					const peer = entry.customType === "subagent_peer";
					const messageId = peer ? string(details.id) : null;
					const body = describe(entry.type === "custom_message" ? entry.content : entry.data);
					const fingerprint = JSON.stringify([string(details.from), string(details.to), string(details.replyTo), body]);
					const prior = messageId ? peerEnvelopes.get(messageId) : undefined;
					const duplicate = prior === fingerprint;
					const conflict = prior !== undefined && !duplicate;
					if (messageId && prior === undefined) peerEnvelopes.set(messageId, fingerprint);
					if (conflict)
						notice("A peer message identity has conflicting envelope evidence; both observations are shown.");
					const status = string(details.status);
					const messageActor = address(string(peer ? details.from : details.id)) ?? actorId;
					if (peer && details.reference !== undefined) {
						const result = sanitizeWorkReference(details.reference);
						if ("error" in result) {
							notice(`A peer message reference was omitted: ${result.error}`);
						} else {
							references.push({
								author: messageActor,
								reference: result.reference,
								timestamp: Date.parse(entry.timestamp) || 0,
							});
						}
					}
					const displayText = sources.messageText?.(body, messageActor) ?? body;
					add({
						...base,
						id: messageId && prior === undefined ? `peer:${messageId}` : `${sessionId}:${entry.id}:${entry.customType}`,
						kind: conflict ? "peer conflicting envelope" : duplicate ? "peer occurrence" : entry.customType,
						text: duplicate ? "The same peer envelope occurs in this session ancestry." : body,
						actorId: messageActor,
						recipientId: address(string(peer ? details.to : details.ownerSession)) ?? actorId,
						messageId,
						replyTo: string(details.replyTo),
						workerId: peer ? (record?.id ?? null) : string(details.id),
						...(!duplicate
							? {
									exchange: {
										kind: peer
											? ("peer" as const)
											: entry.customType === "subagent_report"
												? ("report" as const)
												: entry.customType === "subagent_result"
													? ("result" as const)
													: ("pause" as const),
										text: displayText,
									},
								}
							: {}),
						receipt: peer
							? "recorded envelope; no context acknowledgement"
							: status && receiptStates.has(status)
								? `recorded ${status}`
								: null,
					});
					if (messageId && !receiptIds.has(messageId)) {
						const receipt = sources.receipt?.(sessionId, messageId) ?? sources.receipt?.(currentId, messageId);
						if (receipt) {
							receiptIds.add(messageId);
							add({
								...base,
								id: `receipt:${messageId}`,
								kind: "peer receipt",
								actorId: receipt.from,
								recipientId: receipt.to,
								text: "Process-local receipt. Context observation is not model understanding or durable acknowledgement.",
								source: "live peer receipt",
								messageId,
								replyTo: receipt.replyTo,
								receipt: `live ${receipt.status}`,
							});
						}
					}
				}
			}
		}
		const obligations = projectObligations(references);
		return {
			familyId,
			families: [...familyMap].map(([id, label]) => ({ id, label })),
			participants,
			events,
			obligations,
			outstandingRequired: outstandingRequiredObligations(obligations),
			unaccepted: unacceptedObligations(obligations),
			notices: [...notices],
		};
	};
}
