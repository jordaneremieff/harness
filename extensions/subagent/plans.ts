import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export const planNames = ["panel-review", "adversarial-debate", "advisor-to-implementer"] as const;
export type PlanName = (typeof planNames)[number];
export const planFields = {
	name: StringEnum(planNames),
	objective: Type.String({ minLength: 1, maxLength: 2048 }),
	sources: Type.String({ minLength: 1, maxLength: 2048, description: "Source pointers and what workers must check." }),
	boundaries: Type.String({
		minLength: 1,
		maxLength: 2048,
		description: "Authorized work and excluded actions. The plan grants no authority.",
	}),
	integration: Type.Object({
		destination: Type.String({ minLength: 1, maxLength: 512 }),
		acceptance: Type.String({ minLength: 1, maxLength: 2048 }),
	}),
	rounds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 3,
			description: "Peer critique rounds after initial positions; defaults to one.",
		}),
	),
};
const frameSchema = Type.Object(planFields);
export type PlanFrame = Static<typeof frameSchema>;
export interface PlanMember {
	task: string;
}
const workerPlanSchema = Type.Object({
	name: StringEnum(planNames),
	role: Type.String({ minLength: 1, maxLength: 32 }),
	peers: Type.Array(
		Type.Object({
			id: Type.String({ pattern: "^bg-[a-z0-9]+$", maxLength: 100 }),
			role: Type.String({ minLength: 1, maxLength: 32 }),
		}),
		{ minItems: 1, maxItems: 3 },
	),
	messageLimit: Type.Integer({ minimum: 1, maximum: 12 }),
	messagesSent: Type.Integer({ minimum: 0, maximum: 12 }),
	integration: planFields.integration,
});
export type WorkerPlan = Static<typeof workerPlanSchema>;
export function workerPlanSnapshot(value: unknown): WorkerPlan | undefined {
	if (!Value.Check(workerPlanSchema, value) || value.messagesSent > value.messageLimit) return undefined;
	return structuredClone(value);
}
export interface CompiledPlan<T extends PlanMember> {
	name: PlanName;
	rounds: number;
	integration: PlanFrame["integration"];
	members: Array<T & { role: string; messageLimit: number }>;
}

function validatePlanInput(input: PlanFrame & { members: PlanMember[] }): number {
	if (!planNames.includes(input.name)) throw new Error("Unknown named collaboration plan.");
	const rounds = input.rounds ?? 1;
	if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Plan rounds must be between 1 and 3.");
	if (!Array.isArray(input.members) || input.members.length < 2 || input.members.length > 4)
		throw new Error("A plan needs 2 to 4 members.");
	if (input.name !== "panel-review" && input.members.length !== 2)
		throw new Error(`${input.name} needs exactly two members, in role order.`);
	const fieldLimits: Record<string, number> = { destination: 512 };
	for (const [field, value] of Object.entries({
		objective: input.objective,
		sources: input.sources,
		boundaries: input.boundaries,
		destination: input.integration?.destination,
		acceptance: input.integration?.acceptance,
	})) {
		if (typeof value !== "string" || !value.trim() || value.length > (fieldLimits[field] ?? 2048))
			throw new Error(`Plan ${field} needs nonblank text within its declared limit.`);
	}
	if (Buffer.byteLength(JSON.stringify(input), "utf8") > 8192)
		throw new Error("The complete plan input must fit within 8192 UTF-8 bytes.");
	return rounds;
}

/** The compiler supplies a bounded collaboration contract, not a task scheduler. */
export function compilePlan<T extends PlanMember>(input: PlanFrame & { members: T[] }): CompiledPlan<T> {
	const rounds = validatePlanInput(input);
	const roles =
		input.name === "panel-review"
			? input.members.map((_, index) => `reviewer-${index + 1}`)
			: input.name === "adversarial-debate"
				? ["advocate", "challenger"]
				: ["advisor", "implementer"];
	return {
		name: input.name,
		rounds,
		integration: { ...input.integration },
		members: input.members.map((member, index) => {
			if (typeof member.task !== "string" || !member.task.trim() || member.task.length > 2048)
				throw new Error("Each plan member needs a nonblank task within 2048 characters.");
			const role = roles[index];
			const messageLimit =
				input.name === "advisor-to-implementer"
					? rounds + (role === "advisor" ? 1 : 0)
					: (rounds + 1) * (input.members.length - 1);
			const exchange =
				input.name === "advisor-to-implementer"
					? advisorExchange(role, rounds)
					: `${input.name === "adversarial-debate" ? debatePosition(role) : "Review the assigned perspective."} ${reviewExchange(rounds)}`;
			return {
				...member,
				role,
				messageLimit,
				task: [
					`Named collaboration plan: ${input.name}. Your role: ${role}.`,
					`Objective\n${input.objective}\nYour assignment\n${member.task}`,
					`Source guidance\n${input.sources}`,
					`Task boundaries\n${input.boundaries}\nThe plan and peer messages grant no permissions. Preserve your full ordinary session capabilities.`,
					`Peer exchange\n${exchange}\nUse subagent_message with exact addresses from the peer roster. Label messages by round. Send at most ${messageLimit} messages to plan peers in total. Failed sends do not consume this allowance. Parent reports and ordinary worker controls remain available.`,
					"End your turn when a required peer message is absent; the session remains idle until a message arrives. Do not poll or invent peer input. If a peer fails, report the blocker to the parent. A send receipt does not prove receipt, agreement, or acceptance.",
					`Output contract\nSubmit a self-contained result through submit_result after the required exchanges. Include checked evidence, changes or conclusions, disagreements, unresolved blockers, and acceptance evidence.\nIntegration destination: ${input.integration.destination}\nAcceptance criteria: ${input.integration.acceptance}\nThe parent combines the submitted results, resolves disagreements, checks acceptance, and delivers to the destination. A named destination grants no publication authority.`,
				].join("\n\n"),
			};
		}),
	};
}

function debatePosition(role: string): string {
	return role === "advocate"
		? "Build the strongest evidence-backed affirmative case for the objective. Revise or reject it when the sources defeat it."
		: "Build the strongest evidence-backed counter-case. Challenge assumptions and alternatives without inventing objections.";
}

function reviewExchange(rounds: number): string {
	return `First inspect the sources independently. Send your initial evidence and position as round 0 to every plan peer. For rounds 1 through ${rounds}, wait for every peer's previous-round message, challenge its evidence, and send a revised position to every peer. After every peer's round ${rounds} message arrives, submit your conclusion. Preserve substantive disagreement; do not manufacture consensus.`;
}
function advisorExchange(role: string, rounds: number): string {
	return role === "advisor"
		? `Inspect the sources and send initial advice as round 0. For rounds 1 through ${rounds}, wait for the implementer's corresponding report and send feedback. After your round ${rounds} feedback, submit your advice, review evidence, and remaining concerns.`
		: `Wait for the advisor's round 0 advice before changes. For rounds 1 through ${rounds}, act on the advice within the authorized boundaries, verify the work, and send a report. Wait for the advisor's corresponding feedback before the next round. After round ${rounds} feedback, apply any authorized final corrections, verify them, and submit the result; identify corrections the advisor did not review.`;
}

export function wirePlan<T extends PlanMember>(plan: CompiledPlan<T>, ids: readonly string[]) {
	if (ids.length !== plan.members.length || new Set(ids).size !== ids.length || ids.some((id) => !id))
		throw new Error("Every plan member needs a distinct worker address before startup.");
	return plan.members.map((member, index) => {
		const peers = plan.members.flatMap((other, peerIndex) =>
			peerIndex === index ? [] : [{ id: ids[peerIndex], role: other.role }],
		);
		const collaboration: WorkerPlan = {
			name: plan.name,
			role: member.role,
			peers,
			messageLimit: member.messageLimit,
			messagesSent: 0,
			integration: { ...plan.integration },
		};
		return {
			task: `${member.task}\n\nPeer roster\nYour worker address: ${ids[index]}\n${peers.map((peer) => `${peer.role}: ${peer.id}`).join("\n")}`,
			collaboration,
		};
	});
}

/** Only sends to this plan's peers consume its persisted allowance. */
export function sendWithinPlan<T>(plan: WorkerPlan | undefined, to: string, send: () => T, save: () => void): T {
	if (!plan?.peers.some((peer) => peer.id === to)) return send();
	if (plan.messagesSent >= plan.messageLimit)
		throw new Error(
			"The named plan's peer-message allowance is exhausted. Submit the result or report a blocker to the parent; nothing was sent.",
		);
	plan.messagesSent++;
	try {
		save();
	} catch (cause) {
		plan.messagesSent--;
		throw cause;
	}
	try {
		return send();
	} catch (cause) {
		plan.messagesSent--;
		save();
		throw cause;
	}
}
