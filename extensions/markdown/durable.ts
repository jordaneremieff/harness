import type * as Durable from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { readSettings, publishSettings, type SettingsBus } from "./settings.ts";
import { MarkdownStore } from "./store.ts";
import { recentNative, readNative, type NativeSource } from "./native-responses.ts";
import { readPanelRequest, responsePage, type MarkdownAnswer } from "./panel-protocol.ts";
import { createNativePublishTool } from "./publish.ts";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface MarkdownHost {
	readonly durable: typeof Durable;
	readonly agentDir: string;
	readonly cwd: string;
	readonly storageId: string;
	readonly harness: Durable.Harness;
	onClose(dispose: () => void | Promise<void>): void;
}
export interface MarkdownCommandCall {
	readonly args: string;
	readonly data?: JsonValue;
	readonly origin?: "operator" | "model";
	readonly conversation: Durable.Conversation;
	readonly context: Context;
	readonly host: MarkdownHost;
	readonly invocationId: string;
}
const json = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value)) as JsonValue;
const line = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 180);
function nativeSource(call: MarkdownCommandCall): NativeSource {
	return { durable: call.host.durable, conversation: call.conversation, storageId: call.host.storageId, cwd: call.host.cwd };
}
async function published(store: MarkdownStore): Promise<Extract<MarkdownAnswer, { op: "published" }>> {
	const identity = await store.identity();
	if (!identity) return { op: "published", rows: [], root: store.root, limited: false };
	const result = await store.list({ kind: "published" });
	return { op: "published", rows: result.documents, root: store.root, storeId: identity.storeId, limited: result.bounded };
}
/** Both text and structured command routes only read; origin grants no additional effect. */
export async function runMarkdownCommand(call: MarkdownCommandCall): Promise<string | { text: string; data: JsonValue }> {
	const source = nativeSource(call);
	const store = new MarkdownStore(readSettings({ agentDir: call.host.agentDir }).values.dir);
	if (call.data === undefined) {
		const [recent, documents] = await Promise.all([recentNative(source, call.context), published(store)]);
		return [
			`Markdown: ${recent.rows.length} recent responses (stop: ${recent.stop}, ${recent.visited} entries visited). Previews only.`,
			...recent.rows.slice(0, 10).map((row) => `${row.entryId} · ${row.bytes} bytes · ${row.completeness.state} · ${line(row.preview)}`),
			`${documents.rows.length} published documents${documents.limited ? " (scan limit reached)" : ""}:`,
			...documents.rows.slice(0, 10).map((row) => `${row.id} · revision ${row.revision} · ${line(row.title)}`),
			"Use the Markdown owner view to read a complete response or document. No model turn or window was started.",
		].join("\n");
	}
	const request = readPanelRequest(call.data);
	let answer: MarkdownAnswer;
	switch (request.op) {
		case "recent": answer = { op: "recent", ...await recentNative(source, call.context) }; break;
		case "response": answer = responsePage(await readNative(source, request.entryId, call.context), request.offset); break;
		case "published": answer = await published(store); break;
	}
	return { text: `Markdown ${answer.op}: bounded source data; no window or model turn started.`, data: json(answer) };
}
export function markdownContribution(source: string, bus: SettingsBus, stopFactoryPublisher: () => void) {
	return {
		name: "markdown", source,
		display: { version: 1 as const, entry: "./display.ts", export: "toolDisplay" as const },
		panel: { version: 1 as const, entry: "./operator-panel.ts", export: "operatorPanel" as const, command: "markdown" },
		commands: [{ name: "markdown", description: "Read retained assistant responses and list published Markdown documents without a model turn", run: runMarkdownCommand }],
		create(host: MarkdownHost): Durable.Extension {
			stopFactoryPublisher();
			host.onClose(publishSettings(bus, { agentDir: host.agentDir }));
			const settings = readSettings({ agentDir: host.agentDir }).values;
			return host.durable.defineExtension({
				name: "markdown",
				tools: [createNativePublishTool({ durable: host.durable, cwd: host.cwd, storageId: host.storageId }, { store: new MarkdownStore(settings.dir), app: settings.app })],
				sections: [host.durable.section("markdown", () => "Use markdown_publish for an explicitly requested document or a deliverable meant for sustained reading. Publication saves silently. Existing assistant responses are already readable through the operator's Markdown view; do not publish every reply.")],
			});
		},
	};
}
