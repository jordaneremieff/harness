import { CATALOG_VIEW_BUDGET_BYTES, type CatalogView } from "./catalog-view.ts";

const ITEM_LIMIT = 8;
const ACTIVITY_BUDGET_BYTES = 4096;
const KEY_LIMIT = 128;
const LABEL_LIMIT = 160;
const NAME_LIMIT = 80;
const INVALID_KEY = /[\p{Cc}\p{Cf}\uD800-\uDFFF]/u;
const UNPAIRED_SURROGATES = /[\uD800-\uDFFF]/gu;
const CONTROLS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

export interface LiveActivityItem {
	readonly id: string;
	readonly conversationId: number;
	readonly label: string;
	readonly startedAt: number;
}

type DisplayItem = LiveActivityItem & { readonly agentName?: string };
interface Source {
	readonly source: string;
	readonly items: readonly DisplayItem[];
}

export interface LiveActivityReplacement extends Source {
	readonly sessionId: string;
	readonly storageId: string;
}

export type ChangesView = CatalogView & { readonly liveActivity?: readonly Source[] };

export function activityKey(value: unknown, max = KEY_LIMIT): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= max && !INVALID_KEY.test(value);
}

function displayText(value: unknown, max: number): string | undefined {
	if (typeof value !== "string") return undefined;
	// Slice before normalisation so unusable producer data cannot make this pass unbounded.
	const text = value.slice(0, max).replace(UNPAIRED_SURROGATES, "\uFFFD").replace(CONTROLS, " ").trim();
	return text || undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function item(value: unknown): LiveActivityItem | undefined {
	const row = record(value);
	if (
		!row ||
		!activityKey(row.id) ||
		typeof row.conversationId !== "number" ||
		!Number.isSafeInteger(row.conversationId) ||
		row.conversationId <= 0 ||
		typeof row.startedAt !== "number" ||
		!Number.isSafeInteger(row.startedAt) ||
		row.startedAt < 0
	)
		return undefined;
	const label = displayText(row.label, LABEL_LIMIT);
	return label === undefined
		? undefined
		: { id: row.id, conversationId: row.conversationId, label, startedAt: row.startedAt };
}

function bytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

interface Provider {
	readonly source: string;
	read(): readonly LiveActivityItem[];
}

function providerItems(
	provider: Provider,
	limit: number,
	nameFor: (conversationId: number) => string | undefined,
): DisplayItem[] | undefined {
	try {
		const supplied = provider.read();
		if (!Array.isArray(supplied) || supplied.length === 0) return undefined;
		const items: DisplayItem[] = [];
		for (let i = 0; i < Math.min(limit, supplied.length); i++) {
			const row = item(supplied[i]);
			if (row === undefined || items.some(({ id }) => id === row.id)) continue;
			const agentName = nameFor(row.conversationId);
			items.push({ ...row, ...(agentName === undefined ? {} : { agentName }) });
		}
		return items.length > 0 ? items : undefined;
	} catch {
		// An optional presentation getter must not stop publication or native work.
		return undefined;
	}
}

/** Add a feed-only field. The base view always wins its existing byte budget. */
export function withLiveActivity(view: CatalogView, providers: readonly Provider[], rootId: number): ChangesView {
	const storageId = view.storageId;
	if (storageId === undefined || view.unavailable !== undefined) return view;
	const nameFor = (id: number) => {
		const target = id === rootId ? storageId : `${storageId}:${id}`;
		return displayText(view.rows.find(({ id }) => id === target)?.name, NAME_LIMIT);
	};
	let sources: Source[] | undefined;
	let remaining = ITEM_LIMIT;
	for (const provider of providers) {
		if (remaining === 0) break;
		if (!activityKey(provider.source)) continue;
		const items = providerItems(provider, remaining, nameFor);
		if (items === undefined) continue;
		sources ??= [];
		sources.push({ source: provider.source, items });
		remaining -= items.length;
	}
	return attachLiveActivity(view, sources);
}

export function attachLiveActivity(view: CatalogView, sources: readonly Source[] | undefined): ChangesView {
	if (sources === undefined || bytes(sources) > ACTIVITY_BUDGET_BYTES) return view;
	const augmented = { ...view, liveActivity: sources };
	return bytes(augmented) <= CATALOG_VIEW_BUDGET_BYTES ? augmented : view;
}

/** The optional projection is independent of the writer-verified base view. */
export function readLiveActivity(value: unknown): readonly Source[] | undefined {
	if (!Array.isArray(value) || value.length === 0 || value.length > ITEM_LIMIT) return undefined;
	let remaining = ITEM_LIMIT;
	const sources: Source[] = [];
	for (const entry of value as readonly unknown[]) {
		const group = record(entry);
		if (
			!group ||
			!activityKey(group.source) ||
			sources.some(({ source }) => source === group.source) ||
			!Array.isArray(group.items) ||
			group.items.length === 0 ||
			group.items.length > remaining
		)
			return undefined;
		const items: DisplayItem[] = [];
		for (const input of group.items as readonly unknown[]) {
			const row = item(input);
			const name = record(input)?.agentName;
			if (row === undefined || items.some(({ id }) => id === row.id)) return undefined;
			const agentName = displayText(name, NAME_LIMIT);
			items.push(Object.freeze({ ...row, ...(agentName === undefined ? {} : { agentName }) }));
		}
		sources.push({ source: group.source, items: Object.freeze(items) });
		remaining -= items.length;
	}
	return sources;
}

interface ObservedStorage {
	readonly sessionId: string;
	readonly storageId: string;
	readonly link: object;
	readonly writerId: string;
	readonly sources: readonly Source[];
}

type Emit = (event: LiveActivityReplacement) => void;

function sameItems(left: readonly DisplayItem[], right: readonly DisplayItem[]): boolean {
	return (
		left.length === right.length &&
		left.every((item, i) => {
			const other = right[i];
			return (
				item.id === other.id &&
				item.conversationId === other.conversationId &&
				item.label === other.label &&
				item.startedAt === other.startedAt &&
				item.agentName === other.agentName
			);
		})
	);
}

/** One observed item with its source and storage-local conversation, for a reader that lists an owner's items. */
export interface ObservedActivity {
	readonly storageId: string;
	readonly conversationId: number;
	readonly source: string;
	readonly id: string;
	readonly label: string;
	readonly startedAt: number;
}

/** Sparse linked state, indexed by owner for registration and teardown without a fleet walk. */
export class PrimaryLiveActivity {
	private readonly byStorage = new Map<string, ObservedStorage>();
	private readonly byOwner = new Map<string, Set<ObservedStorage>>();

	private readonly emitter: (sessionId: string) => Emit | undefined;
	private readonly changed?: () => void;

	/** `changed` hears every change of the held items, after the emitter; it must not throw into the feed. */
	constructor(emitter: (sessionId: string) => Emit | undefined, changed?: () => void) {
		this.emitter = emitter;
		this.changed = changed;
	}

	/** Every item the links of one owner hold, oldest start first; empty when none is observed. */
	items(sessionId: string): readonly ObservedActivity[] {
		const items: ObservedActivity[] = [];
		for (const { storageId, sources } of this.byOwner.get(sessionId) ?? [])
			for (const { source, items: group } of sources)
				for (const { id, conversationId, label, startedAt } of group)
					items.push({ storageId, conversationId, source, id, label, startedAt });
		return items.sort((left, right) => left.startedAt - right.startedAt);
	}

	private notify(): void {
		try {
			this.changed?.();
		} catch {
			/* A reader's refresh cannot stop a registration or a live feed. */
		}
	}

	replace(storageId: string, link: object, sessionId: string, writerId: string, view?: ChangesView): void {
		let before = this.byStorage.get(storageId);
		const sources = view?.liveActivity;
		if (sources === undefined) {
			this.withdraw(storageId, link);
			return;
		}
		if (before !== undefined && (before.writerId !== writerId || before.sessionId !== sessionId)) {
			this.withdraw(storageId, before.link);
			before = undefined;
		}
		if (
			before?.link === link &&
			before.sources.length === sources.length &&
			before.sources.every(({ source, items }, i) => source === sources[i].source && sameItems(items, sources[i].items))
		)
			return;
		this.remove(before);
		const next = { storageId, link, sessionId, writerId, sources };
		this.remember(next);
		const emit = this.emitter(sessionId);
		if (emit !== undefined) this.sendChanges(emit, next, before?.sources ?? []);
		this.notify();
	}

	withdraw(storageId: string, link: object): void {
		const before = this.byStorage.get(storageId);
		if (before === undefined || before.link !== link) return;
		this.remove(before);
		const emit = this.emitter(before.sessionId);
		if (emit !== undefined) for (const { source } of before.sources) this.send(emit, before, source, []);
		this.notify();
	}

	forOwner(sessionId: string, emit: Emit | undefined, includeItems: boolean): void {
		const owned = this.byOwner.get(sessionId);
		if (owned === undefined || emit === undefined) return;
		for (const storage of owned)
			for (const { source, items } of storage.sources) this.send(emit, storage, source, includeItems ? items : []);
	}

	forgetOwner(sessionId: string): void {
		const owned = this.byOwner.get(sessionId);
		if (owned === undefined) return;
		for (const storage of owned) this.remove(storage);
		this.notify();
	}

	clear(): void {
		const held = this.byStorage.size > 0;
		this.byStorage.clear();
		this.byOwner.clear();
		if (held) this.notify();
	}

	private sendChanges(emit: Emit, next: ObservedStorage, before: readonly Source[]): void {
		for (const { source } of before) {
			if (!next.sources.some((group) => group.source === source)) this.send(emit, next, source, []);
		}
		for (const { source, items } of next.sources) {
			const previous = before.find((group) => group.source === source);
			if (previous === undefined || !sameItems(previous.items, items)) this.send(emit, next, source, items);
		}
	}

	private remember(next: ObservedStorage): void {
		this.byStorage.set(next.storageId, next);
		let owned = this.byOwner.get(next.sessionId);
		if (owned === undefined) {
			owned = new Set();
			this.byOwner.set(next.sessionId, owned);
		}
		owned.add(next);
	}

	private remove(storage: ObservedStorage | undefined): void {
		if (storage === undefined) return;
		this.byStorage.delete(storage.storageId);
		const owned = this.byOwner.get(storage.sessionId);
		owned?.delete(storage);
		if (!owned?.size) this.byOwner.delete(storage.sessionId);
	}

	private send(
		emit: Emit,
		{ sessionId, storageId }: ObservedStorage,
		source: string,
		items: readonly DisplayItem[],
	): void {
		try {
			emit({ sessionId, source, storageId, items });
		} catch {
			/* A presentation listener cannot stop a registration or a live feed. */
		}
	}
}
