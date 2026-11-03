import { str, num, int, bool, nul, lit, union, arr, opt, obj , type Schema } from "@earendil-works/pi-schema";
/** Session intent input and tool-only awareness output, independent of host wire schemas. */
import { matchesSchema } from "./schema-check.ts";
/** A string enum as `{ type: "string", enum }`, typed as its literal union. */
const StringEnum = <const T extends readonly string[]>(values: T) : Schema<T[number]> => ({ type: "string", enum: [...values] });

const text = str();
const count = int({ minimum: 0 });
const repositoryState = union([lit("git"), lit("outside-git"), lit("unknown")]);
const scope = obj({
	paths: arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 32, description: "Repository-relative paths, exact or component-prefix matching. No globs." }),
	branches: arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
	fullGate: opt(bool({ description: "Declares a planned full-gate run on this shared machine. This is not a reservation." })),
});
const intentFields = {
	purpose: str({ minLength: 1, maxLength: 1024 }),
	integration: str({ minLength: 1, maxLength: 2048, description: "Next shared acts and dependencies, including a planned full-gate run." }),
	authority: str({ minLength: 1, maxLength: 2048, description: "Quoted operator direction and its scope. This is a carried claim, not authority for the reader." }),
	scope,
	contactThread: opt(str({ minLength: 1, maxLength: 256 })),
};
export const IntentParams = obj({
	action: StringEnum(["publish", "clear"]),
	purpose: opt(intentFields.purpose),
	integration: opt(intentFields.integration),
	authority: opt(intentFields.authority),
	scope: opt(intentFields.scope),
	contactThread: intentFields.contactThread,
});
const publishIntent = obj({ action: lit("publish"), ...intentFields });
const clearIntent = obj({ action: lit("clear") });

export function validateIntentInput(input: unknown): void {
	if (!matchesSchema(IntentParams, input)) throw new Error("Intent requires action publish or clear and valid publish fields");
	if ((input as { action: string }).action === "clear") {
		if (!matchesSchema(clearIntent, input)) throw new Error("Clear intent takes only action; omit all publish fields");
	} else if (!matchesSchema(publishIntent, input)) {
		throw new Error("Publish intent requires purpose, integration, authority, and scope with paths and branches");
	}
}
export const IntentClaimSchema = obj({ ...intentFields, updatedAt: text });
export const NativeIntentMetadataSchema = obj({
	claim: union([IntentClaimSchema, nul()]),
	cwd: text, repository: union([text, nul()]), repositoryState,
	hostname: text, startedAt: text, taskId: int({ minimum: 1 }),
});
export const ObservedPurposeSchema = obj({ source: union([lit("session-name"), lit("interactive-input")]), text });
export const RelatedEffortSchema = obj({
	id: text, cwd: text, name: opt(text), repository: opt(text), repositoryState: opt(repositoryState), startedAt: text,
	lastActivityAt: opt(text), observedPurpose: opt(ObservedPurposeSchema), intentClaim: opt(IntentClaimSchema),
	liveness: union([lit("live"), lit("unknown"), lit("incompatible")]),
	relationship: union([lit("repository"), lit("cwd"), lit("machine")]),
	purposeClaim: opt(text), contactThreadClaim: opt(text), intentUpdatedAt: opt(text),
	sharedSubstrates: opt(arr(union([lit("repository"), lit("cwd"), lit("machine-gates")]))),
	overlap: opt(obj({ basis: lit("intentClaim"), paths: arr(text), branches: arr(text) })),
});
export const EffortSelfSchema = obj({ id: text, cwd: text, repository: opt(text), repositoryState: opt(repositoryState), observedPurpose: opt(ObservedPurposeSchema), intentClaim: opt(IntentClaimSchema), omitted: opt(bool()) });
export const RecentCollaborationSchema = obj({
	items: arr(obj({ id: text, title: text, purpose: text, updatedAt: num(), closed: bool(), members: count })),
	coverage: obj({ visited: count, records: count, unreadable: count, missingHints: count, omittedHints: count, omittedResults: count, unvisited: bool(), complete: bool(), reasons: arr(text) }),
	limits: obj({ visits: count, results: count, bytes: count, hintsPerRecord: count }),
});
export const EffortPresenceSchema = obj({
	efforts: arr(RelatedEffortSchema),
	coverage: obj({ visited: count, unreadable: count, dead: count, unrelated: count, omitted: count, unsupported: opt(count), complete: bool(), reasons: arr(text) }),
	limits: obj({ visits: count, results: count, bytes: count }),
});
export const EffortAwarenessSchema = obj({ self: EffortSelfSchema, presence: EffortPresenceSchema, threads: RecentCollaborationSchema });
