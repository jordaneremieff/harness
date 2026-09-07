import { digest, type AccessPage } from "./access.ts";
import { type Cell, type Reasoning, type Stage, validateCell, zero } from "./capacity.ts";
import { BODY_BYTES, type Resource } from "./catalog.ts";

export type Extent = "full" | "partial" | "unknown";
export interface ResultEvidence {
	extent: Extent;
	returned?: Buffer;
	isError?: boolean;
}
export interface Observation {
	stage: Stage;
	day: string;
	resource: Resource;
	model?: string;
	reasoning?: string;
	piVersion: string;
	reference?: Buffer;
	result?: ResultEvidence;
}
export function extract(input: Observation): Cell {
	const reference = input.reference && input.reference.length <= BODY_BYTES ? input.reference : undefined;
	const counters = zero();
	const cell: Cell = {
		day: input.day,
		observationStage: input.stage,
		resourceClass: input.resource.resourceClass,
		resourceId: input.resource.resourceId,
		model: input.model && /^[A-Za-z0-9][A-Za-z0-9._/+:-]{0,63}$/.test(input.model) ? input.model : "unknown",
		reasoning: (["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(input.reasoning ?? "")
			? input.reasoning
			: "unknown") as Reasoning,
		referenceBodyDigest: reference ? digest(reference) : "unresolved",
		observerVersion: "0.1.0",
		piVersion: input.piVersion,
		counters,
	};
	if (input.stage === "tool_request") counters.readRequests = 1;
	else {
		counters.readResults = 1;
		const result = input.result;
		const outcome = result?.isError
			? "resultError"
			: result?.extent === "full"
				? "resultComplete"
				: result?.extent === "partial"
					? "resultPartial"
					: "resultUnknown";
		counters[outcome] = 1;
		if (outcome === "resultComplete" && reference && result?.returned && result.returned.length <= BODY_BYTES) {
			counters[result.returned.equals(reference) ? "bodyVerifiedAtObservation" : "bodyMismatchedAtObservation"] = 1;
		} else counters.bodyUnverifiable = 1;
	}
	validateCell(cell, input.day);
	return cell;
}

export function textResult(content: unknown): string | undefined {
	if (!Array.isArray(content) || content.length !== 1) return undefined;
	const block = content[0];
	return block?.type === "text" &&
		typeof block.text === "string" &&
		block.text.length <= BODY_BYTES &&
		Buffer.byteLength(block.text) <= BODY_BYTES
		? block.text
		: undefined;
}

/** Byte equality proves a complete reference body without trusting a no-limit request. */
export function readEvidence(content: unknown, reference: Buffer | undefined, isError: boolean): ResultEvidence {
	const text = textResult(content);
	const returned = text === undefined ? undefined : Buffer.from(text);
	return { isError, returned, extent: reference && returned?.equals(reference) ? "full" : "unknown" };
}

/** Only this extension's source tool owns this explicit byte-range contract. */
export type DeliveryExtent = Pick<
	AccessPage,
	"resource" | "offset" | "endOffset" | "bodyBytes" | "referenceBodyDigest"
>;
export function accessEvidence(
	content: unknown,
	resourceId: string,
	isError: boolean,
	delivered?: DeliveryExtent,
): ResultEvidence {
	const text = textResult(content);
	if (!delivered || !text || Buffer.byteLength(text) > 32768) return { isError, extent: "unknown" };
	try {
		const page = JSON.parse(text) as AccessPage;
		if (
			page.schema !== "pillars-source" ||
			page.resource !== resourceId ||
			typeof page.text !== "string" ||
			page.resource !== delivered.resource ||
			page.offset !== delivered.offset ||
			page.endOffset !== delivered.endOffset ||
			page.bodyBytes !== delivered.bodyBytes ||
			page.referenceBodyDigest !== delivered.referenceBodyDigest ||
			!Number.isInteger(page.offset) ||
			!Number.isInteger(page.endOffset) ||
			!Number.isInteger(page.bodyBytes) ||
			page.offset < 0 ||
			page.endOffset < page.offset ||
			page.endOffset > page.bodyBytes ||
			page.bodyBytes > BODY_BYTES ||
			Buffer.byteLength(page.text) !== page.endOffset - page.offset
		)
			return { isError, extent: "unknown" };
		return {
			isError,
			returned: Buffer.from(page.text),
			extent:
				page.offset === 0 && page.endOffset === page.bodyBytes && page.nextOffset === undefined ? "full" : "partial",
		};
	} catch {
		return { isError, extent: "unknown" };
	}
}

export class Deduplicator {
	private seen = new Set<string>();
	private warned = false;
	newTurn(): void {
		this.seen.clear();
		this.warned = false;
	}
	admit(call: string, stage: Stage): "admitted" | "duplicate" | "saturated" {
		const value = `${stage}:${call}`;
		if (Buffer.byteLength(call) > 256) return "saturated";
		if (this.seen.has(value)) return "duplicate";
		if (this.seen.size === 4096) return "saturated";
		this.seen.add(value);
		return "admitted";
	}
	warnOnce(): boolean {
		const result = !this.warned;
		this.warned = true;
		return result;
	}
}
