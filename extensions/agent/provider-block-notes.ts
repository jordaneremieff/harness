/**
 * Provider blocks that this process observed: in an ordinary Pi process, the
 * blocks that delivered results carried; in a native host, the blocks that its
 * own conversations retained. A later model choice for the same provider can then
 * see the earlier refusal, its time and the provider's own text before another
 * task fails the same way. The notes live in this process only and describe past
 * refusals, never current provider state.
 */

import { matchesSchema } from "./schema-check.ts";
import { ProviderBlockFactSchema, type ProviderBlockFact } from "./provider-block-facts.ts";

export const PROVIDER_BLOCK_NOTE_LIMIT = 8;
export const PROVIDER_BLOCK_NOTE_TEXT_LIMIT = 300;
export const PROVIDER_BLOCK_NOTE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PROVIDER_BLOCK_SECTION_BYTES = 4096;
/** The largest time that a JavaScript Date represents. */
const MAX_TIME_MS = 8.64e15;

export interface ProviderBlockNote {
	readonly provider: string;
	readonly modelId: string;
	readonly timestamp: number;
	readonly evidence: string;
	readonly conversationId: string;
}

function plain(value: string, limit: number): string {
	const points = [...value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim()];
	return points.length <= limit ? points.join("") : `${points.slice(0, limit - 1).join("")}…`;
}

function noteOf(block: ProviderBlockFact): ProviderBlockNote | undefined {
	const provider = plain(block.model.provider, 128);
	if (provider === "" || !Number.isFinite(block.timestamp) || block.timestamp <= 0 || block.timestamp > MAX_TIME_MS) return undefined;
	const markers = `${block.errorRedacted ? " [credential redacted]" : ""}${block.errorTruncated ? " [truncated]" : ""}`;
	return {
		provider,
		modelId: plain(block.model.modelId, 128),
		timestamp: block.timestamp,
		evidence: `${plain(block.error, PROVIDER_BLOCK_NOTE_TEXT_LIMIT)}${markers}`,
		conversationId: plain(block.originalResults[0]?.sessionId ?? "unknown", 256),
	};
}

function isNote(value: unknown): value is ProviderBlockNote {
	const note = value as Partial<Record<keyof ProviderBlockNote, unknown>> | null | undefined;
	return typeof note === "object" && note !== null && typeof note.provider === "string" && typeof note.modelId === "string"
		&& typeof note.timestamp === "number" && note.timestamp > 0 && note.timestamp <= MAX_TIME_MS && typeof note.evidence === "string" && typeof note.conversationId === "string";
}

/** The newest block per provider; at most `PROVIDER_BLOCK_NOTE_LIMIT` providers, the oldest leaving first. */
export class ProviderBlockNotes {
	/** Entries are checked on every read, because a process-wide store can hold values that other code wrote. */
	private readonly notes: Map<string, unknown>;
	constructor(notes: Map<string, unknown> = new Map()) {
		this.notes = notes;
	}

	/** Records the block of one delivered result's details; anything else is ignored. */
	observe(details: unknown): boolean {
		return this.observeBlock((details as { providerBlock?: unknown } | null | undefined)?.providerBlock);
	}

	/** Records one provider block fact; anything else is ignored. */
	observeBlock(block: unknown): boolean {
		if (block === undefined || !matchesSchema(ProviderBlockFactSchema, block)) return false;
		const note = noteOf(block);
		if (note === undefined) return false;
		const known = this.notes.get(note.provider);
		if (isNote(known) && known.timestamp >= note.timestamp) return false;
		this.notes.delete(note.provider);
		this.notes.set(note.provider, note);
		while (this.notes.size > PROVIDER_BLOCK_NOTE_LIMIT) this.notes.delete(this.notes.keys().next().value as string);
		return true;
	}

	/** Notes newer than the age limit, newest first. */
	current(now: number): ProviderBlockNote[] {
		return [...this.notes.values()].filter(isNote).filter((note) => now - note.timestamp <= PROVIDER_BLOCK_NOTE_AGE_MS).sort((a, b) => b.timestamp - a.timestamp);
	}

	forProvider(provider: string, now: number): ProviderBlockNote | undefined {
		return this.current(now).find((note) => note.provider === provider);
	}

	clear(): void {
		this.notes.clear();
	}
}

/** Process-global key shared by a native host's provider routing and the agent contribution it installs. */
export const PROVIDER_BLOCK_NOTES_KEY = Symbol.for("pi.agent.provider-block-notes");

/**
 * The notes of this process. The provider routing that retains a block and the
 * contribution that renders the prompt section can load as separate module
 * instances, so they share one plain map under a process-global key. A value of
 * another shape under that key is left in place and yields notes of this caller only.
 */
export function processProviderBlockNotes(): ProviderBlockNotes {
	const globals = globalThis as unknown as Record<PropertyKey, unknown>;
	if (globals[PROVIDER_BLOCK_NOTES_KEY] === undefined) globals[PROVIDER_BLOCK_NOTES_KEY] = { version: 1, notes: new Map<string, unknown>() };
	const store = globals[PROVIDER_BLOCK_NOTES_KEY] as { version?: unknown; notes?: unknown } | null;
	const shared = typeof store === "object" && store !== null && store.version === 1 && store.notes instanceof Map;
	return new ProviderBlockNotes(shared ? store.notes as Map<string, unknown> : new Map());
}

function age(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

/** One note with its receive time; the prompt section carries no clock, so its bytes change only with its notes. */
function line(note: ProviderBlockNote, now?: number): string {
	const at = `${new Date(note.timestamp).toISOString()}${now === undefined ? "" : ` (${age(now - note.timestamp)})`}`;
	return `${note.provider}/${note.modelId} at ${at}, agent ${note.conversationId}: ${note.evidence}`;
}

/** Prompt section text, or undefined when no current note exists. */
export function renderProviderBlockSection(notes: ProviderBlockNotes, now: number): string | undefined {
	const current = notes.current(now);
	if (current.length === 0) return undefined;
	const head = "Provider limits that refused agent work that this process observed. Each line is past evidence with its receive time in UTC and the provider's own text, not current provider state. One provider's limit can cover all of its models.";
	const tail = "Before you choose a model on one of these providers, weigh this evidence against the operator's route and budget preferences. Choose deliberately; nothing substitutes automatically.";
	const lines: string[] = [];
	let bytes = Buffer.byteLength(head) + Buffer.byteLength(tail) + 128;
	for (const note of current) {
		const text = `- ${line(note)}`;
		bytes += Buffer.byteLength(text) + 1;
		if (bytes > PROVIDER_BLOCK_SECTION_BYTES) break;
		lines.push(text);
	}
	const omitted = current.length - lines.length;
	return [head, ...lines, ...(omitted === 0 ? [] : [`${omitted} older ${omitted === 1 ? "note is" : "notes are"} omitted by the size bound.`]), tail].join("\n");
}

/** One receipt sentence for a model choice on a provider with a current note. */
export function providerBlockReceiptText(notes: ProviderBlockNotes, provider: string, now: number): string | undefined {
	const note = notes.forProvider(provider, now);
	if (note === undefined) return undefined;
	return `Earlier provider refusal for the selected provider, past evidence and not current state: ${line(note, now)}`;
}

/** The provider of the agent model in a spawn or configure outcome's compact status. */
export function outcomeProvider(value: unknown): string | undefined {
	const provider = (value as { status?: { agent?: { model?: { provider?: unknown } } } } | null | undefined)?.status?.agent?.model?.provider;
	return typeof provider === "string" && provider !== "" ? provider : undefined;
}

/** Tools that choose an agent model; their outcome reports the selected model. */
export const MODEL_CHOICE_TOOL_NAMES: ReadonlySet<string> = new Set(["agent_spawn", "agent_place", "agent_configure"]);

/** Adds the receipt sentence to a model-choice tool result when its selected provider has a current note. */
export function appendProviderBlockReceipt(tool: string, content: Array<{ type: string }>, value: unknown, notes: ProviderBlockNotes, now: number): void {
	if (!MODEL_CHOICE_TOOL_NAMES.has(tool)) return;
	const provider = outcomeProvider(value);
	const text = provider === undefined ? undefined : providerBlockReceiptText(notes, provider, now);
	if (text !== undefined) content.push({ type: "text", text } as { type: "text"; text: string });
}
