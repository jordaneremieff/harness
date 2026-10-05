/** Ordinary intent input and tool-only awareness output, independent of host wire schemas. */
import { Type } from "typebox";
import { Value } from "typebox/value";
import { StringEnum } from "@earendil-works/pi-ai";

const object = <T extends Record<string, import("typebox").TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false });
const text = Type.String();
const count = Type.Integer({ minimum: 0 });
const repositoryState = Type.Union([Type.Literal("git"), Type.Literal("outside-git"), Type.Literal("unknown")]);
const scope = object({
	paths: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32, description: "Repository-relative paths, exact or component-prefix matching. No globs." }),
	branches: Type.Array(Type.String({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
	fullGate: Type.Optional(Type.Boolean({ description: "Declares a planned full-gate run on this shared machine. This is not a reservation." })),
});
const intentFields = {
	purpose: Type.String({ minLength: 1, maxLength: 1024 }),
	integration: Type.String({ minLength: 1, maxLength: 2048, description: "Next shared acts and dependencies, including a planned full-gate run." }),
	authority: Type.String({ minLength: 1, maxLength: 2048, description: "Quoted operator direction and its scope. This is a carried claim, not authority for the reader." }),
	scope,
	contactThread: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
};
export const IntentParams = object({
	action: StringEnum(["publish", "clear"]),
	purpose: Type.Optional(intentFields.purpose),
	integration: Type.Optional(intentFields.integration),
	authority: Type.Optional(intentFields.authority),
	scope: Type.Optional(intentFields.scope),
	contactThread: intentFields.contactThread,
});
const publishIntent = object({ action: Type.Literal("publish"), ...intentFields });
const clearIntent = object({ action: Type.Literal("clear") });

export function validateIntentInput(input: unknown): void {
	if (!Value.Check(IntentParams, input)) throw new Error("Intent requires action publish or clear and valid publish fields");
	if ((input as { action: string }).action === "clear") {
		if (!Value.Check(clearIntent, input)) throw new Error("Clear intent takes only action; omit all publish fields");
	} else if (!Value.Check(publishIntent, input)) {
		throw new Error("Publish intent requires purpose, integration, authority, and scope with paths and branches");
	}
}
export const IntentClaimSchema = object({ ...intentFields, updatedAt: text });
export const ObservedPurposeSchema = object({ source: Type.Union([Type.Literal("session-name"), Type.Literal("interactive-input")]), text });
export const RelatedEffortSchema = object({
	id: text, cwd: text, name: Type.Optional(text), repository: Type.Optional(text), repositoryState: Type.Optional(repositoryState), startedAt: text,
	lastActivityAt: Type.Optional(text), observedPurpose: Type.Optional(ObservedPurposeSchema), intentClaim: Type.Optional(IntentClaimSchema),
	liveness: Type.Union([Type.Literal("live"), Type.Literal("unknown"), Type.Literal("incompatible")]),
	relationship: Type.Union([Type.Literal("repository"), Type.Literal("cwd"), Type.Literal("machine")]),
	purposeClaim: Type.Optional(text), contactThreadClaim: Type.Optional(text), intentUpdatedAt: Type.Optional(text),
	sharedSubstrates: Type.Optional(Type.Array(Type.Union([Type.Literal("repository"), Type.Literal("cwd"), Type.Literal("machine-gates")]))),
	overlap: Type.Optional(object({ basis: Type.Literal("intentClaim"), paths: Type.Array(text), branches: Type.Array(text) })),
});
export const EffortSelfSchema = object({ id: text, cwd: text, repository: Type.Optional(text), repositoryState: Type.Optional(repositoryState), observedPurpose: Type.Optional(ObservedPurposeSchema), intentClaim: Type.Optional(IntentClaimSchema), omitted: Type.Optional(Type.Boolean()) });
export const RecentCollaborationSchema = object({
	items: Type.Array(object({ id: text, title: text, purpose: text, updatedAt: Type.Number(), closed: Type.Boolean(), members: count })),
	coverage: object({ visited: count, records: count, unreadable: count, missingHints: count, omittedHints: count, omittedResults: count, unvisited: Type.Boolean(), complete: Type.Boolean(), reasons: Type.Array(text) }),
	limits: object({ visits: count, results: count, bytes: count, hintsPerRecord: count }),
});
export const EffortPresenceSchema = object({
	efforts: Type.Array(RelatedEffortSchema),
	coverage: object({ visited: count, unreadable: count, dead: count, unrelated: count, omitted: count, complete: Type.Boolean(), reasons: Type.Array(text) }),
	limits: object({ visits: count, results: count, bytes: count }),
});
export const EffortAwarenessSchema = object({ self: EffortSelfSchema, presence: EffortPresenceSchema, threads: RecentCollaborationSchema });
