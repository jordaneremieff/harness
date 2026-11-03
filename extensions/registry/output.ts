import { arr, bool, int, lit, map, nul, num, obj, oneOf, opt, str, union, unknown } from "@earendil-works/pi-schema";
import { AUTH_SOURCES } from "./models.ts";

// Aggregate byte/line limits apply before publication, including both structured copies.
const text = str({ maxLength: 50 * 1024 });
const count = int({ minimum: 0 });
const nullableBoolean = union([bool(), nul()]);
const nullableNumber = union([num(), nul()]);
const nullableText = union([text, nul()]);
const strings = arr(text, { maxItems: 25600 });
const evidence = oneOf(["registration", "observation", "file_content"]);
const sourceInfo = obj({ path: text, source: text,
	scope: oneOf(["user", "project", "temporary"]), origin: oneOf(["package", "top-level"]),
	baseDir: opt(text) });
const attestedBoolean = obj({ value: bool(), evidence, at: num() });
const attestedText = obj({ value: text, evidence, at: num() });
const resource = obj({
	kind: oneOf(["tool", "command", "skill", "prompt"]), name: text, sourceInfo, evidence, at: num(),
	description: opt(text), invocation: opt(text), configured: opt(bool()),
	active: opt(bool()), callable: opt(bool()),
	callableEvidence: opt(oneOf(["tool_context", "durable_agent"])), modelDeclared: opt(nul()),
	exposure: opt(oneOf(["direct", "model-only", "codemode", "deferred", "hidden"])),
	namespace: opt(obj({ name: text, aliases: opt(strings), description: opt(text),
		instructionsOmitted: opt(lit(true, { description: "Pi supplied namespace instructions that registry does not carry. Read them with codemode describeNamespace(name)." })) })),
	annotations: opt(obj({ readOnlyHint: opt(bool()), destructiveHint: opt(bool()),
		idempotentHint: opt(bool()), openWorldHint: opt(bool()) })),
	// Registered parameter schemas are arbitrary JSON Schema, not registry-owned fields.
	parameters: opt(union([map(unknown()), nul()])),
	promptGuidelines: opt(strings), modelInvocable: opt(attestedBoolean), baseDir: opt(attestedText),
	observationIdentityMismatch: opt(bool()),
});
const finding = obj({ code: oneOf(["expiry_marker", "selected_not_in_catalog", "selected_auth_missing", "metadata_conflict"]),
	reason: text, boundary: text, fields: opt(strings), duplicateRecords: opt(count) });
const priceRates = { input: num(), output: num(), cacheRead: num(), cacheWrite: num() };
const catalogCost = union([obj({ ...priceRates, tiers: opt(arr(
	obj({ ...priceRates, inputTokensAbove: num() }))) }), nul()]);
const settingsScope = obj({ status: oneOf(["available", "absent", "unavailable"]),
	patterns: union([strings, nul()]), observedAt: num() });
const model = obj({
	kind: lit("model"), name: text, provider: text, id: text, displayName: text,
	catalog: bool(), selected: bool(), reasoning: bool(), input: strings,
	contextWindow: num(), maxTokens: num(), supportedThinkingLevels: strings,
	available: nullableBoolean, configuredAuth: nullableBoolean, extensionProvider: nullableBoolean, inScope: nullableBoolean,
	oauth: nullableBoolean, subscriptionRecognized: nullableBoolean, authSource: union([oneOf(AUTH_SOURCES), nul()]),
	catalogCost, catalogCostHasTiers: nullableBoolean, providerHasScopedModels: nullableBoolean, providerNamedInSettings: nullableBoolean,
	scopeIndex: opt(count), scopeThinkingLevel: opt(text), currentThinkingLevel: opt(text),
	evidence: lit("registration"), at: num(), findings: opt(arr(finding, { maxItems: 4 })),
});
const contextFile = obj({ kind: lit("context_file"), name: text, path: text,
	evidence: lit("observation"), at: num() });
const settingDiagnostic = obj({ field: text, source: oneOf(["env", "file", "default"]),
	code: oneOf(["document", "unknown", "secret", "invalid", "coverage", "relation"]), message: text });
const setting = obj({ kind: lit("setting"), name: text, key: text, slice: text,
	type: oneOf(["string", "path", "integer", "number", "boolean", "enum", "json"]),
	description: text, env: text, secret: bool(), origin: oneOf(["env", "file", "default"]),
	status: oneOf(["valid", "unset", "invalid"]), value: opt(unknown()),
	secretState: opt(oneOf(["set", "unset"])), documentPath: text,
	documentStatus: oneOf(["loaded", "missing", "invalid", "unavailable"]), observedAt: text,
	diagnostics: arr(settingDiagnostic) });
const settingsCoverage = obj({ available: bool(), respondingSlices: strings,
	installedCoverage: lit("unknown"), collection: obj({
		status: oneOf(["available", "unavailable", "disposed"]), slices: strings, malformed: count, omitted: count,
	}), publications: arr(obj({ slice: text,
		documentPath: text, documentStatus: oneOf(["loaded", "missing", "invalid", "unavailable"]),
		observedAt: text, diagnostics: arr(settingDiagnostic) })) });
const match = obj({ line: int({ minimum: 1 }), text });
const query = obj({ match: oneOf(["exact", "substring"]), limit: int({ minimum: 1, maximum: 100 }),
	name: opt(text), kind: opt(oneOf(["tool", "command", "skill", "prompt", "model", "context_file", "setting"])),
	search: opt(text), detail: opt(bool()), provider: opt(text),
	available: opt(bool()), health: opt(bool()), contains: opt(text) });
const availability = obj({ tools: bool(), activeTools: bool(), commands: bool(),
	callableTools: opt(bool()) });
const context = obj({ at: num(), evidence: lit("host_estimate"),
	state: oneOf(["available", "unknown", "unavailable"]), model: nullableText, thinkingLevel: nullableText,
	tokens: nullableNumber, contextWindow: nullableNumber, percent: nullableNumber });
const health = obj({ evidence: lit("local_catalog_review"), catalogRecords: count,
	selectedAuth: oneOf(["not_selected", "unavailable", "checked"]),
	providerRefreshMembership: lit("unavailable"), providerRefreshTime: lit("unavailable"),
	recentDispatchUse: lit("unavailable"), lastDispatchAge: lit("unavailable"), remoteResolution: lit("not_checked"),
	matchedRecords: count, unflaggedRecords: count, boundaries: strings });

/** The same bounded data powers native scripts and the terminal card. Missing fields remain unknown. */
export const RegistryOutputSchema = obj({
	outcome: oneOf(["ok", "host_summary", "missing", "ambiguous", "unavailable", "partial", "cancelled", "stale_cursor", "io_error", "invalid_arguments"]),
	records: arr(union([resource, model, contextFile, setting, match]), { maxItems: 100 }),
	resultBounded: bool(), omittedRecordBlocks: count, returnedRecords: count,
	cursor: opt(str({ maxLength: 16384 })), pageBlocked: opt(bool()), omittedDetails: opt(bool()),
	query: opt(query), total: opt(count), offset: opt(count), candidates: opt(count),
	availability: opt(availability), observed: opt(bool()), observedAt: opt(nullableNumber),
	observationPartial: opt(bool()), unavailableSurfaces: opt(strings), incompleteInventory: opt(bool()),
	host: opt(bool()), context: opt(context),
	counts: opt(obj({ tool: count, command: count, skill: count, prompt: count })),
	activeToolCount: opt(union([count, nul()])),
	catalogBoundary: opt(text),
	catalogAvailable: opt(bool()), availableSnapshot: opt(bool()),
	catalogError: opt(nullableBoolean), scopeConfigured: opt(nullableBoolean), health: opt(health),
	settingsScope: opt(settingsScope), settingsCoverage: opt(settingsCoverage),
	scanned: opt(bool()), cancelled: opt(bool()), staleCursor: opt(bool()),
	reason: opt(text), message: opt(text), ioError: opt(text),
	resolved: opt(obj({ kind: oneOf(["tool", "command", "skill", "prompt"]), name: text, sourceInfo })),
	bytesRead: opt(count), fileSize: opt(count), at: opt(num()), evidence: opt(evidence),
	partialScan: opt(bool()), modelInvocable: opt(attestedBoolean),
	frontmatter: opt(obj({ state: oneOf(["absent", "incomplete", "invalid", "non_object", "valid", "unknown"]),
		disableModelInvocation: opt(bool()) })),
}, { description: "Bounded registry page. Model queries cover chat models only. Check outcome, source coverage, resultBounded and pageBlocked before treating an empty records array as absence. Continue with cursor alone. Tool callable is ctx.tools or Durable Agent.callable membership, not permission or model declaration." });
