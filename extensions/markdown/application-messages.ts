import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LivePrompt, PromptReply } from "./live-bridge.ts";
import { isRecord, liveId, type LivePromptReceipt } from "./live-protocol.ts";

export const MARKDOWN_ASK_GUIDANCE =
	"Use markdown_live with the pane handle to read the current buffer before any edit and to apply {find, replace} edits. Do not substitute a stored document, file write or new pane. Marks in a source excerpt enclose the selection. Offsets count UTF-16 code units at the stated generation.";

interface ApplicationMessage {
	version: 1;
	sessionId: string;
	extension: string;
	application: string;
	id: string;
	subject: string;
	place?: string;
	follows?: string;
	reply: "final" | "none";
	guidance?: string;
	text: string;
}
type ApplicationReceipt = { status: "requested"; reference: string } | { status: "rejected"; message: string };
interface Receiver {
	version: 1;
	deliver(message: ApplicationMessage): ApplicationReceipt;
}
function isReceiver(value: unknown): value is Receiver {
	return isRecord(value) && value.version === 1 && typeof value.deliver === "function";
}
function subject(title?: string): string {
	const name = title?.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "").trim();
	return [...(name || "Markdown document")].slice(0, 200).join("");
}
function cardAnswer(id: string, text: string, shared: unknown): string | undefined {
	if (shared === undefined) return text;
	if (typeof shared !== "number" || !Number.isSafeInteger(shared) || shared < 1) return;
	return `Shared reply for #${id.slice(0, 8).toLowerCase()} and ${shared} other ${shared === 1 ? "message" : "messages"}:\n\n${text}`;
}
export function markdownMessages(events: ExtensionAPI["events"]) {
	let receiver: Receiver | undefined;
	const waiting = new Map<string, { reply: PromptReply; requested: boolean }>();
	events.on("harness:application-messages:receiver", (value) => {
		if (isReceiver(value)) receiver = value;
	});
	events.on("harness:application-messages:reply", (value) => {
		if (
			!isRecord(value) ||
			value.version !== 1 ||
			value.extension !== "markdown" ||
			!liveId(value.id) ||
			typeof value.text !== "string"
		)
			return;
		const request = waiting.get(value.id);
		if (!request) return;
		switch (value.status) {
			case "working":
				request.reply("working", "");
				break;
			case "answer": {
				const text = cardAnswer(value.id, value.text, value.shared);
				if (text === undefined) return;
				waiting.delete(value.id);
				request.reply("answer", text);
				break;
			}
			case "unanswered":
				waiting.delete(value.id);
				request.reply("error", value.text);
		}
	});
	events.emit("harness:application-messages:request", { version: 1 });
	return {
		send(sessionId: string, prompt: LivePrompt, reply: PromptReply): LivePromptReceipt {
			if (!receiver)
				return {
					status: "rejected",
					message: "This conversation has no application message receiver. Your question was not sent.",
				};
			const { operationId: id, handle, title, follows, text } = prompt;
			// A synchronous receiver can report progress before deliver returns.
			const request = { reply, requested: false };
			waiting.set(id, request);
			const receipt = receiver.deliver({
				version: 1,
				sessionId,
				extension: "markdown",
				application: "Markdown reader",
				id,
				subject: subject(title),
				place: `pane ${handle}`,
				...(follows !== undefined && { follows }),
				reply: "final",
				guidance: MARKDOWN_ASK_GUIDANCE,
				text,
			});
			if (receipt.status === "requested" && typeof receipt.reference === "string") {
				request.requested = true;
				return { status: "requested" };
			}
			if (receipt.status !== "rejected" || typeof receipt.message !== "string")
				throw new Error("The application message receiver did not confirm delivery.");
			waiting.delete(id);
			return { status: "rejected", message: receipt.message };
		},
		end(reloading: boolean) {
			// The reader can hand off its bridge before the receiver's shutdown hook runs.
			if (reloading)
				for (const request of waiting.values()) {
					if (request.requested) request.reply("error", "Pi reloaded. Check the conversation for the reply.");
				}
			waiting.clear();
		},
	};
}
