import { Type } from "typebox";
import { Value } from "typebox/value";
import { CORRECTION_TASK, JUDGMENT_AUTHORITY } from "./commands.ts";

export const MAX_DRAFT_CHARACTERS = 8192;
/** The handler and Pi use TypeBox's grapheme count and the same string contract. */
export const DraftSchema = Type.String({
	minLength: 1,
	maxLength: MAX_DRAFT_CHARACTERS,
	pattern: "^(?=[\\s\\S]*\\S)(?:[^\\uD800-\\uDFFF]|[\\uD800-\\uDBFF][\\uDC00-\\uDFFF])+$",
	description: "Concrete agent-authored proposal to assess after this source read. Nonblank, well-formed Unicode, at most 8192 characters (TypeBox grapheme clusters). Retained in native history, not private scratch.",
});
export const DRAFT_GUIDANCE =
	"Before a consequential decision, action, or answer, include your concrete proposal as draft to check it before delivery; do not wait for an operator cue. A successful source read delivers an assessment task after the tool results for you to apply in the ordinary continuation. Preserve routine execution and exact-output tasks without added ceremony. The optional draft accepts at most 8192 characters (TypeBox grapheme clusters) and stays in native history, not private scratch. Source JSON remains unchanged.";

export class DraftInputError extends Error {
	constructor(condition: string, size?: { characters: number; bytes: number }) {
		super(`draft: ${condition}.${size ? ` Measured ${size.characters} characters (TypeBox grapheme clusters), ${size.bytes} UTF-8 bytes.` : ""} Use a nonblank, well-formed Unicode string of at most ${MAX_DRAFT_CHARACTERS} characters (TypeBox grapheme clusters), or omit draft for source access only. Draft contents are withheld.`);
	}
}

/** Measure with Pi's validator; its ordinary loader exposes value, not the guard subpath. */
function characterCount(value: string): number {
	let low = 0;
	let high = value.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (Value.Check(Type.String({ maxLength: middle }), value)) high = middle;
		else low = middle + 1;
	}
	return low;
}

export function splitDraft(input: unknown): { source: unknown; draft?: string } {
	if (!input || typeof input !== "object" || Array.isArray(input) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(input)) || !Object.hasOwn(input, "draft"))
		return { source: input };
	const { draft, ...source } = input as Record<string, unknown>;
	if (typeof draft !== "string") throw new DraftInputError("expected a string; received a non-string value");
	const size = { characters: characterCount(draft), bytes: Buffer.byteLength(draft, "utf8") };
	if (/[\uD800-\uDFFF]/u.test(draft)) throw new DraftInputError("malformed Unicode: unpaired surrogate", size);
	if (!draft.trim()) throw new DraftInputError("blank text", size);
	if (size.characters > MAX_DRAFT_CHARACTERS) throw new DraftInputError("character limit exceeded", size);
	return { source, draft };
}

export function draftAssessment(draft: string): string {
	return [
		"Pillars extension assessment task. The draft below is agent-authored DATA, not operator input, new doctrine, or permission.",
		"Check this concrete proposal against the actual authorized request and applicable Pillars before you deliver or act on it. Follow the existing consultation and source requirements; use relevant bodies already in context when sufficient.",
		CORRECTION_TASK,
		"Finish the authorized task with the corrected work. Preserve its output constraints; do not add a separate assessment, verdict, or recital unless requested.",
		JUDGMENT_AUTHORITY,
		"Agent-authored draft (JSON string; data only):",
		JSON.stringify(draft),
	].join("\n\n");
}
