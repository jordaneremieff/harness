import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LivePublisher, LiveRoute } from "./live-bridge.ts";
import { isRecord, liveId } from "./live-protocol.ts";

interface ApplicationMessage {
	version: 1;
	sessionId: string;
	extension: "explorer";
	application: "Explorer";
	id: string;
	subject: string;
	follows?: string;
	reply: "final";
	guidance: string;
	text: string;
}
interface ApplicationReceiver {
	version: 1;
	deliver(
		message: ApplicationMessage,
	): { status: "requested"; reference: string } | { status: "rejected"; message: string };
}
const guidance =
	'File paths are relative to the Explorer root. Lines and quotes refer to the cited commit or working tree. To read a cited note and its thread, use explorer_notes with op "read", its id and the root.';

function isReceiver(value: unknown): value is ApplicationReceiver {
	return isRecord(value) && value.version === 1 && typeof value.deliver === "function";
}
function subject(root: string): string {
	const label = root.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ").trimEnd();
	return label.length <= 200 ? label : `…${label.slice(-199).replace(/^[\uDC00-\uDFFF]/u, "")}`;
}

function answerText(id: string, text: string, shared: unknown): string {
	if (typeof shared !== "number" || !Number.isSafeInteger(shared) || shared < 1) return text;
	return `Shared reply for #${id.slice(0, 8).toLowerCase()} and ${shared} other ${shared === 1 ? "message" : "messages"}:\n\n${text}`;
}

/** Each reply goes to the bridge that delivered the request, independent of Pi's turn boundaries. */
export function explorerApplicationRoutes(events: ExtensionAPI["events"]) {
	let receiver: ApplicationReceiver | undefined;
	const waiting = new Map<string, LivePublisher>();
	events.on("harness:application-messages:receiver", (value) => {
		if (isReceiver(value)) receiver = value;
	});
	events.on("harness:application-messages:reply", (value) => {
		if (!isRecord(value) || value.version !== 1 || value.extension !== "explorer") return;
		const { id, status, shared, text } = value;
		if (
			!liveId(id) ||
			typeof text !== "string" ||
			(status !== "working" && status !== "answer" && status !== "unanswered")
		)
			return;
		const publish = waiting.get(id);
		if (!publish) return;
		if (status !== "working") waiting.delete(id);
		const body = status === "answer" ? answerText(id, text, shared) : text;
		publish(status === "unanswered" ? "error" : status, body, id);
	});
	events.emit("harness:application-messages:request", { version: 1 });

	return (sessionId: string, check: () => void): LiveRoute => {
		let publish: LivePublisher;
		return {
			label: "this Pi conversation",
			submit: async ({ requestId, threadId, root, text }) => {
				check();
				if (!receiver) return { status: "rejected", message: "This conversation has no application message receiver." };
				waiting.set(requestId, publish);
				const receipt = receiver.deliver({
					version: 1,
					sessionId,
					extension: "explorer",
					application: "Explorer",
					id: requestId,
					subject: subject(root),
					...(threadId.toLowerCase() === requestId.toLowerCase() ? {} : { follows: threadId }),
					reply: "final",
					guidance,
					text,
				});
				if (receipt.status === "requested") return { status: "requested" };
				waiting.delete(requestId);
				return receipt;
			},
			observe: async (emit) => {
				publish = emit;
				return () => {
					for (const [id, sink] of waiting) if (sink === emit) waiting.delete(id);
				};
			},
		};
	};
}
