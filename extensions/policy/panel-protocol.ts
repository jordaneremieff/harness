/**
 * Request and answer shapes of the policy panel's native route. The attached terminal transports
 * them as opaque JSON through the `policy` contribution command (docs/conventions/operator-panels.md).
 * Map-backed registry values cross the wire as entry arrays and are rebuilt by the reader.
 */

import type { NamedData } from "./data.ts";
import type { PendingProposal, RuleSnapshot, RuleStoreHealth } from "./local-rules.ts";
import type { ActivityReadResult, RuleFireSummary } from "./panel.ts";
import type { RuleMatchContext, RuleRecord } from "./rule.ts";

export type PolicyPanelRequest =
	| { op: "load" }
	| { op: "refresh" }
	| { op: "inspect"; view: "state" | "explain" | "data"; id?: string }
	| { op: "approve"; proposalId: string; effect?: "steer" | "block"; revision?: string }
	| { op: "reject"; proposalId: string; revision?: string }
	| { op: "lifecycle"; verb: "disable" | "enable" | "retire"; id: string; reason: string; expectedIdentity?: string }
	| { op: "effect"; id: string; effect: "steer" | "block"; reason: string; expectedIdentity?: string }
	| { op: "reset-revision"; id: string }
	| { op: "reset"; id: string; reason: string; revision: string };

export interface SerializedSnapshot {
	records: Array<[string, RuleRecord]>;
	pending: PendingProposal[];
	data: Array<[string, NamedData]>;
	health: RuleStoreHealth;
}

export interface SerializedFireSummary {
	fires: Array<[string, number]>;
	firesByModel: Array<[string, Array<[string | null, number]>]>;
	partial: boolean;
}

export type PolicyPanelAnswer =
	| { op: "load"; snapshot: SerializedSnapshot; fireSummary: SerializedFireSummary; activity: ActivityReadResult; scope: RuleMatchContext }
	| { op: "refresh"; snapshot: SerializedSnapshot }
	| { op: "inspect"; text: string; snapshot: SerializedSnapshot }
	| { op: "approve" | "reject" | "lifecycle" | "effect" | "reset"; outcome: string; snapshot: SerializedSnapshot }
	| { op: "reset-revision"; revision: string };

const MAX_REASON = 1000;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const reason = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_REASON;
const optionalRevision = (value: unknown): value is string | undefined => value === undefined || (typeof value === "string" && /^[a-f0-9]{12}$/u.test(value));
const effect = (value: unknown): value is "steer" | "block" => value === "steer" || value === "block";

const readers: Record<string, (value: Record<string, unknown>) => PolicyPanelRequest> = {
	load: () => ({ op: "load" }),
	refresh: () => ({ op: "refresh" }),
	inspect(value) {
		if (value.view !== "state" && value.view !== "explain" && value.view !== "data") throw new Error("policy inspect needs the view state, explain, or data");
		if (value.view === "explain" && !identity(value.id)) throw new Error("policy explain needs a rule or call id");
		return { op: "inspect", view: value.view, ...(value.id === undefined ? {} : { id: String(value.id) }) };
	},
	approve(value) {
		if (!identity(value.proposalId) || (value.effect !== undefined && !effect(value.effect)) || !optionalRevision(value.revision)) throw new Error("policy approve needs a proposal id, an optional steer or block effect, and an optional revision");
		return { op: "approve", proposalId: value.proposalId, ...(value.effect === undefined ? {} : { effect: value.effect }), ...(value.revision === undefined ? {} : { revision: value.revision }) };
	},
	reject(value) {
		if (!identity(value.proposalId) || !optionalRevision(value.revision)) throw new Error("policy reject needs a proposal id and an optional revision");
		return { op: "reject", proposalId: value.proposalId, ...(value.revision === undefined ? {} : { revision: value.revision }) };
	},
	lifecycle(value) {
		if (value.verb !== "disable" && value.verb !== "enable" && value.verb !== "retire") throw new Error("policy lifecycle needs the verb disable, enable, or retire");
		if (!identity(value.id) || !reason(value.reason) || !optionalRevision(value.expectedIdentity)) throw new Error(`policy ${value.verb} needs a rule id, a bounded reason, and an optional target identity`);
		return { op: "lifecycle", verb: value.verb, id: value.id, reason: value.reason, ...(value.expectedIdentity === undefined ? {} : { expectedIdentity: value.expectedIdentity }) };
	},
	effect(value) {
		if (!identity(value.id) || !effect(value.effect) || !reason(value.reason) || !optionalRevision(value.expectedIdentity)) throw new Error("policy effect needs a rule id, steer or block, a bounded reason, and an optional target identity");
		return { op: "effect", id: value.id, effect: value.effect, reason: value.reason, ...(value.expectedIdentity === undefined ? {} : { expectedIdentity: value.expectedIdentity }) };
	},
	"reset-revision"(value) {
		if (!identity(value.id) && value.id !== "--all") throw new Error("policy reset-revision needs a rule id or --all");
		return { op: "reset-revision", id: String(value.id) };
	},
	reset(value) {
		if ((!identity(value.id) && value.id !== "--all") || !reason(value.reason) || !optionalRevision(value.revision) || value.revision === undefined) throw new Error("policy reset needs a rule id or --all, a bounded reason, and the inspected revision");
		return { op: "reset", id: String(value.id), reason: value.reason, revision: value.revision };
	},
};

/** Reject anything outside the finite request union before the native runtime runs. */
export function readPanelRequest(value: unknown): PolicyPanelRequest {
	if (!record(value) || typeof value.op !== "string") throw new Error("policy panel request must name an op");
	const reader = Object.hasOwn(readers, value.op) ? readers[value.op] : undefined;
	if (!reader) throw new Error(`policy panel request op ${value.op} is not supported`);
	return reader(value);
}

export function serializeSnapshot(snapshot: RuleSnapshot): SerializedSnapshot {
	return { records: [...snapshot.records.entries()], pending: snapshot.pending, data: [...snapshot.data.entries()], health: snapshot.health };
}

export function deserializeSnapshot(value: SerializedSnapshot): RuleSnapshot {
	return { records: new Map(value.records), pending: value.pending, data: new Map(value.data), health: value.health };
}

export function serializeFireSummary(summary: RuleFireSummary): SerializedFireSummary {
	return { fires: [...summary.fires.entries()], firesByModel: [...summary.firesByModel.entries()].map(([id, models]) => [id, [...models.entries()]]), partial: summary.partial };
}

export function deserializeFireSummary(value: SerializedFireSummary): RuleFireSummary {
	return { fires: new Map(value.fires), firesByModel: new Map(value.firesByModel.map(([id, models]) => [id, new Map(models)])), partial: value.partial };
}

function serializedSnapshot(value: unknown): value is SerializedSnapshot {
	return record(value) && Array.isArray(value.records) && Array.isArray(value.pending) && Array.isArray(value.data) && record(value.health) && typeof value.health.status === "string";
}

function serializedFires(value: unknown): value is SerializedFireSummary {
	return record(value) && Array.isArray(value.fires) && Array.isArray(value.firesByModel) && typeof value.partial === "boolean";
}

/** A malformed answer is an error the panel shows, never an empty registry. */
export function readPanelAnswer(request: PolicyPanelRequest, value: unknown): PolicyPanelAnswer {
	if (!record(value) || value.op !== request.op) throw new Error("the host answered a different policy request");
	if (request.op === "reset-revision") {
		if (typeof value.revision !== "string") throw new Error("the host answered an unreadable reset revision");
		return { op: "reset-revision", revision: value.revision };
	}
	if (!serializedSnapshot(value.snapshot)) throw new Error("the host answered an unreadable policy snapshot");
	if (request.op === "load") {
		if (!serializedFires(value.fireSummary) || !record(value.activity) || !Array.isArray(value.activity.records) || !record(value.scope) || typeof value.scope.cwd !== "string") throw new Error("the host answered an unreadable policy view");
		return { op: "load", snapshot: value.snapshot, fireSummary: value.fireSummary, activity: value.activity as unknown as ActivityReadResult, scope: value.scope as unknown as RuleMatchContext };
	}
	if (request.op === "refresh") return { op: "refresh", snapshot: value.snapshot };
	if (request.op === "inspect") {
		if (typeof value.text !== "string") throw new Error("the host answered an unreadable inspection");
		return { op: "inspect", text: value.text, snapshot: value.snapshot };
	}
	if (typeof value.outcome !== "string") throw new Error("the host answered an unreadable policy outcome");
	return { op: request.op, outcome: value.outcome, snapshot: value.snapshot };
}
