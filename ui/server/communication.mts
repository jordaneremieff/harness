import type { Communication, CommunicationPresentation, JsonDisplay, NativeOrigin, OrdinaryOrigin } from '../shared/api.ts';

type RecordValue = Record<string, unknown>;
type Helpers = {safeText(value: unknown, maxBytes?: number): string; jsonDisplay(value: unknown, maxBytes?: number): JsonDisplay};
export type CommunicationSource = {entryId?: string; timestamp?: unknown; native?: unknown; nativeEntryId?: string; singleMessage?: boolean; storageId?: string; conversationId?: number};
const BODY_BYTES = 16384, VALUE_BYTES = 24576, PRESENTATION_BYTES = 32768, DETAILS_BYTES = 8192;
const invalid: CommunicationPresentation = {state: 'unavailable', reason: 'invalid'};
const limited: CommunicationPresentation = {state: 'unavailable', reason: 'limit'};
const unresolved: CommunicationPresentation = {state: 'unresolved'};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function record(value: unknown): value is RecordValue { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fields(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
function integer(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function text(value: unknown, max: number, body = false, empty = false): value is string {
  return typeof value === 'string' && (body || empty || value.length > 0) && Buffer.byteLength(value) <= max &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value) &&
    !(body ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/ : /[\x00-\x1f\x7f-\x9f]/).test(value);
}
function entryId(value: unknown): value is string { return text(value, 16) && /^[1-9]\d*$/.test(value) && integer(Number(value), 1) && String(Number(value)) === value; }
function identity(value: unknown): value is string {
  if (!text(value, 256)) return false;
  const [storage, conversation, extra] = value.split(':');
  return uuid.test(storage ?? '') && extra === undefined && (conversation === undefined || entryId(conversation) && conversation !== '1');
}
function optional(value: RecordValue, key: string, validate: (item: unknown) => boolean): boolean { return !Object.hasOwn(value, key) || validate(value[key]); }
function sender(value: unknown): boolean {
  return record(value) && fields(value, ['identity'], ['name', 'kind']) && identity(value.identity) &&
    optional(value, 'name', item => text(item, 160, false, true)) && optional(value, 'kind', item => item === 'agent' || item === 'session');
}
function body(value: unknown): boolean {
  return record(value) && fields(value, ['text', 'complete', 'redacted']) && text(value.text, BODY_BYTES, true) &&
    typeof value.complete === 'boolean' && typeof value.redacted === 'boolean' && !(value.redacted && value.complete);
}
function reference(value: unknown): boolean {
  return record(value) && fields(value, ['submissionId'], ['requestId', 'entryId', 'answerEntryId']) && integer(value.submissionId, 1) &&
    optional(value, 'requestId', item => text(item, 1024)) && optional(value, 'entryId', entryId) && optional(value, 'answerEntryId', entryId);
}
function notice(value: RecordValue): boolean {
  return fields(value, ['threadId'], ['event', 'frameRevision', 'eventKind', 'title', 'passive']) && text(value.threadId, 256) &&
    optional(value, 'event', item => integer(item, 1)) && optional(value, 'frameRevision', item => integer(item, 1)) &&
    optional(value, 'eventKind', item => text(item, 64, false, true)) && optional(value, 'title', item => text(item, 160, false, true)) &&
    optional(value, 'passive', item => typeof item === 'boolean');
}
function report(value: RecordValue): boolean {
  return fields(value, ['sourceId', 'requestId'], ['replyTo']) && text(value.sourceId, 1024) && text(value.requestId, 1024) && optional(value, 'replyTo', identity);
}
function result(value: RecordValue): boolean {
  return fields(value, ['status', 'references', 'omittedReferences'], ['reason']) && (value.status === 'done' || value.status === 'unanswered') &&
    Array.isArray(value.references) && value.references.length >= 1 && value.references.length <= 16 && value.references.every(reference) &&
    integer(value.omittedReferences) && optional(value, 'reason', item => text(item, 1024, false, true));
}
function checkIn(value: RecordValue): boolean {
  return fields(value, ['sourceId', 'producerRequestId', 'elapsedMs', 'origin']) && text(value.sourceId, 1024) && text(value.producerRequestId, 1024) &&
    integer(value.elapsedMs) && (value.origin === 'operator' || value.origin === 'model');
}
export function validCommunication(value: unknown): value is Communication {
  if (!record(value) || !fields(value, ['format', 'sender', 'body', 'recordedAt', 'kind', 'metadata'])) return false;
  if (value.format !== 'agent.communication/1' || !sender(value.sender) || !body(value.body) || !integer(value.recordedAt) || !record(value.metadata)) return false;
  switch (value.kind) {
    case 'notice': return notice(value.metadata);
    case 'report': return report(value.metadata);
    case 'result': return result(value.metadata);
    case 'check-in': return checkIn(value.metadata);
    default: return false;
  }
}
function link(value: unknown): boolean {
  if (!record(value) || !fields(value, ['mode', 'storageId', 'conversationId', 'entryId', 'requestId'], value.mode === 'input' ? ['submissionId'] : [])) return false;
  return (value.mode === 'input' || value.mode === 'passive') && typeof value.storageId === 'string' && uuid.test(value.storageId) && integer(value.conversationId, 1) &&
    entryId(value.entryId) && text(value.requestId, 1024) && (value.mode === 'passive' || integer(value.submissionId, 1));
}
function origin(value: unknown): value is NativeOrigin | OrdinaryOrigin {
  if (!record(value)) return false;
  if (value.kind === 'native') return fields(value, ['kind', 'recordEntryId', 'target']) && entryId(value.recordEntryId) && link(value.target);
  return value.kind === 'ordinary-custom' && fields(value, ['kind', 'customType', 'renderEntryId'], ['sourceEntryId']) && value.customType === 'agent.peer' &&
    text(value.renderEntryId, 256) && optional(value, 'sourceEntryId', item => text(item, 256));
}
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }
function protectedStrings(value: unknown, helpers: Helpers): unknown {
  if (typeof value === 'string') return helpers.safeText(value, Number.MAX_SAFE_INTEGER);
  if (Array.isArray(value)) return value.map(item => protectedStrings(item, helpers));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, protectedStrings(item, helpers)]));
  return value;
}
function protect(value: Communication, helpers: Helpers): Communication {
  const clean = JSON.parse(JSON.stringify(value)) as Communication;
  const protectedBody = helpers.safeText(clean.body.text, BODY_BYTES);
  if (protectedBody !== clean.body.text) clean.body = {text: protectedBody, complete: false, redacted: true};
  if (clean.sender.name !== undefined) clean.sender.name = helpers.safeText(clean.sender.name, 160);
  clean.metadata = protectedStrings(clean.metadata, helpers) as Communication['metadata'];
  return clean;
}
function ready(value: unknown, source: NativeOrigin | OrdinaryOrigin, details: unknown, helpers: Helpers): CommunicationPresentation {
  if (bytes(value) > VALUE_BYTES) return limited;
  if (!validCommunication(value)) return invalid;
  const protectedOrigin = protectedStrings(source, helpers) as NativeOrigin | OrdinaryOrigin;
  if (JSON.stringify(protectedOrigin) !== JSON.stringify(source)) return invalid;
  const protectedValue = protect(value, helpers);
  if (!validCommunication(protectedValue)) return invalid;
  const normalized: Extract<CommunicationPresentation, {state: 'ready'}> = {state: 'ready', origin: protectedOrigin, value: protectedValue};
  const allowance = PRESENTATION_BYTES - bytes(normalized) - 128;
  if (allowance < 0) return limited;
  if (details !== undefined) normalized.rawDetails = helpers.jsonDisplay(details, Math.min(DETAILS_BYTES - 64, allowance));
  return bytes(normalized) <= PRESENTATION_BYTES ? normalized : limited;
}
function rawDetails(value: unknown): value is JsonDisplay {
  return record(value) && fields(value, ['value', 'truncated'], ['omittedBytes']) && typeof value.truncated === 'boolean' && optional(value, 'omittedBytes', integer);
}
function retainRawCoverage(normalized: CommunicationPresentation, display: RecordValue | undefined): void {
  if (normalized.state !== 'ready' || !normalized.rawDetails || !display) return;
  if (display.truncated === true) normalized.rawDetails.truncated = true;
  if (integer(display.omittedBytes)) normalized.rawDetails.omittedBytes = display.omittedBytes;
}
function validNativeOrigin(at: NativeOrigin, value: unknown, source: CommunicationSource): boolean {
  if (source.singleMessage === false || source.nativeEntryId !== undefined && at.target.entryId !== source.nativeEntryId) return false;
  if (source.storageId !== undefined && at.target.storageId !== source.storageId || source.conversationId !== undefined && at.target.conversationId !== source.conversationId) return false;
  return at.target.mode !== 'passive' || at.recordEntryId === at.target.entryId && record(value) && value.kind === 'notice' && record(value.metadata) && value.metadata.passive === true;
}
function projected(value: unknown, source: CommunicationSource, helpers: Helpers): CommunicationPresentation {
  if (!record(value)) return invalid;
  if (value.state === 'unresolved' && fields(value, ['state'])) return unresolved;
  if (value.state === 'unavailable' && fields(value, ['state', 'reason']) && (value.reason === 'invalid' || value.reason === 'limit')) return {state: 'unavailable', reason: value.reason};
  if (value.state !== 'ready' || !fields(value, ['state', 'origin', 'value'], ['rawDetails']) || !origin(value.origin)) return invalid;
  if (value.origin.kind === 'native' && !validNativeOrigin(value.origin, value.value, source)) return invalid;
  if (value.rawDetails !== undefined && !rawDetails(value.rawDetails)) return invalid;
  const display = record(value.rawDetails) ? value.rawDetails : undefined;
  const normalized = ready(value.value, value.origin, display?.value, helpers);
  retainRawCoverage(normalized, display);
  return normalized;
}
function native(value: unknown, source: CommunicationSource, helpers: Helpers): CommunicationPresentation {
  if (!record(value) || source.singleMessage === false) return invalid;
  if (value.state === 'unresolved' && fields(value, ['state'])) return unresolved;
  if (value.state === 'unavailable' && fields(value, ['state', 'reason']) && (value.reason === 'invalid' || value.reason === 'limit')) return {state: 'unavailable', reason: value.reason};
  if (value.state !== 'ready' || !fields(value, ['state', 'recordEntryId', 'target', 'value']) || !entryId(value.recordEntryId) || !link(value.target)) return invalid;
  const target = value.target as NativeOrigin['target'];
  const at: NativeOrigin = {kind: 'native', recordEntryId: value.recordEntryId, target};
  if (target.entryId !== source.nativeEntryId || !validNativeOrigin(at, value.value, source)) return invalid;
  return ready(value.value, at, undefined, helpers);
}
function recordedAt(value: unknown): number | undefined {
  if (integer(value)) return value;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return undefined;
  const parsed = Date.parse(value); return integer(parsed) ? parsed : undefined;
}
function ordinarySender(details: RecordValue): Communication['sender'] | undefined {
  const selected = details.kind === 'receipt' ? details.identity : details.senderIdentity;
  if (!identity(selected)) return undefined;
  return {identity: selected, ...(text(details.name, 160, false, true) ? {name: details.name} : {}), ...(details.senderKind === 'agent' || details.senderKind === 'session' ? {kind: details.senderKind} : {})};
}
function validSupplied(value: unknown, validate: (value: unknown) => boolean, nullable = false): boolean { return value === undefined || nullable && value === null || validate(value); }
function ordinaryReference(value: unknown): boolean {
  return record(value) && integer(value.submissionId, 1) && validSupplied(value.requestId, item => text(item, 1024)) && validSupplied(value.entryId, item => integer(item, 1), true);
}
function ordinaryReferences(details: RecordValue): Extract<Communication, {kind: 'result'}>['metadata'] | undefined {
  if (details.status !== 'done' && details.status !== 'unanswered' || !Array.isArray(details.submissions) || !details.submissions.length || !details.submissions.every(ordinaryReference)) return undefined;
  const answerEntryId = integer(details.answerEntryId, 1) ? String(details.answerEntryId) : undefined;
  const references = details.submissions.slice(0, 16).map(item => {
    const member = item as RecordValue;
    return {submissionId: member.submissionId as number, ...(typeof member.requestId === 'string' ? {requestId: member.requestId} : {}), ...(integer(member.entryId, 1) ? {entryId: String(member.entryId)} : {}), ...(answerEntryId ? {answerEntryId} : {})};
  });
  return {status: details.status, references, omittedReferences: Math.max(0, details.submissions.length - 16), ...(typeof details.reason === 'string' ? {reason: details.reason} : {})};
}
function ordinaryCheckIn(details: RecordValue, sourceId: unknown): Pick<Communication, 'kind' | 'metadata'> | undefined {
  const check = details.checkIn;
  if (!record(check) || !text(sourceId, 1024) || !text(check.requestId, 1024) || !integer(check.elapsedMs) || (check.origin !== 'operator' && check.origin !== 'model')) return undefined;
  return {kind: 'check-in', metadata: {sourceId, producerRequestId: check.requestId, elapsedMs: check.elapsedMs, origin: check.origin}};
}
function ordinaryNotice(details: RecordValue): Pick<Communication, 'kind' | 'metadata'> | undefined {
  if (!text(details.threadId, 256) || typeof details.operatorMessage !== 'string') return undefined;
  return {kind: 'notice', metadata: {threadId: details.threadId, ...(text(details.threadTitle, 160, false, true) ? {title: details.threadTitle} : {})}};
}
function ordinaryVariant(details: RecordValue): Pick<Communication, 'kind' | 'metadata'> | undefined {
  const sourceId = details.reportSourceId === undefined ? details.sourceId : details.reportSourceId;
  if (details.kind === 'receipt') { const metadata = ordinaryReferences(details); return metadata ? {kind: 'result', metadata} : undefined; }
  if (details.kind !== 'report') return undefined;
  if (Object.hasOwn(details, 'checkIn')) return ordinaryCheckIn(details, sourceId);
  if (Object.hasOwn(details, 'threadId') || Object.hasOwn(details, 'operatorMessage')) return ordinaryNotice(details);
  if (!text(sourceId, 1024) || !text(details.requestId, 1024) || details.replyTo !== undefined && details.replyTo !== null && !identity(details.replyTo)) return undefined;
  return {kind: 'report', metadata: {sourceId, requestId: details.requestId, ...(identity(details.replyTo) ? {replyTo: details.replyTo} : {})}};
}
function invalidIdentity(details: RecordValue): boolean {
  if (!validSupplied(details.identity, identity) || !validSupplied(details.senderIdentity, identity)) return true;
  if (details.identity !== undefined && details.senderIdentity !== undefined && details.identity !== details.senderIdentity) return true;
  if (details.kind !== 'receipt' || !identity(details.identity)) return false;
  const [storageId, conversationId = '1'] = details.identity.split(':');
  return !validSupplied(details.storageId, item => item === storageId) || !validSupplied(details.conversationId, item => integer(item, 1) && String(item) === conversationId);
}
function invalidReceipt(details: RecordValue): boolean {
  return !validSupplied(details.status, item => item === 'done' || item === 'unanswered') ||
    !validSupplied(details.submissions, item => Array.isArray(item) && item.length > 0 && item.every(ordinaryReference)) ||
    !validSupplied(details.answerEntryId, item => integer(item, 1), true) || !validSupplied(details.reason, item => text(item, 1024, false, true), true);
}
function invalidReport(details: RecordValue): boolean {
  const sourceId = details.reportSourceId === undefined ? details.sourceId : details.reportSourceId;
  if (!validSupplied(sourceId, item => text(item, 1024))) return true;
  if (Object.hasOwn(details, 'checkIn')) {
    const check = details.checkIn;
    return !record(check) || !validSupplied(check.requestId, item => text(item, 1024)) || !validSupplied(check.elapsedMs, integer) || !validSupplied(check.origin, item => item === 'operator' || item === 'model');
  }
  if (Object.hasOwn(details, 'threadId') || Object.hasOwn(details, 'operatorMessage')) return !validSupplied(details.threadId, item => text(item, 256)) || !validSupplied(details.threadTitle, item => text(item, 160, false, true));
  return !validSupplied(details.requestId, item => text(item, 1024)) || !validSupplied(details.replyTo, identity, true);
}
function validOrdinaryTimestamp(stamp: unknown, source: CommunicationSource): boolean {
  return (typeof stamp !== 'string' || source.entryId !== undefined || source.timestamp !== undefined) && validSupplied(stamp, item => recordedAt(item) !== undefined);
}
function invalidOrdinary(details: RecordValue, stamp: unknown, source: CommunicationSource): boolean {
  return invalidIdentity(details) || !validOrdinaryTimestamp(stamp, source) ||
    !validSupplied(details.kind, item => item === 'receipt' || item === 'report') ||
    details.kind === 'receipt' && invalidReceipt(details) || details.kind === 'report' && invalidReport(details);
}
function ordinary(raw: RecordValue, id: string, source: CommunicationSource, helpers: Helpers): CommunicationPresentation {
  if (raw.details === undefined) return unresolved;
  if (!record(raw.details)) return invalid;
  const details = raw.details;
  const stamp = raw.timestamp === undefined ? source.timestamp : raw.timestamp;
  if (invalidOrdinary(details, stamp, source)) return invalid;
  const from = ordinarySender(details), variant = ordinaryVariant(details), time = recordedAt(stamp);
  const supplied = details.kind === 'receipt' ? details.answer : variant?.kind === 'notice' ? details.operatorMessage : details.message;
  if (supplied !== undefined && !text(supplied, Number.MAX_SAFE_INTEGER, true)) return invalid;
  if (!text(id, 256)) return Buffer.byteLength(id) > 256 ? limited : invalid;
  if (!from || !variant || time === undefined || typeof supplied !== 'string') return unresolved;
  const protectedText = helpers.safeText(supplied, Number.MAX_SAFE_INTEGER), shown = helpers.safeText(protectedText, BODY_BYTES);
  const value = {format: 'agent.communication/1', sender: from, body: {text: shown, complete: false, redacted: protectedText !== supplied}, recordedAt: time, ...variant};
  const at: OrdinaryOrigin = {kind: 'ordinary-custom', customType: 'agent.peer', renderEntryId: id, ...(text(source.entryId, 256) ? {sourceEntryId: source.entryId} : {})};
  return ready(value, at, details, helpers);
}
/** Normalize the public producer fields once; projected messages retain their existing carrier. */
export function projectCommunication(raw: RecordValue, id: string, source: CommunicationSource, helpers: Helpers): CommunicationPresentation | undefined {
  try {
    if (raw.role === 'custom' && raw.display === false) return undefined;
    if (source.native !== undefined) return native(source.native, source, helpers);
    if (Object.hasOwn(raw, 'communication')) return projected(raw.communication, source, helpers);
    if (raw.role === 'custom' && raw.customType === 'agent.peer') return ordinary(raw, id, source, helpers);
    return undefined;
  } catch { return invalid; }
}
