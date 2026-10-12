import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const COMMUNICATION_BODY_BYTES = 16_384;
export const COMMUNICATION_VALUE_BYTES = 24_576;
export const COMMUNICATION_READY_BYTES = 32_768;
export const COMMUNICATION_PAGE_BYTES = 65_536;
export const COMMUNICATION_PAGE_ENTRIES = 200;

const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const count = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const bounded = (maximum: number, minimum = 1) => Type.String({ minLength: minimum, maxLength: maximum });
export const STORAGE_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";
const identityPattern = `${STORAGE_ID_PATTERN.slice(0, -1)}(?::[1-9][0-9]*)?$`;
const identity = Type.String({ minLength: 1, maxLength: 256, pattern: identityPattern });
const storageId = Type.String({ minLength: 36, maxLength: 36, pattern: STORAGE_ID_PATTERN });
const entryId = Type.String({ minLength: 1, maxLength: 16, pattern: "^[1-9][0-9]*$" });
const sourceId = bounded(1_024);
export const CommunicationBodySchema = object({ text: bounded(COMMUNICATION_BODY_BYTES, 0), complete: Type.Boolean(), redacted: Type.Boolean() });
export const CommunicationSenderSchema = object({ identity, name: Type.Optional(bounded(160, 0)), kind: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("session")])) });
export const CommunicationReferenceSchema = object({ submissionId: positive, requestId: Type.Optional(sourceId), entryId: Type.Optional(entryId), answerEntryId: Type.Optional(entryId) });
const common = { format: Type.Literal("agent.communication/1"), sender: CommunicationSenderSchema, body: CommunicationBodySchema, recordedAt: count };
export const CommunicationSchema = Type.Union([
	object({ ...common, kind: Type.Literal("notice"), metadata: object({ threadId: bounded(256), event: Type.Optional(positive), frameRevision: Type.Optional(positive), eventKind: Type.Optional(bounded(64, 0)), title: Type.Optional(bounded(160, 0)), passive: Type.Optional(Type.Boolean()) }) }),
	object({ ...common, kind: Type.Literal("report"), metadata: object({ sourceId, requestId: sourceId, replyTo: Type.Optional(identity) }) }),
	object({ ...common, kind: Type.Literal("result"), metadata: object({ status: Type.Union([Type.Literal("done"), Type.Literal("unanswered")]), references: Type.Array(CommunicationReferenceSchema, { minItems: 1, maxItems: 16 }), omittedReferences: count, reason: Type.Optional(bounded(1_024, 0)) }) }),
	object({ ...common, kind: Type.Literal("check-in"), metadata: object({ sourceId, producerRequestId: sourceId, elapsedMs: count, origin: Type.Union([Type.Literal("operator"), Type.Literal("model")]) }) }),
]);
export type Communication = Static<typeof CommunicationSchema>;
export const CommunicationInputLinkSchema = object({ mode: Type.Literal("input"), storageId, conversationId: positive, entryId, submissionId: positive, requestId: sourceId });
export const CommunicationPassiveLinkSchema = object({ mode: Type.Literal("passive"), storageId, conversationId: positive, entryId, requestId: sourceId });
export const CommunicationLinkSchema = Type.Union([CommunicationInputLinkSchema, CommunicationPassiveLinkSchema]);
export type CommunicationInputLink = Static<typeof CommunicationInputLinkSchema>;
export type CommunicationPassiveLink = Static<typeof CommunicationPassiveLinkSchema>;
export type CommunicationLink = Static<typeof CommunicationLinkSchema>;
export const CommunicationViewSchema = Type.Union([
	object({ state: Type.Literal("ready"), recordEntryId: entryId, target: CommunicationLinkSchema, value: CommunicationSchema }),
	object({ state: Type.Literal("unresolved") }),
	object({ state: Type.Literal("unavailable"), reason: Type.Union([Type.Literal("limit"), Type.Literal("invalid")]) }),
]);
export type CommunicationView = Static<typeof CommunicationViewSchema>;
export const CommunicationCompanionSchema = object({ format: Type.Literal("agent.communication-link/1"), target: CommunicationInputLinkSchema, value: CommunicationSchema });
export type CommunicationCompanion = Static<typeof CommunicationCompanionSchema>;
export const CommunicationPassiveSchema = object({ format: Type.Literal("agent.communication-passive/1"), requestId: sourceId, value: CommunicationSchema });
export type CommunicationPassive = Static<typeof CommunicationPassiveSchema>;

/** Canonical identity checks never resolve a handle or change a supplied author. */
export function communicationIdentity(value: string): boolean {
	if (!textFits(value, 256) || !new RegExp(identityPattern, "u").test(value)) return false;
	const separator = value.indexOf(":");
	if (separator < 0) return true;
	const conversation = Number(value.slice(separator + 1));
	return Number.isSafeInteger(conversation) && conversation > 1;
}
function canonicalEntry(value: string): boolean {
	return /^[1-9][0-9]*$/u.test(value) && Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(Number(value)) === value;
}
function textFits(value: string, maximum: number, body = false): boolean {
	if (Buffer.byteLength(value, "utf8") > maximum) return false;
	const controls = body ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\u0000-\u001f\u007f-\u009f]/u;
	if (controls.test(value)) return false;
	for (const point of value) {
		const code = point.codePointAt(0) as number;
		if (code >= 0xd800 && code <= 0xdfff) return false;
	}
	return true;
}
function validValue(value: Communication): boolean {
	if ((value.body.redacted && value.body.complete) || !communicationIdentity(value.sender.identity) || (value.sender.name !== undefined && !textFits(value.sender.name, 160)) || !textFits(value.body.text, COMMUNICATION_BODY_BYTES, true)) return false;
	switch (value.kind) {
		case "notice": return textFits(value.metadata.threadId, 256) && (value.metadata.title === undefined || textFits(value.metadata.title, 160)) && (value.metadata.eventKind === undefined || textFits(value.metadata.eventKind, 64));
		case "report": return textFits(value.metadata.sourceId, 1_024) && textFits(value.metadata.requestId, 1_024) && (value.metadata.replyTo === undefined || communicationIdentity(value.metadata.replyTo));
		case "check-in": return textFits(value.metadata.sourceId, 1_024) && textFits(value.metadata.producerRequestId, 1_024);
		case "result": return (value.metadata.reason === undefined || textFits(value.metadata.reason, 1_024)) && value.metadata.references.every((reference) => (reference.requestId === undefined || textFits(reference.requestId, 1_024)) && (reference.entryId === undefined || canonicalEntry(reference.entryId)) && (reference.answerEntryId === undefined || canonicalEntry(reference.answerEntryId)));
	}
}
export function communicationSerializedBytes(value: unknown): number {
	try { return Buffer.byteLength(JSON.stringify(value), "utf8"); }
	catch { return Number.POSITIVE_INFINITY; }
}
/** Closed shape checks and UTF-8 limits are both required at the public boundary. */
export function parseCommunication(value: unknown): Communication | undefined {
	try {
		if (!Value.Check(CommunicationSchema, value) || !validValue(value) || communicationSerializedBytes(value) > COMMUNICATION_VALUE_BYTES) return undefined;
		return JSON.parse(JSON.stringify(value)) as Communication;
	} catch { return undefined; }
}
function validLink(value: CommunicationLink): boolean {
	return canonicalEntry(value.entryId) && textFits(value.requestId, 1_024);
}
export function parseCommunicationLink(value: unknown): CommunicationLink | undefined {
	try {
		if (!Value.Check(CommunicationLinkSchema, value) || !validLink(value)) return undefined;
		return JSON.parse(JSON.stringify(value)) as CommunicationLink;
	} catch { return undefined; }
}
export function parseCommunicationCompanion(value: unknown): CommunicationCompanion | undefined {
	try {
		if (!Value.Check(CommunicationCompanionSchema, value) || !validLink(value.target) || !parseCommunication(value.value) || (value.value.kind === "notice" && value.value.metadata.passive === true)) return undefined;
		return JSON.parse(JSON.stringify(value)) as CommunicationCompanion;
	} catch { return undefined; }
}
export function parseCommunicationPassive(value: unknown): CommunicationPassive | undefined {
	try {
		if (!Value.Check(CommunicationPassiveSchema, value) || !textFits(value.requestId, 1_024) || !parseCommunication(value.value) || value.value.kind !== "notice" || value.value.metadata.passive !== true) return undefined;
		return JSON.parse(JSON.stringify(value)) as CommunicationPassive;
	} catch { return undefined; }
}
export function parseCommunicationView(value: unknown): CommunicationView | undefined {
	try {
		if (!Value.Check(CommunicationViewSchema, value)) return undefined;
		if (value.state === "ready" && (!canonicalEntry(value.recordEntryId) || !validLink(value.target) || !parseCommunication(value.value) || communicationSerializedBytes(value) > COMMUNICATION_READY_BYTES)) return undefined;
		return JSON.parse(JSON.stringify(value)) as CommunicationView;
	} catch { return undefined; }
}
/** Object key order is not a new provenance value; array order remains significant. */
export function communicationFingerprint(value: Communication): string {
	const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item !== null && typeof item === "object" ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, ordered(child)])) : item;
	return JSON.stringify(ordered(value));
}

/** Reserve every remaining status marker before allocating any ready value. */
export function boundCommunicationViews(values: readonly CommunicationView[]): CommunicationView[] {
	const limit = Math.min(values.length, COMMUNICATION_PAGE_ENTRIES);
	const marker: CommunicationView = { state: "unavailable", reason: "limit" };
	const reserve = communicationSerializedBytes(marker);
	let remaining = COMMUNICATION_PAGE_BYTES - limit * reserve;
	return values.map((value, index) => {
		if (index >= limit) return marker;
		const bytes = communicationSerializedBytes(value);
		if (bytes > COMMUNICATION_READY_BYTES || bytes - reserve > remaining) return marker;
		remaining -= Math.max(0, bytes - reserve);
		return value;
	});
}
