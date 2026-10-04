import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { AUTH_SOURCES } from "./models.ts";

// Aggregate byte/line limits apply before publication, including both structured copies.
const text = Type.String({ maxLength: 50 * 1024 });
const count = Type.Integer({ minimum: 0 });
const nullableBoolean = Type.Union([Type.Boolean(), Type.Null()]);
const nullableNumber = Type.Union([Type.Number(), Type.Null()]);
const nullableText = Type.Union([text, Type.Null()]);
const strings = Type.Array(text, { maxItems: 25600 });
const closed = { additionalProperties: false };
const evidence = StringEnum(["registration", "observation", "file_content"]);
const sourceInfo = Type.Object({ path: text, source: text,
	scope: StringEnum(["user", "project", "temporary"]), origin: StringEnum(["package", "top-level"]),
	baseDir: Type.Optional(text) }, closed);
const attestedBoolean = Type.Object({ value: Type.Boolean(), evidence, at: Type.Number() }, closed);
const attestedText = Type.Object({ value: text, evidence, at: Type.Number() }, closed);
const resource = Type.Object({
	kind: StringEnum(["tool", "command", "skill", "prompt"]), name: text, sourceInfo, evidence, at: Type.Number(),
	description: Type.Optional(text), invocation: Type.Optional(text), configured: Type.Optional(Type.Boolean()),
	active: Type.Optional(Type.Boolean()), callable: Type.Optional(Type.Boolean()),
	callableEvidence: Type.Optional(Type.Literal("tool_context")), modelDeclared: Type.Optional(Type.Null()),
	exposure: Type.Optional(StringEnum(["direct", "model-only", "codemode", "deferred", "hidden"])),
	namespace: Type.Optional(Type.Object({ name: text, description: Type.Optional(text),
		instructionsOmitted: Type.Optional(Type.Literal(true, { description: "Pi supplied namespace instructions that registry does not carry. Read them with codemode describeNamespace(name)." })) }, closed)),
	annotations: Type.Optional(Type.Object({ readOnlyHint: Type.Optional(Type.Boolean()), destructiveHint: Type.Optional(Type.Boolean()),
		idempotentHint: Type.Optional(Type.Boolean()), openWorldHint: Type.Optional(Type.Boolean()) }, closed)),
	// Registered parameter schemas are arbitrary JSON Schema, not registry-owned fields.
	parameters: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()])),
	promptGuidelines: Type.Optional(strings), modelInvocable: Type.Optional(attestedBoolean), baseDir: Type.Optional(attestedText),
	observationIdentityMismatch: Type.Optional(Type.Boolean()),
}, closed);
const finding = Type.Object({ code: StringEnum(["expiry_marker", "selected_not_in_catalog", "selected_auth_missing", "metadata_conflict"]),
	reason: text, boundary: text, fields: Type.Optional(strings), duplicateRecords: Type.Optional(count) }, closed);
const priceRates = { input: Type.Number(), output: Type.Number(), cacheRead: Type.Number(), cacheWrite: Type.Number() };
const catalogCost = Type.Union([Type.Object({ ...priceRates, tiers: Type.Optional(Type.Array(
	Type.Object({ ...priceRates, inputTokensAbove: Type.Number() }, closed))) }, closed), Type.Null()]);
const settingsScope = Type.Object({ status: StringEnum(["available", "absent", "unavailable"]),
	patterns: Type.Union([strings, Type.Null()]), observedAt: Type.Number() }, closed);
const model = Type.Object({
	kind: Type.Literal("model"), name: text, provider: text, id: text, displayName: text,
	catalog: Type.Boolean(), selected: Type.Boolean(), reasoning: Type.Boolean(), input: strings,
	contextWindow: Type.Number(), maxTokens: Type.Number(), supportedThinkingLevels: strings,
	available: nullableBoolean, configuredAuth: nullableBoolean, extensionProvider: nullableBoolean, inScope: nullableBoolean,
	oauth: nullableBoolean, subscriptionRecognized: nullableBoolean, authSource: Type.Union([StringEnum(AUTH_SOURCES), Type.Null()]),
	catalogCost, catalogCostHasTiers: nullableBoolean, providerHasScopedModels: nullableBoolean,
	scopeIndex: Type.Optional(count), scopeThinkingLevel: Type.Optional(text), currentThinkingLevel: Type.Optional(text),
	evidence: Type.Literal("registration"), at: Type.Number(), findings: Type.Optional(Type.Array(finding, { maxItems: 4 })),
}, closed);
const contextFile = Type.Object({ kind: Type.Literal("context_file"), name: text, path: text,
	evidence: Type.Literal("observation"), at: Type.Number() }, closed);
const match = Type.Object({ line: Type.Integer({ minimum: 1 }), text }, closed);
const query = Type.Object({ match: StringEnum(["exact", "substring"]), limit: Type.Integer({ minimum: 1, maximum: 100 }),
	name: Type.Optional(text), kind: Type.Optional(StringEnum(["tool", "command", "skill", "prompt", "model", "context_file"])),
	search: Type.Optional(text), detail: Type.Optional(Type.Boolean()), provider: Type.Optional(text),
	available: Type.Optional(Type.Boolean()), health: Type.Optional(Type.Boolean()), contains: Type.Optional(text) }, closed);
const availability = Type.Object({ tools: Type.Boolean(), activeTools: Type.Boolean(), commands: Type.Boolean(),
	callableTools: Type.Optional(Type.Boolean()) }, closed);
const context = Type.Object({ at: Type.Number(), evidence: Type.Literal("host_estimate"),
	state: StringEnum(["available", "unknown", "unavailable"]), model: nullableText, thinkingLevel: nullableText,
	tokens: nullableNumber, contextWindow: nullableNumber, percent: nullableNumber }, closed);
const health = Type.Object({ evidence: Type.Literal("local_catalog_review"), catalogRecords: count,
	selectedAuth: StringEnum(["not_selected", "unavailable", "checked"]),
	providerRefreshMembership: Type.Literal("unavailable"), providerRefreshTime: Type.Literal("unavailable"),
	recentDispatchUse: Type.Literal("unavailable"), lastDispatchAge: Type.Literal("unavailable"), remoteResolution: Type.Literal("not_checked"),
	matchedRecords: count, unflaggedRecords: count, boundaries: strings }, closed);

/** The same bounded data powers native scripts and the terminal card. Missing fields remain unknown. */
export const RegistryOutputSchema = Type.Object({
	outcome: StringEnum(["ok", "host_summary", "missing", "ambiguous", "unavailable", "partial", "cancelled", "stale_cursor", "io_error", "invalid_arguments"]),
	records: Type.Array(Type.Union([resource, model, contextFile, match]), { maxItems: 100 }),
	resultBounded: Type.Boolean(), omittedRecordBlocks: count, returnedRecords: count,
	cursor: Type.Optional(Type.String({ maxLength: 16384 })), pageBlocked: Type.Optional(Type.Boolean()), omittedDetails: Type.Optional(Type.Boolean()),
	query: Type.Optional(query), total: Type.Optional(count), offset: Type.Optional(count), candidates: Type.Optional(count),
	availability: Type.Optional(availability), observed: Type.Optional(Type.Boolean()), observedAt: Type.Optional(nullableNumber),
	observationPartial: Type.Optional(Type.Boolean()), unavailableSurfaces: Type.Optional(strings), incompleteInventory: Type.Optional(Type.Boolean()),
	host: Type.Optional(Type.Boolean()), context: Type.Optional(context),
	counts: Type.Optional(Type.Object({ tool: count, command: count, skill: count, prompt: count }, closed)),
	activeToolCount: Type.Optional(Type.Union([count, Type.Null()])),
	catalogBoundary: Type.Optional(text),
	catalogAvailable: Type.Optional(Type.Boolean()), availableSnapshot: Type.Optional(Type.Boolean()),
	catalogError: Type.Optional(nullableBoolean), scopeConfigured: Type.Optional(nullableBoolean), health: Type.Optional(health),
	settingsScope: Type.Optional(settingsScope),
	scanned: Type.Optional(Type.Boolean()), cancelled: Type.Optional(Type.Boolean()), staleCursor: Type.Optional(Type.Boolean()),
	reason: Type.Optional(text), message: Type.Optional(text), ioError: Type.Optional(text),
	resolved: Type.Optional(Type.Object({ kind: StringEnum(["tool", "command", "skill", "prompt"]), name: text, sourceInfo }, closed)),
	bytesRead: Type.Optional(count), fileSize: Type.Optional(count), at: Type.Optional(Type.Number()), evidence: Type.Optional(evidence),
	partialScan: Type.Optional(Type.Boolean()), modelInvocable: Type.Optional(attestedBoolean),
	frontmatter: Type.Optional(Type.Object({ state: StringEnum(["absent", "incomplete", "invalid", "non_object", "valid", "unknown"]),
		disableModelInvocation: Type.Optional(Type.Boolean()) }, closed)),
}, { ...closed, description: "Bounded registry page. Model queries cover chat models only. Check outcome, source coverage, resultBounded and pageBlocked before treating an empty records array as absence. Continue with cursor alone. Tool callable is ctx.tools membership, not permission or model declaration." });
