import type { JsonValue, OperatorPanelModule, PanelHost } from "../../operator-ui/index.ts";
import { markdownView, type MarkdownOperations, type MarkdownRow } from "./operator-view.ts";
import { acquireResponse, readPanelAnswer, type MarkdownAnswer, type MarkdownRequest } from "./panel-protocol.ts";

/** Requests stay on the captured owner route, and the view signal withdraws them; only the explicit Read action imports reveal. */
export function panelOperations(host: PanelHost): MarkdownOperations {
	const ask = async (request: MarkdownRequest, signal: AbortSignal): Promise<MarkdownAnswer> => {
		signal.throwIfAborted();
		const answer = await host.request(request as JsonValue, signal);
		signal.throwIfAborted();
		return readPanelAnswer(request, answer.data);
	};
	const read = async (row: MarkdownRow, signal: AbortSignal): Promise<string> => {
		if (row.kind === "response") {
			const entryId = row.response.entryId;
			const response = await acquireResponse(entryId, (request) => ask(request, signal), signal);
			signal.throwIfAborted();
			const reveal = await import("./reveal.ts");
			signal.throwIfAborted();
			return reveal.openResponse(response, signal);
		}
		const { id, revision, digest } = row.document;
		const { root, storeId } = row;
		if (!root || !storeId) throw new Error("The host did not supply a local store identity.");
		const reveal = await import("./reveal.ts");
		signal.throwIfAborted();
		return reveal.openStored(root, id, signal, { gui: true, storeId, pin: { revision, digest } });
	};
	return {
		load: async (scope, signal) => {
			if (scope === "recent") {
				const answer = await ask({ op: "recent" }, signal);
				if (answer.op !== "recent") throw new Error("Unexpected recent answer.");
				return { rows: answer.rows.map((response) => ({ kind: "response", response })), coverage: `${answer.rows.length} response${answer.rows.length === 1 ? "" : "s"} · ${answer.visited} entries visited · stop: ${answer.stop} · previews only` };
			}
			const answer = await ask({ op: "published" }, signal);
			if (answer.op !== "published") throw new Error("Unexpected published answer.");
			return { rows: answer.rows.map((document) => ({ kind: "document", document, root: answer.root, storeId: answer.storeId })), coverage: `${answer.rows.length} published document${answer.rows.length === 1 ? "" : "s"}${answer.limited ? " · store scan limit reached" : ""}` };
		},
		read,
		latest: async (signal) => {
			const answer = await ask({ op: "recent" }, signal);
			if (answer.op !== "recent") throw new Error("Unexpected recent answer.");
			const response = answer.rows[0];
			if (!response) throw new Error(`No retained assistant response with text was found (stop: ${answer.stop}).`);
			return read({ kind: "response", response }, signal);
		},
	};
}
export function operatorPanel(): OperatorPanelModule {
	return { version: 2, title: "Markdown", open: (host) => markdownView(host, panelOperations(host)) };
}
