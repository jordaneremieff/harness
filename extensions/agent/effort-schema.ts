import { str, num, int, bool, nul, lit, union, arr, opt, obj, type Schema } from "@earendil-works/pi-schema";
/** Session intent input and tool-only awareness output, independent of host wire schemas. */
import { matchesSchema } from "./schema-check.ts";
/** A string enum as `{ type: "string", enum }`, typed as its literal union. */
const StringEnum = <const T extends readonly string[]>(values: T): Schema<T[number]> => ({
	type: "string",
	enum: [...values],
});

const text = str();
const count = int({ minimum: 0 });
const repositoryState = union([lit("git"), lit("outside-git"), lit("unknown")]);
const scope = obj({
	paths: arr(str({ minLength: 1, maxLength: 512 }), {
		maxItems: 32,
		description: "Repository-relative paths, exact or component-prefix matching. No globs.",
	}),
	branches: arr(str({ minLength: 1, maxLength: 512 }), { maxItems: 32 }),
	fullGate: opt(
		bool({ description: "Declares a planned full-gate run on this shared machine. This is not a reservation." }),
	),
});
const intentFields = {
	purpose: str({ minLength: 1, maxLength: 1024 }),
	integration: str({
		minLength: 1,
		maxLength: 2048,
		description: "Next shared acts and dependencies, including a planned full-gate run.",
	}),
	authority: str({
		minLength: 1,
		maxLength: 2048,
		description: "Quoted operator direction and its scope. This is a carried claim, not authority for the reader.",
	}),
	scope,
	contactThread: opt(str({ minLength: 1, maxLength: 256 })),
};
export const IntentParams = obj({
	action: {
		...StringEnum(["read", "publish", "clear"]),
		description:
			"read and clear take no other field. publish requires purpose, integration, authority and scope with paths and branches; empty arrays declare no shared path or branch.",
	},
	purpose: opt(intentFields.purpose),
	integration: opt(intentFields.integration),
	authority: opt(intentFields.authority),
	scope: opt(intentFields.scope),
	contactThread: intentFields.contactThread,
});
const publishIntent = obj({ action: lit("publish"), ...intentFields });
const actionOnly = obj({ action: StringEnum(["read", "clear"]) });

/** The publish fields that a publish input omits, with the scope arrays named separately. */
function missingPublishFields(fields: Record<string, unknown>): string[] {
	const missing = ["purpose", "integration", "authority", "scope"].filter((key) => fields[key] === undefined);
	const scope = fields.scope as { paths?: unknown; branches?: unknown } | null | undefined;
	if (scope === undefined) return missing;
	if (!Array.isArray(scope?.paths)) missing.push("scope.paths");
	if (!Array.isArray(scope?.branches)) missing.push("scope.branches");
	return missing;
}

export function validateIntentInput(input: unknown): void {
	const fields = (input !== null && typeof input === "object" ? input : {}) as Record<string, unknown>;
	if (fields.action === "publish") {
		if (matchesSchema(publishIntent, input)) return;
		const missing = missingPublishFields(fields);
		throw new Error(
			`Publish intent requires purpose, integration, authority, and scope with paths and branches${missing.length ? `; missing: ${missing.join(", ")}` : ""}. Use empty paths and branches arrays when no path or branch is shared.`,
		);
	}
	if (!matchesSchema(IntentParams, input))
		throw new Error("Intent requires action read, publish or clear and valid publish fields");
	if (!matchesSchema(actionOnly, input))
		throw new Error(`${fields.action === "read" ? "Read" : "Clear"} intent takes only action; omit all publish fields`);
}
export const IntentClaimSchema = obj({ ...intentFields, updatedAt: text });
export const NativeIntentMetadataSchema = obj({
	claim: union([IntentClaimSchema, nul()]),
	cwd: text,
	repository: union([text, nul()]),
	repositoryState,
	hostname: text,
	startedAt: text,
	taskId: int({ minimum: 1 }),
});
export const ObservedPurposeSchema = obj({ source: union([lit("session-name"), lit("interactive-input")]), text });
const WorkReferenceSchema = obj({ kind: text, id: text, title: opt(text) });
export const RelatedEffortSchema = obj({
	id: text,
	cwd: text,
	name: opt(text),
	repository: opt(text),
	repositoryState: opt(repositoryState),
	startedAt: text,
	lastActivityAt: opt(text),
	observedPurpose: opt(ObservedPurposeSchema),
	intentClaim: opt(IntentClaimSchema),
	liveness: union([lit("live"), lit("unknown"), lit("incompatible")]),
	relationship: union([lit("repository"), lit("cwd"), lit("machine")]),
	purposeClaim: opt(text),
	contactThreadClaim: opt(text),
	intentUpdatedAt: opt(text),
	sharedSubstrates: opt(arr(union([lit("repository"), lit("cwd"), lit("machine-gates")]))),
	overlap: opt(obj({ basis: lit("intentClaim"), paths: arr(text), branches: arr(text) })),
	sharedWork: opt(arr(WorkReferenceSchema)),
	sharedTopics: opt(arr(text)),
});
export const EffortSelfSchema = obj({
	id: text,
	cwd: text,
	repository: opt(text),
	repositoryState: opt(repositoryState),
	observedPurpose: opt(ObservedPurposeSchema),
	intentClaim: opt(IntentClaimSchema),
	workRefs: opt(arr(WorkReferenceSchema)),
	omitted: opt(bool()),
});
export const RecentCollaborationSchema = obj({
	items: arr(obj({ id: text, title: text, purpose: text, updatedAt: num(), closed: bool(), members: count })),
	coverage: obj({
		visited: count,
		records: count,
		unreadable: count,
		missingHints: count,
		outOfScope: opt(count),
		omittedHints: count,
		omittedResults: count,
		unvisited: bool(),
		complete: bool(),
		reasons: arr(text),
	}),
	limits: obj({ visits: count, results: count, bytes: count, hintsPerRecord: count }),
});
export const EffortPresenceSchema = obj({
	efforts: arr(RelatedEffortSchema),
	coverage: obj({
		visited: count,
		unreadable: count,
		dead: count,
		unrelated: count,
		outOfScope: opt(count),
		omitted: count,
		unsupported: opt(count),
		complete: bool(),
		reasons: arr(text),
	}),
	limits: obj({ visits: count, results: count, bytes: count }),
});
export const EffortAwarenessSchema = obj({
	self: EffortSelfSchema,
	presence: EffortPresenceSchema,
	threads: RecentCollaborationSchema,
});
