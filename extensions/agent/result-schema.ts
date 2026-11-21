import { str, int, bool, lit, arr, union, opt, obj, type Static } from "@earendil-works/pi-schema";
import { BRIEF_KINDS, BRIEF_SECTIONS, briefEnum } from "./brief.ts";

/** Exact admitted native input. Creation and message routing are not results. */
export const ResultReferenceSchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256, pattern: "^[^\\s@]+$" }),
	submissionId: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	requestId: opt(str({ minLength: 1, maxLength: 1024 })),
});
export type ResultReference = Static<typeof ResultReferenceSchema>;

export const ReceiptContinuationSchema = obj({
	tool: lit("agent_inspect"),
	view: lit("result"),
	sessionId: str({ minLength: 1, maxLength: 256 }),
	submissionId: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	receiptCursor: str({ minLength: 1, maxLength: 2048 }),
});
export type ReceiptContinuation = Static<typeof ReceiptContinuationSchema>;
export const ReceiptReferencePageSchema = obj({
	recipient: str({ minLength: 1, maxLength: 256 }),
	results: arr(ResultReferenceSchema, { maxItems: 16 }),
	complete: bool(),
	next: union([lit(null), str({ minLength: 1, maxLength: 2048 })]),
});
export type ReceiptReferencePage = Static<typeof ReceiptReferencePageSchema>;
export const ReceiptAssociationSchema = obj({
	sourceId: str({ minLength: 1, maxLength: 1024 }),
	requestId: str({ minLength: 1, maxLength: 1024 }),
	recipient: str({ minLength: 1, maxLength: 256 }),
	producerStorageId: str({ minLength: 1, maxLength: 256 }),
	answerEntryId: opt(int({ minimum: 1 })),
	results: arr(ResultReferenceSchema, { maxItems: 16 }),
	complete: bool(),
	receiptContinuation: opt(ReceiptContinuationSchema),
});
export type ReceiptAssociation = Static<typeof ReceiptAssociationSchema>;

/** Dispatch facts remain additive; only result names an admitted answer input. */
const dispatchFields = { result: opt(ResultReferenceSchema) };
export const DispatchOutputSchema = obj(dispatchFields, { open: true });
export const BriefOutputSchema = obj(
	{
		...dispatchFields,
		brief: obj({
			kind: briefEnum(BRIEF_KINDS),
			characters: int({ minimum: 1 }),
			sections: arr(briefEnum(BRIEF_SECTIONS)),
			text: opt(str()),
		}),
		preview: opt(lit(true)),
		problems: opt(arr(str())),
	},
	{ open: true },
);
