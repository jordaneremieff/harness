/**
 * Primary statusline for native Durable agents. Costs come from retained usage;
 * the notice projection replaces each storage's previous contribution.
 */
import type { AgentConversationSummary } from "./dashboard-types.ts";
import { sentWorkIdentity } from "./session-work.ts";

const MAX_OWNER_DEPTH = 64;
const MAX_OWNER_READS = 1024;

/** A terminal failure alone is history, not an outstanding intervention. */
function actionableAttention(row: AgentConversationSummary): boolean {
	if (row.attention === "provider-blocked" || row.attention === "task-blocked") return true;
	if (row.owner === "here" && row.health?.lastError) return true;
	return (
		(row.state === "unavailable" || row.owner === "unavailable") &&
		((row.unplaced ?? 0) > 0 || (row.openWorkCount ?? 0) > 0)
	);
}

/** The footer figures of one primary session and the agents in its scope that need intervention. */
export interface SessionFooter {
	readonly text: string;
	/**
	 * Every scoped agent that needs intervention, and every sent-work target that such an agent works under through
	 * its creating owners, in the form of `sentWorkIdentity`. Work sent to one of these waits in vain until someone
	 * intervenes.
	 */
	readonly stuck: readonly string[];
}

/** Creation lineage owns cost; sent-work descendants count while working or in need of intervention. */
export function sessionFigures(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
	sentWork: ReadonlySet<string> = new Set(),
	recoveryBlocked: (storageId: string) => boolean = () => false,
): string {
	return sessionFooter(rows, ownerId, readOwner, sentWork, recoveryBlocked).text;
}

/** The figures of `sessionFigures`, with the scoped agents that need intervention. */
export function sessionFooter(
	rows: readonly AgentConversationSummary[],
	ownerId: string,
	readOwner: (storageId: string) => string | undefined,
	sentWork: ReadonlySet<string> = new Set(),
	recoveryBlocked: (storageId: string) => boolean = () => false,
): SessionFooter {
	const owners = new Map<string, string | undefined>();
	const ownerOf = (storageId: string): string | undefined => {
		if (owners.has(storageId)) return owners.get(storageId);
		if (owners.size === MAX_OWNER_READS) return undefined;
		const owner = readOwner(storageId);
		owners.set(storageId, owner);
		return owner;
	};
	const lineages = new Map<string, readonly string[]>();
	const contribution = emptyContribution();
	for (const row of rows) {
		let lineage = lineages.get(row.storageId);
		if (!lineage) {
			lineage = footerLineage(row.storageId, (id) => (id === ownerId ? undefined : ownerOf(id)));
			lineages.set(row.storageId, lineage);
		}
		addRow(contribution, row, lineage, ownerId, sentWork, recoveryBlocked(row.storageId));
	}
	return { text: formatFooter(contribution), stuck: [...contribution.stuck].sort() };
}

function footerLineage(storageId: string, readOwner: (storageId: string) => string | undefined): string[] {
	const owners: string[] = [];
	const visited = new Set<string>();
	for (let depth = 0; depth < MAX_OWNER_DEPTH && !visited.has(storageId); depth++) {
		visited.add(storageId);
		const owner = readOwner(storageId);
		if (!owner) break;
		owners.push(owner);
		storageId = owner.split(":", 1)[0];
	}
	return owners;
}

interface FooterCounts {
	working: number;
	total: number;
	cost: number;
}

interface Contribution extends FooterCounts {
	stuck: Set<string>;
}

function emptyContribution(): Contribution {
	return { working: 0, total: 0, cost: 0, stuck: new Set() };
}

function addRow(
	counts: Contribution,
	row: AgentConversationSummary,
	lineage: readonly string[],
	ownerId: string,
	sent: ReadonlySet<string>,
	blocked: boolean,
): void {
	const created = lineage.includes(ownerId);
	const working = row.state === "working";
	const attention = actionableAttention(row) || (blocked && (row.id === row.storageId || sent.has(row.id)));
	const sentAncestor = lineage.find((owner) => sent.has(owner));
	if (!created && !sent.has(row.id) && !((working || attention) && (sent.has(row.storageId) || sentAncestor))) return;
	counts.total++;
	counts.working += Number(working);
	if (created) counts.cost += rowCost(row);
	if (!attention) return;
	for (const identity of [row.id, row.storageId, sentAncestor])
		if (identity !== undefined) counts.stuck.add(sentWorkIdentity(identity) ?? identity);
}

export interface FooterStorage {
	readonly rows: readonly AgentConversationSummary[];
	readonly incomplete: boolean;
	readonly blocked: boolean;
}

interface FooterGroup {
	readonly projection: FooterStorage;
	readonly lineage: readonly string[];
	readonly dependencies: ReadonlySet<string>;
	readonly roots: ReadonlySet<string>;
	readonly contributions: Map<string, Contribution>;
}

interface FooterOwner extends FooterCounts {
	readonly sent: Set<string>;
	readonly stuck: Map<string, number>;
	readonly groups: Set<string>;
}

function link(index: Map<string, Set<string>>, key: string, id: string): void {
	const values = index.get(key);
	if (values) values.add(id);
	else index.set(key, new Set([id]));
}

function unlink(index: Map<string, Set<string>>, key: string, id: string): void {
	const values = index.get(key);
	if (values?.delete(id) && values.size === 0) index.delete(key);
}

/** One storage projection and reverse links for its creating lineage and sent-work scopes. */
export class FooterProjection {
	private readonly groups = new Map<string, FooterGroup>();
	private readonly dependencies = new Map<string, Set<string>>();
	private readonly ancestorOwners = new Map<string, string | undefined>();
	private readonly roots = new Map<string, Set<string>>();
	private readonly owners = new Map<string, FooterOwner>();
	private readonly senders = new Map<string, Set<string>>();
	private incomplete = 0;

	get complete(): boolean {
		return this.incomplete === 0;
	}

	rows(): AgentConversationSummary[] {
		return [...this.groups.values()].flatMap(({ projection }) => projection.rows);
	}

	figures(ownerId: string): SessionFooter {
		const owner = this.owners.get(ownerId);
		return owner
			? { text: formatFooter(owner, !this.complete), stuck: [...owner.stuck.keys()].sort() }
			: { text: "", stuck: [] };
	}

	retainOwners(current: ReadonlyMap<string, unknown>): void {
		for (const ownerId of this.owners.keys()) if (!current.has(ownerId)) this.removeOwner(ownerId);
	}

	private removeOwner(ownerId: string): void {
		const owner = this.owners.get(ownerId);
		if (!owner) return;
		for (const target of owner.sent) unlink(this.senders, target, ownerId);
		for (const id of owner.groups) this.groups.get(id)?.contributions.delete(ownerId);
		this.owners.delete(ownerId);
	}

	/** The primary's sent-work markers are append-only for this registration. */
	updateOwner(ownerId: string, sentWork?: ReadonlySet<string>, replace = false): void {
		if (replace) this.removeOwner(ownerId);
		const previous = this.owners.get(ownerId);
		const owner = previous ?? { working: 0, total: 0, cost: 0, sent: new Set(), stuck: new Map(), groups: new Set() };
		if (!previous) this.owners.set(ownerId, owner);
		const affected = new Set(previous ? [] : this.roots.get(ownerId));
		this.addSentTargets(ownerId, owner, sentWork, affected);
		for (const id of affected) {
			const group = this.groups.get(id);
			if (!group) continue;
			this.removeContribution(id, group, ownerId);
			this.addContribution(id, group, ownerId, owner);
		}
	}

	private addSentTargets(
		ownerId: string,
		owner: FooterOwner,
		sentWork: ReadonlySet<string> | undefined,
		affected: Set<string>,
	): void {
		if (!sentWork || sentWork.size === owner.sent.size) return;
		for (const target of sentWork) {
			if (owner.sent.has(target)) continue;
			owner.sent.add(target);
			link(this.senders, target, ownerId);
			for (const id of this.roots.get(target) ?? []) affected.add(id);
		}
	}

	apply(
		updates: ReadonlyMap<string, FooterStorage | undefined>,
		readOwner: (storageId: string) => string | undefined,
	): ReadonlySet<string> {
		const affected = new Map(updates);
		for (const id of updates.keys()) {
			const dependents = this.dependencies.get(id);
			if (!dependents || this.ancestorOwners.get(id) === readOwner(id)) continue;
			for (const dependent of dependents) {
				if (!affected.has(dependent)) affected.set(dependent, this.groups.get(dependent)?.projection);
			}
		}
		const owners = new Set<string>();
		for (const [id, projection] of affected) {
			this.removeGroup(id, owners);
			if (projection) this.addGroup(id, projection, readOwner, owners);
		}
		return owners;
	}

	private removeGroup(id: string, changed: Set<string>): void {
		const group = this.groups.get(id);
		if (!group) return;
		this.incomplete -= Number(group.projection.incomplete);
		for (const key of group.dependencies) {
			unlink(this.dependencies, key, id);
			if (!this.dependencies.has(key)) this.ancestorOwners.delete(key);
		}
		for (const key of group.roots) unlink(this.roots, key, id);
		for (const ownerId of group.contributions.keys()) {
			this.removeContribution(id, group, ownerId);
			changed.add(ownerId);
		}
		this.groups.delete(id);
	}

	private addGroup(
		id: string,
		projection: FooterStorage,
		readOwner: (storageId: string) => string | undefined,
		changed: Set<string>,
	): void {
		const dependencies = new Set<string>();
		const lineage = footerLineage(id, (key) => {
			const owner = readOwner(key);
			if (key !== id) {
				dependencies.add(key);
				this.ancestorOwners.set(key, owner);
			}
			return owner;
		});
		const roots = new Set([id, ...lineage, ...projection.rows.map((row) => row.id)]);
		const group = { projection, lineage, dependencies, roots, contributions: new Map<string, Contribution>() };
		this.groups.set(id, group);
		this.incomplete += Number(projection.incomplete);
		for (const key of dependencies) link(this.dependencies, key, id);
		const candidates = new Set(lineage);
		for (const key of roots) {
			link(this.roots, key, id);
			for (const sender of this.senders.get(key) ?? []) candidates.add(sender);
		}
		for (const ownerId of candidates) {
			const owner = this.owners.get(ownerId);
			if (owner && this.addContribution(id, group, ownerId, owner)) changed.add(ownerId);
		}
	}

	private addContribution(id: string, group: FooterGroup, ownerId: string, owner: FooterOwner): boolean {
		const counts = emptyContribution();
		for (const row of group.projection.rows)
			addRow(counts, row, group.lineage, ownerId, owner.sent, group.projection.blocked);
		if (counts.total === 0) return false;
		group.contributions.set(ownerId, counts);
		owner.groups.add(id);
		owner.working += counts.working;
		owner.total += counts.total;
		owner.cost += counts.cost;
		for (const key of counts.stuck) owner.stuck.set(key, (owner.stuck.get(key) ?? 0) + 1);
		return true;
	}

	private removeContribution(id: string, group: FooterGroup, ownerId: string): void {
		const counts = group.contributions.get(ownerId);
		const owner = this.owners.get(ownerId);
		if (!counts || !owner) return;
		group.contributions.delete(ownerId);
		owner.groups.delete(id);
		owner.working -= counts.working;
		owner.total -= counts.total;
		owner.cost = owner.total ? owner.cost - counts.cost : 0;
		for (const key of counts.stuck) {
			const count = owner.stuck.get(key) ?? 0;
			if (count > 1) owner.stuck.set(key, count - 1);
			else owner.stuck.delete(key);
		}
	}
}

function rowCost(row: AgentConversationSummary): number {
	return Number.isFinite(row.cost) && row.cost >= 0 ? row.cost : 0;
}

function formatFooter({ working, total, cost }: FooterCounts, incomplete = false): string {
	if (total === 0) return "";
	const estimate = cost >= 0.005 ? ` · ~$${cost.toFixed(2)}` : "";
	return `agents: ${working}/${total}${incomplete ? "+" : ""}${estimate}`;
}

/** Working and scoped agents with the recorded-pricing estimate; costs below half a cent are hidden. */
export function formatDurableFooter(
	rows: readonly AgentConversationSummary[],
	costRows: readonly AgentConversationSummary[] = rows,
): string {
	return formatFooter({
		working: rows.filter((row) => row.state === "working").length,
		total: rows.length,
		cost: costRows.reduce((sum, row) => sum + rowCost(row), 0),
	});
}
