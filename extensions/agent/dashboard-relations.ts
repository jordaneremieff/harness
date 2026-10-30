import type { AgentConversationSummary } from "./dashboard-types.ts";
import type { CollaborationPage, CollaborationSummary } from "./collaboration.ts";
import { threadDiscovery, threadPage, type Collaborate } from "./collaboration-view.ts";
import { canonicalIdentity } from "./identity.ts";
import type { ConversationSummary } from "./durable-observation.ts";
import type { ConversationId } from "@earendil-works/pi-durable";

export function relationIdentity(id: string): string {
	const [storage, suffix] = id.split(":");
	const number = Number(suffix);
	return suffix !== undefined && Number.isSafeInteger(number) && number > 0
		? canonicalIdentity(storage, number as ConversationId) : id;
}
export type ReadRelationLineage = (id: string) => Promise<unknown>;
function lineageSummary(value: unknown, id: string): ConversationSummary | undefined {
	if (!value || typeof value !== "object") return undefined;
	const summary = (value as { conversation?: ConversationSummary }).conversation;
	return summary && typeof summary.identity === "string" && relationIdentity(summary.identity) === relationIdentity(id)
		&& Number.isSafeInteger(summary.conversationId) && summary.conversationId > 0
		&& canonicalIdentity(id.split(":")[0], summary.conversationId) === relationIdentity(id)
		&& (summary.owner === undefined || typeof summary.owner === "string")
		&& (summary.forkSource === undefined || Number.isSafeInteger(summary.forkSource.conversationId) && summary.forkSource.conversationId > 0)
		? summary : undefined;
}

function creationChildren(rows: readonly AgentConversationSummary[], seeds: ReadonlySet<string>, lineage: readonly ConversationSummary[]): string[] {
	const children = rows.filter((row) => relationIdentity(row.id) === row.storageId && row.creatingOwnerId && seeds.has(relationIdentity(row.creatingOwnerId)) && !seeds.has(relationIdentity(row.id))).map((row) => relationIdentity(row.id));
	for (const summary of lineage) {
		const parent = summary.forkSource ? canonicalIdentity(summary.identity.split(":")[0], summary.forkSource.conversationId) : undefined;
		if ((summary.owner && seeds.has(relationIdentity(summary.owner)) || parent && seeds.has(parent)) && !seeds.has(relationIdentity(summary.identity))) children.push(relationIdentity(summary.identity));
	}
	return children;
}
function relationSeedEvidence(rows: readonly AgentConversationSummary[], caller: string, targets: readonly string[], lineage: readonly ConversationSummary[]): { identities: Set<string>; partial: boolean } {
	const seeds = new Set([caller, ...targets].map(relationIdentity));
	const awaitingRoots = new Set(seeds);
	for (const row of rows) if (awaitingRoots.has(relationIdentity(row.id)))
		for (const item of row.awaiting?.results ?? []) seeds.add(relationIdentity(item.result.sessionId));
	// Creation lineage is bounded independently of shared-thread membership.
	for (let depth = 0; depth < 8; depth++) {
		const children = creationChildren(rows, seeds, lineage);
		if (!children.length) break;
		for (const id of children) seeds.add(relationIdentity(id));
	}
	const partial = creationChildren(rows, seeds, lineage).length > 0;
	// An exact caller ancestor is related without making its other children seeds.
	const own = lineage.find((summary) => relationIdentity(summary.identity) === relationIdentity(caller));
	if (own?.owner) seeds.add(relationIdentity(own.owner));
	if (own?.forkSource) seeds.add(canonicalIdentity(own.identity.split(":")[0], own.forkSource.conversationId));
	return { identities: seeds, partial };
}
/** Exact identities only. Directory, repository and storage proximity do not establish shared work. */
export function relationSeeds(rows: readonly AgentConversationSummary[], caller: string, targets: readonly string[] = [], lineage: readonly ConversationSummary[] = []): Set<string> {
	return relationSeedEvidence(rows, caller, targets, lineage).identities;
}
export interface RelatedWork {
	identities: Set<string>;
	threads: CollaborationSummary[];
	partial: boolean;
	pending: boolean;
}
export function relatedWork(seeds: ReadonlySet<string>, pages: readonly CollaborationPage[]): RelatedWork {
	const identities = new Set(seeds);
	const threads: CollaborationSummary[] = [];
	for (const page of pages) {
		const thread = page.thread;
		if (!thread.members.some((member) => seeds.has(relationIdentity(member.identity)))) continue;
		for (const member of thread.members) identities.add(relationIdentity(member.identity));
		threads.push({ id: thread.id, title: thread.title, purpose: thread.purpose.slice(0, 160), updatedAt: thread.updatedAt, closed: thread.closed, members: thread.members.length });
	}
	return { identities, threads, partial: false, pending: false };
}

/** UI-local membership reads reuse public collaboration operations and unchanged frame revisions. */
export class DashboardRelations {
	private pages: CollaborationPage[] = [];
	private cache = new Map<string, { updatedAt: number; page: CollaborationPage }>();
	private partial = false;
	private pending = false;
	private again = false;
	private disposed = false;
	private revision = 0;
	private seeds = new Set<string>();
	private scopes: string[] = [];
	private lineagePartial = false;
	private rows: readonly AgentConversationSummary[] = [];
	private caller = "";
	private targets: readonly string[] = [];
	private lineage: ConversationSummary[] = [];
	private lineageCache = new Map<string, { modifiedAt: number; summary: ConversationSummary }>();
	private readonly readLineage: ReadRelationLineage | undefined;
	private readonly collaborate: Collaborate | undefined;
	private readonly changed: () => void;
	constructor(collaborate: Collaborate | undefined, changed: () => void, readLineage?: ReadRelationLineage) {
		this.readLineage = readLineage;
		this.collaborate = collaborate;
		this.changed = changed;
	}
	set(rows: readonly AgentConversationSummary[], caller: string, targets: readonly string[] = []): void {
		this.rows = rows;
		this.caller = caller;
		this.targets = targets;
		this.updateSeeds();
	}
	private updateSeeds(): void {
		const evidence = relationSeedEvidence(this.rows, this.caller, this.targets, this.lineage);
		this.seeds = evidence.identities;
		this.lineagePartial = evidence.partial;
		this.scopes = [...new Set([...(this.rows.some((row) => row.storageId === this.caller.split(":")[0]) ? [this.caller.split(":")[0]] : []), ...this.rows.filter((row) => this.seeds.has(relationIdentity(row.id))).map((row) => row.storageId)])];
	}
	view(): RelatedWork {
		return { ...relatedWork(this.seeds, this.pages), partial: this.partial || this.lineagePartial || !this.collaborate, pending: this.pending };
	}
	/** Catalogue notices invalidate evidence even when the publisher's clock repeats. */
	invalidate(): void {
		this.revision++;
		this.cache.clear();
		this.lineageCache.clear();
		if (this.pending) this.again = true;
	}
	private async readLineages(revision: number): Promise<boolean> {
		let partial = false;
		const candidates = this.rows.filter((row) => relationIdentity(row.id) !== row.storageId && this.scopes.includes(row.storageId));
		partial ||= candidates.length > 20 || candidates.length > 0 && !this.readLineage;
		const lineage: ConversationSummary[] = [];
		const lineageCache = new Map<string, { modifiedAt: number; summary: ConversationSummary }>();
		for (const row of candidates.slice(0, 20)) {
			if (this.disposed || !this.readLineage) break;
			try {
				const cached = this.lineageCache.get(row.id);
				const summary = cached?.modifiedAt === row.modifiedAt ? cached.summary : lineageSummary(await this.readLineage(row.id), row.id);
				if (!summary) throw new Error("Invalid conversation summary");
				lineage.push(summary);
				lineageCache.set(row.id, { modifiedAt: row.modifiedAt, summary });
			} catch { partial = true; }
		}
		if (this.disposed || revision !== this.revision) return partial;
		this.lineage = lineage;
		this.lineageCache = lineageCache;
		this.updateSeeds();
		return partial;
	}
	private async readSummaries(collaborate: Collaborate): Promise<{ summaries: Map<string, CollaborationSummary>; partial: boolean }> {
		let partial = this.scopes.length > 4;
		const summaries = new Map<string, CollaborationSummary>();
		const requests = [...this.scopes.slice(0, 4).map((sessionId) => ({ action: "list", sessionId, limit: 20 })), { action: "list", limit: 20 }];
		for (const input of requests) {
			if (this.disposed) break;
			try {
				const result = await collaborate(input);
				if (!threadDiscovery(result)) throw new Error("Invalid thread discovery");
				partial ||= !result.coverage.complete || result.nextCursor !== null;
				for (const item of result.items) summaries.set(item.id, item);
			} catch { partial = true; }
		}
		return { summaries, partial };
	}
	private async readPages(summaries: ReadonlyMap<string, CollaborationSummary>, collaborate: Collaborate, revision: number): Promise<boolean> {
		let partial = summaries.size > 20;
		const next = new Map<string, { updatedAt: number; page: CollaborationPage }>();
		for (const item of [...summaries.values()].slice(0, 20)) {
			if (this.disposed) break;
			try {
				const cached = this.cache.get(item.id);
				const page = cached?.updatedAt === item.updatedAt ? cached.page : await collaborate({ action: "read", threadId: item.id, limit: 1 });
				if (!threadPage(page) || page.thread.id !== item.id) throw new Error("Invalid thread page");
				next.set(item.id, { updatedAt: item.updatedAt, page });
			} catch { partial = true; }
		}
		if (this.disposed || revision !== this.revision) return partial;
		this.cache = next;
		this.pages = [...next.values()].map((item) => item.page);
		return partial;
	}
	async refresh(): Promise<void> {
		if (this.disposed || !this.collaborate) return;
		if (this.pending) { this.again = true; return; }
		this.pending = true;
		this.changed();
		const revision = this.revision;
		const lineagePartial = await this.readLineages(revision);
		if (this.disposed) return;
		const { summaries, partial } = await this.readSummaries(this.collaborate);
		const pagePartial = await this.readPages(summaries, this.collaborate, revision);
		if (this.disposed) return;
		if (revision === this.revision) this.partial = lineagePartial || partial || pagePartial;
		this.pending = false;
		this.changed();
		if (this.again) { this.again = false; void this.refresh(); }
	}
	dispose(): void { this.disposed = true; this.cache.clear(); this.lineageCache.clear(); this.pages = []; }
}
