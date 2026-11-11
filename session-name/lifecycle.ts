import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry, SessionInfoEntry } from "@earendil-works/pi-coding-agent";
import { sessionNameFromInput } from "./index.ts";

export type NameOffer = { source: "interactive" | "evo"; text: string };
export type ProvisionalName = {
	sessionId: string;
	nameEntryId: string;
	text: string;
	fallback: string;
	signal: AbortSignal;
};
export type RefinedName = { sessionId: string; nameEntryId: string; title: string };

type Receipt = { sessionId: string; nameEntryId: string; phase: "fallback" | "semantic" };
type Pending = { entryId: string; fallback: string; text?: string; controller: AbortController };
const RECEIPT_TYPE = "session-name:automatic";
const runtimes = new WeakMap<ExtensionAPI, NamingRuntime>();

function latestName(entries: SessionEntry[]): SessionInfoEntry | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type === "session_info") return entry;
	}
	return undefined;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function receiptFor(entries: SessionEntry[], sessionId: string, entryId: string): Receipt | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== RECEIPT_TYPE || !record(entry.data)) continue;
		const data = entry.data;
		if (data.sessionId === sessionId && data.nameEntryId === entryId && (data.phase === "fallback" || data.phase === "semantic")) {
			return { sessionId, nameEntryId: entryId, phase: data.phase };
		}
	}
	return undefined;
}

function usefulInput(text: string): boolean {
	const content = text.trim().replace(/^\/\S*\s*/u, "");
	return content.split(/\s+/u).some((word) => !word.startsWith("-") && /[\p{L}\p{N}]/u.test(word))
		&& (content.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 3;
}

class NamingRuntime {
	private readonly sessionId: string;
	private readonly pi: ExtensionAPI;
	private readonly ctx: ExtensionContext;
	private readonly remove: Array<() => void> = [];
	private active = true;
	private writing = false;
	private pending?: Pending;

	constructor(pi: ExtensionAPI, ctx: ExtensionContext) {
		this.pi = pi;
		this.ctx = ctx;
		this.sessionId = ctx.sessionManager.getSessionId();
		this.remove.push(
			pi.events.on("session-name:refined", (value) => { this.refine(value); }),
			pi.on("input", () => { this.discardSource(); }),
			pi.on("before_agent_start", () => { this.emit(); }),
			pi.on("session_info_changed", () => { this.observeName(); }),
			pi.on("session_shutdown", () => { this.close(); }),
			pi.on("session_start", () => { this.close(); }),
		);
	}

	discardSource(): void {
		if (this.pending) this.pending.text = undefined;
	}

	offer(text: string): void {
		if (!this.current()) return;
		const entries = this.ctx.sessionManager.getEntries();
		if (latestName(entries) || this.pi.getSessionName() !== undefined) return;
		const fallback = sessionNameFromInput(text) ?? sessionNameFromInput(`Work in ${basename(this.ctx.cwd)}`) ?? "Work";
		const entry = this.write(fallback, undefined, "fallback");
		if (entry) {
			this.pending = { entryId: entry.id, fallback, text: Array.from(text).slice(0, 4096).join(""), controller: new AbortController() };
		} else {
			this.close();
		}
	}

	private current(): boolean {
		return this.active && this.ctx.sessionManager.getSessionId() === this.sessionId;
	}

	private ownsFallback(entryId: string): boolean {
		if (!this.current()) return false;
		const entries = this.ctx.sessionManager.getEntries();
		return latestName(entries)?.id === entryId && receiptFor(entries, this.sessionId, entryId)?.phase === "fallback";
	}

	private write(title: string, expectedId: string | undefined, phase: Receipt["phase"]): SessionInfoEntry | undefined {
		const manager = this.ctx.sessionManager;
		const before = manager.getEntries();
		if (!this.current() || latestName(before)?.id !== expectedId) return undefined;
		this.writing = true;
		try {
			this.pi.setSessionName(title);
			if (!this.current()) return undefined;
			const added = manager.getEntries().slice(before.length).filter((entry) => entry.type === "session_info");
			const entry = added[0];
			// A reentrant setter has no unambiguous automatic write to acknowledge.
			if (added.length !== 1 || entry?.type !== "session_info" || entry.name !== title) return undefined;
			this.pi.appendEntry<Receipt>(RECEIPT_TYPE, { sessionId: this.sessionId, nameEntryId: entry.id, phase });
			return entry;
		} catch {
			// An unacknowledged write remains protected rather than eligible for repair.
			return undefined;
		} finally {
			this.writing = false;
		}
	}

	private emit(): void {
		const pending = this.pending;
		if (!pending || pending.text === undefined) return;
		if (!this.ownsFallback(pending.entryId)) { this.cancel(); return; }
		const text = pending.text;
		pending.text = undefined;
		this.pi.events.emit("session-name:provisional", {
			sessionId: this.sessionId, nameEntryId: pending.entryId, text, fallback: pending.fallback, signal: pending.controller.signal,
		} satisfies ProvisionalName);
	}

	private refine(value: unknown): void {
		if (!record(value) || typeof value.sessionId !== "string" || typeof value.nameEntryId !== "string" || typeof value.title !== "string") return;
		if (value.sessionId !== this.sessionId || !this.ownsFallback(value.nameEntryId)) return;
		const title = sessionNameFromInput(value.title);
		if (!title) return;
		this.write(title, value.nameEntryId, "semantic");
		this.observeName();
	}

	private observeName(): void {
		if (!this.writing && this.pending && !this.ownsFallback(this.pending.entryId)) this.cancel();
	}

	private cancel(): void {
		this.pending?.controller.abort();
		this.pending = undefined;
	}

	private close(): void {
		if (!this.active) return;
		this.active = false;
		this.cancel();
		for (const remove of this.remove.splice(0)) remove();
		if (runtimes.get(this.pi) === this) runtimes.delete(this.pi);
	}
}

/** Offer source text without replacing a protected name or awaiting a generator. */
export function offerSessionName(pi: ExtensionAPI, ctx: ExtensionContext, offer: NameOffer): void {
	let runtime = runtimes.get(pi);
	runtime?.discardSource();
	if ((offer.source !== "interactive" && offer.source !== "evo") || !usefulInput(offer.text)) return;
	if (!runtime) {
		if (latestName(ctx.sessionManager.getEntries()) || pi.getSessionName() !== undefined) return;
		runtime = new NamingRuntime(pi, ctx);
		runtimes.set(pi, runtime);
	}
	runtime.offer(offer.text);
}
