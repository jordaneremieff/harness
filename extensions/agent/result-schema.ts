import { str, int, opt, obj, type Static } from "@earendil-works/pi-schema";

/** Exact admitted native input. Creation and message routing are not results. */
export const ResultReferenceSchema = obj({
	sessionId: str({ minLength: 1, maxLength: 256, pattern: "^[^\\s@]+$" }),
	submissionId: int({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
	requestId: opt(str({ minLength: 1, maxLength: 1024 })),
});
export type ResultReference = Static<typeof ResultReferenceSchema>;

/** Dispatch facts remain additive; only result names an admitted answer input. */
export const DispatchOutputSchema = obj({ result: opt(ResultReferenceSchema) }, { open: true });
