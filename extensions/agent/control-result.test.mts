import assert from "node:assert/strict";
import { it } from "node:test";
import { controlText, readableControlText, projectReportReceipt, REPORT_RECEIPT_BOUNDARY, receiptContinuationLine, resultContinuationLines } from "./control-result.ts";
import { AnswerContinuationSchema, ReceiptContinuationSchema, ResultToolOutputSchema } from "./observation-schema.ts";
import { matchesSchema } from "./schema-check.ts";

const answerContinuation = { tool: "agent_inspect", view: "result", sessionId: "producer:2", submissionId: 7, requestId: "input-7", offset: 4096 };
const receiptContinuation = { tool: "agent_inspect", view: "result", sessionId: "producer:2", submissionId: 7, requestId: "input-7", receiptCursor: "recipient-page" };
const result = { view: "result", sessionId: "producer:2", conversationId: 2, submissionId: 7, requestId: "input-7", status: "done", answerEntryId: 9,
	answer: 'First line\n"Quoted" second line 😀', offset: 0, nextOffset: 4096, truncated: true, answerContinuation,
	receiptGroup: { recipient: "reader", results: [{ sessionId: "producer:2", submissionId: 7, requestId: "input-7" }], complete: false, next: receiptContinuation },
	usage: { models: {}, tools: {} } };

it("renders readable answer text before compact metadata and independent exact continuation calls", () => {
	assert.equal(matchesSchema(ResultToolOutputSchema, result), true);
	const before = structuredClone(result), text = readableControlText(result);
	assert.ok(text.startsWith(`${result.answer}\n\nResult:`));
	assert.doesNotMatch(text, /First line\\n/u);
	assert.deepEqual(result, before);
	const lines = resultContinuationLines(result);
	assert.equal(lines.length, 2);
	assert.match(lines[0], /^Answer continuation: agent_inspect\(/u);
	assert.match(lines[1], /^Receipt continuation: agent_inspect\(/u);
	const args = lines.map(line => JSON.parse(line.slice(line.indexOf("(") + 1, -1)));
	assert.deepEqual(args, [Object.fromEntries(Object.entries(answerContinuation).filter(([key]) => key !== "tool")), Object.fromEntries(Object.entries(receiptContinuation).filter(([key]) => key !== "tool"))]);
	assert.equal(Object.hasOwn(args[0], "receiptCursor"), false);
	assert.equal(Object.hasOwn(args[1], "offset"), false);
});

it("keeps answer and receipt cursor schemas exclusive and bounded", () => {
	assert.equal(matchesSchema(AnswerContinuationSchema, { ...answerContinuation, receiptCursor: "other" }), false);
	assert.equal(matchesSchema(ReceiptContinuationSchema, { ...receiptContinuation, offset: 4 }), false);
	assert.equal(matchesSchema(ReceiptContinuationSchema, { ...receiptContinuation, receiptCursor: "a".repeat(2049) }), false);
	assert.deepEqual(resultContinuationLines({ answerContinuation: { ...answerContinuation, extra: true } }), []);
	assert.deepEqual(resultContinuationLines({ answerContinuation: receiptContinuation, receiptGroup: { next: answerContinuation } }), []);
	assert.equal(receiptContinuationLine(answerContinuation), undefined);
	assert.equal(receiptContinuationLine({ ...receiptContinuation, offset: 0 }), undefined);
	assert.equal(receiptContinuationLine(receiptContinuation), `Receipt continuation: agent_inspect(${JSON.stringify(Object.fromEntries(Object.entries(receiptContinuation).filter(([key]) => key !== "tool")))})`);
	assert.equal(matchesSchema(ResultToolOutputSchema, { ...result, receiptGroup: { ...result.receiptGroup, results: Array(17).fill(result.receiptGroup.results[0]) } }), false);
});

it("states unavailable body without fabricating a page or changing exact evidence rendering", () => {
	const absent = { view: "result", status: "unavailable", reason: "Answer entry unavailable" };
	assert.match(readableControlText(absent), /^No answer body is available/u);
	assert.deepEqual(resultContinuationLines(absent), []);
	const exact = { view: "exact", text: '{"raw":true}', offset: 0 };
	assert.equal(controlText(exact), JSON.stringify(exact));
	assert.equal(controlText(undefined), "Host control completed without a result.");
});

it("renders a final report page with the status of its input beside the close status of the work", () => {
	const read = { tool: "agent_inspect", view: "result", sessionId: "producer:2", submissionId: 7, finalReport: true, offset: 4096 };
	const page = { view: "result", sessionId: "producer:2", conversationId: 2, submissionId: 7, requestId: "input-7", status: "unanswered",
		work: { state: "closed", finalReport: { requestId: "work-final:2:input-7", ownerId: "reader", status: "done", delivery: "active", read: { ...read, offset: 0 } } },
		finalReport: { requestId: "work-final:2:input-7", ownerId: "reader", status: "done", text: "Final work result (done) for request input-7\n\nthe survey", length: 9000, offset: 0, nextOffset: 4096, truncated: true },
		finalReportContinuation: read, usage: { models: {}, tools: {} } };
	assert.equal(matchesSchema(ResultToolOutputSchema, page), true);
	const text = readableControlText(page);
	assert.ok(text.startsWith(`${page.finalReport.text}\n\nFinal report page: `));
	const identity = JSON.parse(text.split("\n\n")[2].slice("Final report page: ".length)) as Record<string, unknown>;
	assert.deepEqual([identity.inputStatus, identity.status, identity.requestId, identity.reportRequestId], ["unanswered", "done", "input-7", "work-final:2:input-7"]);
	assert.doesNotMatch(text, /State note|No answer body/u);
	assert.match(text, /\n\nFinal report continuation: agent_inspect\(\{"view":"result","sessionId":"producer:2","submissionId":7,"finalReport":true,"offset":4096\}\)$/u);
});

it("removes report body from retained sender receipts and preserves acknowledged replay", () => {
	for (const acknowledged of [false, true]) {
		const original = { sourceId: "report:r1", requestId: "r1", ownerId: "recipient", senderIdentity: "sender", replyTo: null, createdAt: 7, acknowledged, passive: true,
			message: "Private multiline\nreport body", operatorMessage: "Private excerpt" };
		const before = structuredClone(original), receipt = projectReportReceipt(original) as Record<string, unknown>;
		assert.deepEqual(receipt, { sourceId: "report:r1", requestId: "r1", ownerId: "recipient", senderIdentity: "sender", replyTo: null, createdAt: 7, acknowledged, passive: true, boundary: REPORT_RECEIPT_BOUNDARY,
			...(acknowledged ? {} : { placement: "unplaced", delivery: "pending" }) });
		assert.doesNotMatch(controlText(receipt), /Private|operatorMessage|message/u);
		assert.deepEqual(original, before);
	}
});

it("preserves ordinary admission facts and failures without inventing retention", () => {
	const admission = { sessionId: "ordinary", admitted: true, sourceId: "source", boundary: "Queued admission only", message: "body" };
	assert.deepEqual(projectReportReceipt(admission), { sessionId: "ordinary", admitted: true, sourceId: "source", boundary: "Queued admission only" });
	const nativeAdmission = { identity: "native", conversationId: 1, submissionId: 7, deduped: false, boundary: "Admission only", result: { sessionId: "native", submissionId: 7 } };
	assert.deepEqual(projectReportReceipt(nativeAdmission), nativeAdmission);
	for (const failure of [{ error: "failed", sourceId: "r", acknowledged: false }, { admitted: false, reason: "unavailable" }, { outcome: "failed", reason: "uncertain" }, { queued: "unknown" }]) assert.equal(projectReportReceipt(failure), failure);
});

it("keeps a stated placement on report receipts, omits any other value and marks an unacknowledged report unplaced", () => {
	const retained = { sourceId: "report:one", acknowledged: true };
	const admitted = { identity: "native", conversationId: 1, submissionId: 7, deduped: false };
	for (const placement of ["placed", "unplaced"]) {
		assert.deepEqual(projectReportReceipt({ ...retained, placement }), { ...retained, placement, boundary: REPORT_RECEIPT_BOUNDARY });
		assert.deepEqual(projectReportReceipt({ ...admitted, placement }), { ...admitted, placement });
	}
	for (const placement of ["queued", true, null, { state: "placed" }])
		assert.deepEqual(projectReportReceipt({ ...retained, placement, delivery: placement }), { ...retained, boundary: REPORT_RECEIPT_BOUNDARY });
	assert.deepEqual(projectReportReceipt({ ...admitted, placement: "unplaced", delivery: "pending" }), { ...admitted, placement: "unplaced", delivery: "pending" });
	for (const placement of [undefined, "placed", "unplaced"])
		assert.deepEqual(projectReportReceipt({ ...retained, acknowledged: false, placement }), { ...retained, acknowledged: false, placement: "unplaced", delivery: "pending", boundary: REPORT_RECEIPT_BOUNDARY });
	assert.deepEqual(projectReportReceipt({ ...retained, acknowledged: false, delivery: "admitted" }), { ...retained, acknowledged: false, delivery: "admitted", boundary: REPORT_RECEIPT_BOUNDARY });
	for (const delivery of ["parked", "terminal"])
		assert.deepEqual(projectReportReceipt({ ...retained, acknowledged: false, delivery, placement: "unplaced" }), { ...retained, acknowledged: false, delivery, placement: "unplaced", boundary: REPORT_RECEIPT_BOUNDARY });
	assert.deepEqual(projectReportReceipt({ ...retained, delivery: "admitted" }), { ...retained, delivery: "admitted", boundary: REPORT_RECEIPT_BOUNDARY });
});

it("omits a host intervention association of any shape and refuses a malformed result reference", () => {
	const intervention = { producerRunId: 3, producerResults: [{ sessionId: "producer", submissionId: 7, requestId: "input" }] };
	const source = { sourceId: "report:one", acknowledged: true };
	for (const association of [intervention, { ...intervention, message: "body" }, { producerRunId: 0, producerResults: [] }, "text", null]) {
		const value = projectReportReceipt({ ...source, intervention: association });
		assert.deepEqual(value, { ...source, boundary: REPORT_RECEIPT_BOUNDARY });
	}
	const refused = projectReportReceipt({ ...source, result: { sessionId: "producer", message: "body" } }) as Record<string, unknown>;
	assert.equal(refused.format, "refused");
	assert.doesNotMatch(controlText(refused), /message|body/u);
});

it("renders provider evidence through its qualified recovery formatter outside result identity metadata", () => {
	const block = { blockId: "block-one", conversationId: 2, providerSessionId: "provider-session", epoch: 0,
		model: { provider: "test", modelId: "model" }, error: "Quota exhausted", errorRedacted: false, errorTruncated: false,
		source: "host-block", timestamp: 0, originalResults: [{ sessionId: "producer:2", submissionId: 7 }], omittedOriginalResults: 0 };
	const output = readableControlText({ ...result, providerBlock: block });
	assert.match(output, /1970-01-01T00:00:00.000Z/u);
	assert.match(output, /did not reach the provider/u);
	assert.match(output, /agent_configure\(/u);
	assert.ok(output.startsWith(result.answer));
});

it("refuses oversized receipt metadata without cutting exact identifiers", () => {
	const receipt = projectReportReceipt({ sourceId: "a".repeat(17000), acknowledged: true, message: "body" }) as Record<string, unknown>;
	assert.equal(receipt.format, "refused");
	assert.ok(Buffer.byteLength(JSON.stringify(receipt)) < 16384);
	assert.equal(Object.hasOwn(receipt, "sourceId"), false);
});
