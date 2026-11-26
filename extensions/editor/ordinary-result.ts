import { isJsonValue, type JsonValue } from "@earendil-works/chord/json";
import { obj } from "@earendil-works/pi-schema";

export const editorOutputSchema = obj({}, { open: true });
export const editorTextLimit = 192 * 1024;

const limitReached = Symbol();
const TOO_LARGE =
	"The editor result exceeds the direct text limit. Use a narrower request or the structured editor result.";

function resultText(result: JsonValue): string {
	let remaining = editorTextLimit;
	try {
		const text = JSON.stringify(result, (key, value: unknown) => {
			remaining -= key.length + (typeof value === "string" ? value.length : 1) + 1;
			if (remaining < 0) throw limitReached;
			return value;
		});
		return Buffer.byteLength(text) <= editorTextLimit ? text : TOO_LARGE;
	} catch (error) {
		if (error === limitReached) return TOO_LARGE;
		throw error;
	}
}

export function editorResult(result: Record<string, unknown>) {
	if (!isJsonValue(result)) throw new Error("The editor returned invalid JSON");
	return { value: result, content: [{ type: "text" as const, text: resultText(result) }] };
}
