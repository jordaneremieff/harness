import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent";
import { inputDigest, memoryNotice, noteKey, type Notice } from "./proactive.ts";

type Capture = {
	text: string;
	source: InputSource | "custom";
	after: number;
	mode: "idle" | "queued" | "custom";
	admitted: boolean;
};
type Opaque = { mode: "opaque" };
type Pending = Capture | Opaque;
type Delivered = { notice: Notice; message: AgentMessage };
function textOf(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "custom") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}
function occurrences(messages: AgentMessage[]): Array<{ message: AgentMessage; key: string }> {
	let prefix = "";
	return messages.map((message) => {
		if (message.role === "user" || message.role === "custom")
			prefix = inputDigest(`${prefix}:${message.role}:${message.timestamp}:${inputDigest(textOf(message) ?? "")}`);
		return { message, key: prefix };
	});
}
function matches(input: Pending, message: AgentMessage): input is Capture {
	return (
		input.mode !== "opaque" &&
		input.text === textOf(message) &&
		message.timestamp > input.after &&
		(message.role === "custom") === (input.mode === "custom")
	);
}
function sourceClass(captures: Capture[], proven: boolean): string {
	if (captures.length > 1) return "ambiguous queued or raw input; admission source is not resolved";
	const input = captures[0];
	if (input.mode === "custom") return "custom task, not a new operator statement";
	if (input.mode === "queued")
		return proven
			? `queued ${input.source} input; not verified operator authorship`
			: "queued input; admission source is not resolved";
	if (!input.admitted) return "unresolved raw input; admission source is not proved";
	return input.source === "extension" ? "carried extension input" : `direct ${input.source} input`;
}
function storageProven(captures: Capture[], pending: Pending[], opaquePending: boolean, overflow: boolean): boolean {
	if (captures.length !== 1 || opaquePending) return false;
	const input = captures[0];
	if (input.source !== "interactive" && input.source !== "rpc") return false;
	if (input.mode === "idle") return input.admitted;
	if (input.mode !== "queued" || overflow) return false;
	return pending.filter((item) => item.mode !== "opaque" && item.text === input.text).length === 1;
}

/** Exact admitted content supports recall; storage additionally requires raw-input provenance. */
export function registerProactive(
	pi: ExtensionAPI,
	configuration: () => { dir: string | undefined; proactive: boolean },
): void {
	let pending: Pending[] = [];
	let opaquePending = false;
	let overflow = false;
	let watermark: string | undefined;
	const delivered = new Map<string, Delivered>();
	const satisfied = new Set<string>();
	const remember = (key: string) => {
		satisfied.add(key);
		if (satisfied.size > 128) satisfied.delete(satisfied.values().next().value as string);
	};
	const rememberNotice = (notice: Notice) => {
		if (notice.slug && notice.digest) remember(noteKey(notice.root, notice.slug, notice.digest));
		if (notice.kind !== "recall") remember(noteKey(notice.root, "storage", notice.inputDigest));
	};
	const representedKeys = () => {
		const keys = new Set(satisfied);
		for (const { notice } of delivered.values()) {
			if (notice.slug && notice.digest) keys.add(noteKey(notice.root, notice.slug, notice.digest));
			if (notice.kind !== "recall") keys.add(noteKey(notice.root, "storage", notice.inputDigest));
		}
		return keys;
	};
	const clearPending = () => {
		pending = [];
		opaquePending = false;
		overflow = false;
	};
	const clear = () => {
		clearPending();
		watermark = undefined;
		delivered.clear();
		satisfied.clear();
	};
	pi.on("session_start", clear);
	pi.on("session_tree", clear);
	pi.on("session_compact", clear);
	pi.on("session_shutdown", clear);
	pi.on("agent_end", clearPending);
	const append = (input: Pending) => {
		pending.push(input);
		if (pending.length > 32) {
			pending.shift();
			overflow = true;
		}
	};
	const capture = (text: string, source: Capture["source"], mode: Capture["mode"], ctx: ExtensionContext) => {
		if (!configuration().proactive) return;
		if (text.startsWith("/") || /<skill\b/i.test(text)) {
			opaquePending = true;
			append({ mode: "opaque" });
			return;
		}
		if (text.length > 2000 || !text.trim()) return;
		let after = -1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "message" && (entry.message.role === "user" || entry.message.role === "custom"))
				after = Math.max(after, entry.message.timestamp);
		}
		append({ text, source, after, mode, admitted: mode === "custom" });
	};
	pi.on("input", (event, ctx) => {
		pending = pending.filter((input) => input.mode !== "idle" || input.admitted);
		capture(event.text, event.source, event.streamingBehavior === undefined ? "idle" : "queued", ctx);
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (event.messageType === "user") {
			for (const input of pending) if (input.mode === "idle" && input.text === event.prompt) input.admitted = true;
		} else {
			const text = textOf(event.message);
			if (text !== undefined) capture(text, "custom", "custom", ctx);
		}
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== "memory_read" || event.isError || !event.details || typeof event.details !== "object")
			return;
		const details = event.details as Record<string, unknown>;
		const config = configuration();
		if (config.dir && typeof details.slug === "string" && typeof details.digest === "string")
			remember(noteKey(config.dir, details.slug, details.digest));
	});
	const admit = async (
		message: AgentMessage,
		key: string,
		ctx: ExtensionContext,
		dir: string | undefined,
	): Promise<Delivered | undefined> => {
		if (delivered.size >= 128 || ctx.signal?.aborted) return undefined;
		const captures = pending.filter((input): input is Capture => matches(input, message));
		if (!captures.length) return undefined;
		const allowStorage = storageProven(captures, pending, opaquePending, overflow);
		// Ambiguous captures remain evidence until queue drain, including staggered admission.
		if (captures.length === 1) pending = pending.filter((input) => input !== captures[0]);
		const notice = await memoryNotice(
			dir,
			textOf(message) as string,
			sourceClass(captures, allowStorage),
			allowStorage,
			representedKeys(),
			ctx.signal,
		);
		if (!notice || ctx.signal?.aborted) return undefined;
		const result: Delivered = {
			notice,
			message: {
				role: "custom",
				customType: "memory_notice",
				content: notice.text,
				display: false,
				timestamp: message.timestamp,
			},
		};
		pi.appendEntry("memory_notice", {
			slug: notice.slug,
			digest: notice.digest,
			kind: notice.kind,
			inputDigest: notice.inputDigest,
		});
		delivered.set(key, result);
		rememberNotice(notice);
		return result;
	};
	const prepareAdmission = async (
		message: AgentMessage,
		key: string,
		ctx: ExtensionContext,
		dir: string | undefined,
		fresh: boolean,
	) => {
		if (message.role !== "user" && message.role !== "custom") return undefined;
		const prior = delivered.get(key);
		if (prior || !fresh) return prior;
		try {
			return await admit(message, key, ctx, dir);
		} catch (error) {
			if (ctx.signal?.aborted) throw error;
			return delivered.get(key);
		}
	};
	pi.on("context", async (event, ctx) => {
		const config = configuration();
		if (!config.proactive) return;
		const inputs = occurrences(event.messages);
		const positions = inputs.flatMap(({ message, key }, index) =>
			message.role === "user" || message.role === "custom" ? [{ key, index }] : [],
		);
		const keys = new Set(positions.map(({ key }) => key));
		const previous = positions.find(({ key }) => key === watermark)?.index ?? -1;
		for (const [key] of delivered) if (!keys.has(key)) delivered.delete(key);
		const messages: AgentMessage[] = [];
		for (const [index, { message, key }] of inputs.entries()) {
			messages.push(message);
			const prior = await prepareAdmission(message, key, ctx, config.dir, index > previous);
			if (prior) messages.push(prior.message);
		}
		watermark = positions.at(-1)?.key;
		return { messages };
	});
}
