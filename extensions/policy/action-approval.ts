/** Ephemeral, conversation-bound permission for one complete policy candidate. */
import { createHash, randomUUID } from "node:crypto";
import { cloneJson } from "./data.ts";
import type { RuleSnapshot } from "./local-rules.ts";
import type { InputPlan, ProgramEvaluation } from "./program.ts";
import type { RuleMatchContext } from "./rule.ts";

const ACTION_BYTES = 16 * 1024;
const ACTION_CAPACITY = 64;

function canonical(value: unknown): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
		.join(",")}}`;
}
function digest(value: unknown): string {
	return createHash("sha256").update(canonical(value)).digest("hex");
}

function strictProperty(entry: object, key: PropertyKey): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(entry, key);
	if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor))
		throw new Error("Approval requires complete plain JSON arguments");
	return descriptor.value;
}
function checkStrictValue(entry: unknown): void {
	if (typeof entry === "number" && Object.is(entry, -0)) throw new Error("Negative zero is not an exact JSON action");
	if (entry === null || typeof entry !== "object") return;
	for (const key of Reflect.ownKeys(entry)) {
		if (Array.isArray(entry) && key === "length") continue;
		checkStrictValue(strictProperty(entry, key));
	}
}
/** Omitted, accessor, symbolic, and non-JSON fields must not disappear from an approval. */
function strictInput(value: unknown): Record<string, unknown> {
	const copied = cloneJson(value);
	checkStrictValue(value);
	if (copied === null || typeof copied !== "object" || Array.isArray(copied))
		throw new Error("Approval requires an argument object");
	if (Buffer.byteLength(canonical(copied)) > ACTION_BYTES)
		throw new Error("Complete action exceeds the approval byte bound");
	return copied as Record<string, unknown>;
}

export interface ActionBinding {
	session: string;
	scope: RuleMatchContext;
	authority: string;
	mode: string;
}
export interface ActionControl {
	operation: "actions" | "action-inspect" | "action-approve" | "action-reject";
	actionId?: string;
	revision?: string;
	authorization?: string;
}
interface PendingAction {
	actionId: string;
	revision: string;
	fingerprint: string;
	binding: ActionBinding;
	tool: string;
	arguments: Record<string, unknown>;
	rules: Array<{ id: string; revision: string }>;
	state: "pending" | "approved";
}

/** Bind every current control/data revision and every public tool schema, not a retry call ID. */
export function actionAuthority(
	snapshot: RuleSnapshot,
	schemas: readonly { name: string; parameters?: unknown }[],
): string {
	return digest({
		health: snapshot.health.status,
		rules: [...snapshot.records.values()].sort((a, b) => a.id.localeCompare(b.id)),
		data: [...snapshot.data.values()].sort((a, b) => a.name.localeCompare(b.name)),
		schemas: schemas
			.map(({ name, parameters }) => ({ name, parameters: parameters ?? null }))
			.sort((a, b) => a.name.localeCompare(b.name)),
	});
}

export function sameActionInput(left: unknown, right: unknown): boolean {
	try {
		return canonical(strictInput(left)) === canonical(strictInput(right));
	} catch {
		return false;
	}
}

/** Freeze the host's argument reference only after every policy correction is complete. */
export function sealActionInput(value: Record<string, unknown>): void {
	strictInput(value);
	const seal = (entry: unknown): void => {
		if (entry === null || typeof entry !== "object") return;
		for (const child of Object.values(entry)) seal(child);
		Object.freeze(entry);
	};
	seal(value);
}

export class ActionApprovals {
	private readonly entries = new Map<string, PendingAction>();

	clear(): void {
		this.entries.clear();
	}

	private refresh(binding: ActionBinding): void {
		for (const [id, entry] of this.entries)
			if (entry.binding.session === binding.session && canonical(entry.binding) !== canonical(binding))
				this.entries.delete(id);
	}

	control(params: ActionControl, binding: ActionBinding): unknown {
		this.refresh(binding);
		if (params.operation === "actions")
			return {
				actions: [...this.entries.values()]
					.filter((entry) => entry.binding.session === binding.session)
					.map(({ actionId, revision, tool, state }) => ({ actionId, revision, tool, state })),
				mode: binding.mode,
				boundary:
					"Permissions exist only in this loaded runtime. Inspect the complete action before contextual approval.",
			};
		const entry = params.actionId ? this.entries.get(params.actionId) : undefined;
		if (!entry || entry.binding.session !== binding.session)
			throw new Error("No current action; retry the blocked operation and inspect it");
		if (params.operation === "action-inspect") return cloneJson(entry);
		if (params.revision !== entry.revision)
			throw new Error("Action revision changed; inspect the complete current action");
		if (!params.authorization?.trim()) throw new Error("An operator authorization explanation is required");
		if (params.operation === "action-reject") {
			this.entries.delete(entry.actionId);
			return { actionId: entry.actionId, state: "rejected", mode: binding.mode };
		}
		if (binding.mode !== "enforce") throw new Error("Exact-action approval requires enforce mode");
		if (entry.state !== "pending") throw new Error("The action is already approved; approval does not add another use");
		entry.state = "approved";
		return {
			actionId: entry.actionId,
			state: "approved",
			uses: 1,
			mode: binding.mode,
			boundary:
				"One unchanged retry is armed. The rule remains enabled. Authorization records agent judgment, not human authentication.",
		};
	}

	private consume(
		plan: InputPlan,
		current: PendingAction,
		gates: ProgramEvaluation[],
		seal: (() => void) | undefined,
		consume: boolean,
	): string | undefined {
		try {
			seal?.();
		} catch {
			return "[policy] The host argument object cannot be sealed; the action remains blocked.";
		}
		if (consume) this.entries.delete(current.actionId);
		for (const gate of gates) gate.deny = false;
		plan.denied = plan.evaluations.some((entry) => entry.deny);
		return undefined;
	}
	private retain(entry: PendingAction, current: PendingAction | undefined): string {
		if (!current && this.entries.size >= ACTION_CAPACITY)
			return "[policy] Pending action capacity reached; reject an existing action before another request.";
		if (Buffer.byteLength(JSON.stringify(entry)) > 32 * 1024)
			return "[policy] The complete action and rule list exceed the inspection bound; no pending action was created.";
		this.entries.set(entry.actionId, entry);
		return `[policy] Operator approval required for one exact action. Inspect policy_control action-inspect with actionId ${entry.actionId}; revision ${entry.revision}. Rules: ${entry.rules.map((rule) => rule.id).join(", ")}.`;
	}

	/** Synchronous check-and-consume prevents two parallel retries from sharing one grant. */
	gate(plan: InputPlan, tool: string, binding: ActionBinding, seal?: () => void, consume = true): string | undefined {
		const gates = plan.evaluations.filter((entry) => entry.action.kind === "require-approval" && entry.deny);
		if (!gates.length) return undefined;
		if (binding.mode !== "enforce") return undefined;
		this.refresh(binding);
		if (!plan.valid || plan.evaluations.some((entry) => entry.deny && entry.action.kind !== "require-approval"))
			return "[policy] Other approved input checks refused this action; action approval does not override them.";
		if (gates.some((entry) => entry.truth !== true))
			return "[policy] Approval evidence is unavailable; no exact action was created.";
		let args: Record<string, unknown>;
		try {
			args = strictInput(plan.candidate);
		} catch (error) {
			return `[policy] ${error instanceof Error ? error.message : "Exact arguments are unavailable"}`;
		}
		const rules = gates.map(({ id, revision }) => ({ id, revision })).sort((a, b) => a.id.localeCompare(b.id));
		const fingerprint = digest({ binding, tool, arguments: args, rules });
		const current = [...this.entries.values()].find((entry) => entry.fingerprint === fingerprint);
		if (current?.state === "approved") return this.consume(plan, current, gates, seal, consume);
		const entry = current ?? {
			actionId: randomUUID(),
			revision: fingerprint.slice(0, 12),
			fingerprint,
			binding: cloneJson(binding),
			tool,
			arguments: args,
			rules,
			state: "pending" as const,
		};
		return this.retain(entry, current);
	}
}
