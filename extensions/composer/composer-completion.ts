import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";
import { type JsonObject, draft, integer, object, string } from "./composer-bridge.ts";

function cursorBoundary(text: string, cursor: number): boolean {
	return cursor <= text.length && (cursor === text.length || !/^[\uDC00-\uDFFF]/u.test(text.slice(cursor, cursor + 1)));
}
function position(body: JsonObject): { lines: string[]; line: number; col: number } {
	const text = draft(body.text);
	const cursor = integer(body.cursor);
	if (!cursorBoundary(text, cursor)) throw new Error("Completion cursor is outside a UTF-16 character boundary.");
	const before = text.slice(0, cursor).split("\n");
	return { lines: text.split("\n"), line: before.length - 1, col: before.at(-1)?.length ?? 0 };
}
function item(value: unknown): AutocompleteItem {
	const entry = object(value);
	return { value: string(entry.value), label: string(entry.label), ...(entry.description === undefined ? {} : { description: string(entry.description) }) };
}

export class ComposerCompletion {
	private active?: AbortController;
	async suggest(provider: AutocompleteProvider | undefined, body: JsonObject, signal: AbortSignal): Promise<JsonObject> {
		this.active?.abort();
		const { lines, line, col } = position(body);
		const force = body.force;
		if (force !== undefined && typeof force !== "boolean") throw new Error("Expected a boolean force flag.");
		if (!provider) return { prefix: "", items: [] };
		const current = new AbortController();
		this.active = current;
		try {
			const combined = AbortSignal.any([signal, current.signal]);
			combined.throwIfAborted();
			const result = await provider.getSuggestions(lines, line, col, { signal: combined, force });
			combined.throwIfAborted();
			return result ? { prefix: string(result.prefix), items: result.items.slice(0, 50).map(item) } : { prefix: "", items: [] };
		} finally { if (this.active === current) this.active = undefined; }
	}
	apply(provider: AutocompleteProvider | undefined, body: JsonObject): JsonObject {
		const { lines, line, col } = position(body);
		if (!provider) throw new Error("Pi's completion provider is not available.");
		const result = provider.applyCompletion(lines, line, col, item(body.item), string(body.prefix));
		const text = draft(result.lines.join("\n"));
		const row = integer(result.cursorLine);
		const column = integer(result.cursorCol);
		if (row >= result.lines.length || !cursorBoundary(result.lines[row], column)) throw new Error("Pi returned an invalid completion cursor.");
		const cursor = result.lines.slice(0, row).reduce((offset, line) => offset + line.length + 1, column);
		return { text, cursor };
	}
}
