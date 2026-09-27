import assert from "node:assert/strict";
import { test } from "node:test";
import {
	CONFIGURATION_LIMITS,
	boundedConfigurationResult,
	configurationSessionId,
	configurationModel,
	configurationThinkingLevel,
	isThinkingLevel,
	parseConfigurationArguments,
	THINKING_LEVELS,
	validateConfigurationPatch,
	type ConfigurationResult,
} from "./configuration.ts";

test("configuration accepts independent fields and explicit name removal", () => {
	assert.deepEqual(validateConfigurationPatch({ name: "Review" }), { name: "Review" });
	assert.deepEqual(validateConfigurationPatch({ name: "" }), { name: "" });
	assert.deepEqual(validateConfigurationPatch({ name: "   " }), { name: "" });
	assert.deepEqual(validateConfigurationPatch({ name: "  Review 🧭  " }), { name: "Review 🧭" });
	assert.deepEqual(validateConfigurationPatch({ model: "provider/model" }), { model: "provider/model" });
	for (const thinkingLevel of THINKING_LEVELS) {
		assert.equal(isThinkingLevel(thinkingLevel), true);
		assert.deepEqual(validateConfigurationPatch({ thinkingLevel }), { thinkingLevel });
	}
	const input = Object.freeze({ name: "Review", model: "provider/organization/model", thinkingLevel: "high", extra: undefined });
	assert.throws(() => validateConfigurationPatch(input), /unsupported configuration field/u);
	const valid = Object.freeze({ name: "Review", model: "provider/organization/model", thinkingLevel: "high" });
	const patch = validateConfigurationPatch(valid);
	assert.deepEqual(patch, valid);
	assert.notEqual(patch, valid);
});

test("configuration rejects empty, unknown, inherited, and incorrectly typed fields", () => {
	for (const input of [undefined, null, true, 1, "name", []]) {
		assert.throws(() => validateConfigurationPatch(input), /configuration must be an object/u);
	}
	for (const input of [{}, { name: undefined }, { model: undefined, thinkingLevel: undefined }, Object.create({ name: "inherited" })]) {
		assert.throws(() => validateConfigurationPatch(input), /requires at least one/u);
	}
	for (const input of [{ trust: false }, { sessionId: "session" }, { name: "ok", unexpected: "ignored" }]) {
		assert.throws(() => validateConfigurationPatch(input), /unsupported configuration field/u);
	}
	for (const name of [null, 1, {}, []]) assert.throws(() => validateConfigurationPatch({ name }), /name must be/u);
	for (const model of [null, 1, {}, []]) assert.throws(() => validateConfigurationPatch({ model }), /model must be/u);
	for (const thinkingLevel of [null, false, "", "HIGH", "high ", "automatic", 1]) {
		assert.equal(isThinkingLevel(thinkingLevel), false);
		assert.throws(() => validateConfigurationPatch({ thinkingLevel }), /thinkingLevel must be one of/u);
	}
	assert.deepEqual(validateConfigurationPatch({ name: "ok", model: undefined, thinkingLevel: undefined }), { name: "ok" });
});

test("configuration text has an explicit UTF-16 bound and rejects controls and malformed Unicode", () => {
	const name = "a".repeat(CONFIGURATION_LIMITS.name);
	assert.equal(validateConfigurationPatch({ name }).name, name);
	assert.throws(() => validateConfigurationPatch({ name: `${name}a` }), /UTF-16 code units/u);
	assert.equal(validateConfigurationPatch({ name: "🧭".repeat(CONFIGURATION_LIMITS.name / 2) }).name?.length, CONFIGURATION_LIMITS.name);
	assert.throws(() => validateConfigurationPatch({ name: "🧭".repeat(CONFIGURATION_LIMITS.name / 2 + 1) }), /UTF-16 code units/u);
	for (const invalid of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u001bb", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", "a\ud800b", "a\udcffb"]) {
		assert.throws(() => validateConfigurationPatch({ name: invalid }), /without control characters/u);
		assert.throws(() => validateConfigurationPatch({ model: `provider/${invalid}` }), /without control characters/u);
	}
});

test("configuration models require a complete exact identity and retain nested model IDs", () => {
	assert.deepEqual(configurationModel("provider/model"), { provider: "provider", modelId: "model" });
	assert.deepEqual(configurationModel("provider/organization/model"), { provider: "provider", modelId: "organization/model" });
	for (const model of ["", "model", "/model", "provider/", " provider/model", "provider/model ", "provider/a b"]) {
		assert.throws(() => configurationModel(model), /exact provider\/model/u);
	}
	const model = `p/${"m".repeat(CONFIGURATION_LIMITS.model - 2)}`;
	assert.equal(validateConfigurationPatch({ model }).model, model);
	assert.throws(() => configurationModel(`${model}m`), /UTF-16 code units/u);
});

test("model-only configuration preserves effective reasoning without selecting a default", () => {
	const patch = validateConfigurationPatch({ model: "provider/model" });
	for (const current of THINKING_LEVELS) assert.equal(configurationThinkingLevel(patch, current), current);
	for (const absent of [undefined, null, "", "unknown", 1]) {
		assert.throws(() => configurationThinkingLevel(patch, absent), /no retained reasoning level; supply thinkingLevel/u);
	}
});

test("explicit reasoning wins while name-only configuration leaves reasoning alone", () => {
	for (const thinkingLevel of THINKING_LEVELS) {
		assert.equal(configurationThinkingLevel(validateConfigurationPatch({ model: "provider/model", thinkingLevel }), "high"), thinkingLevel);
		assert.equal(configurationThinkingLevel(validateConfigurationPatch({ thinkingLevel }), undefined), thinkingLevel);
	}
	assert.equal(configurationThinkingLevel(validateConfigurationPatch({ name: "renamed" }), "high"), undefined);
	assert.equal(configurationThinkingLevel(validateConfigurationPatch({ name: "" }), undefined), undefined);
});

test("configuration command parses the same patch contract and bare name removal", () => {
	assert.deepEqual(parseConfigurationArguments(["session", "name", "New", "purpose"]), { sessionId: "session", patch: { name: "New purpose" } });
	assert.deepEqual(parseConfigurationArguments(["session", "name"]), { sessionId: "session", patch: { name: "" } });
	assert.deepEqual(parseConfigurationArguments(["session", "model", "provider/model"]), { sessionId: "session", patch: { model: "provider/model" } });
	assert.deepEqual(parseConfigurationArguments(["session", "model", "provider/organization/model", "low"]), { sessionId: "session", patch: { model: "provider/organization/model", thinkingLevel: "low" } });
	assert.deepEqual(parseConfigurationArguments(["session", "thinking", "off"]), { sessionId: "session", patch: { thinkingLevel: "off" } });
	for (const args of [[], ["session"], ["session", "unknown"], ["session", "model"], ["session", "model", "p/m", "low", "extra"], ["session", "thinking"], ["session", "thinking", "low", "extra"]]) {
		assert.throws(() => parseConfigurationArguments(args), /Use \/agent configure/u);
	}
	assert.throws(() => parseConfigurationArguments(["session", "model", "missing-provider"]), /exact provider\/model/u);
	assert.throws(() => parseConfigurationArguments(["session", "thinking", "automatic"]), /thinkingLevel must be/u);
});

test("configuration command bounds its session ID and name before any host action", () => {
	const id = "s".repeat(CONFIGURATION_LIMITS.sessionId);
	assert.equal(parseConfigurationArguments([id, "name"]).sessionId, id);
	assert.throws(() => parseConfigurationArguments([`${id}s`, "name"]), /sessionId must be/u);
	assert.throws(() => parseConfigurationArguments(["two sessions", "name"]), /one exact session ID/u);
	assert.throws(() => parseConfigurationArguments(["bad\n", "name"]), /sessionId must be/u);
	assert.throws(() => parseConfigurationArguments(["session", "name", "a".repeat(CONFIGURATION_LIMITS.name + 1)]), /name must be/u);
	for (const invalid of [null, 1, "bad\u0000id", "bad\ud800id"]) assert.throws(() => configurationSessionId(invalid), /sessionId must be/u);
	assert.throws(() => configurationSessionId(""), /one exact session ID/u);
});

test("configuration results bound older native values and identify every clipped field", () => {
	const state = { name: `${"x".repeat(255)}🧭`, model: `p/${"x".repeat(509)}🧭`, thinkingLevel: "high" as const };
	const result: ConfigurationResult = {
		sessionId: "session", outcome: "applied", before: { ...state }, beforeSource: "live", requested: { name: "new" },
		after: { ...state, name: "new" }, afterSource: "live",
		hookErrors: { count: 0, events: [], omitted: 0, observation: "snapshot" },
		persistence: { nativeWrites: "completed", fileExists: true, note: "not independently verified" },
	};
	const copy = structuredClone(result);
	const bounded = boundedConfigurationResult(result);
	assert.deepEqual(bounded.truncated, ["before.name", "before.model", "after.model"]);
	assert.equal(bounded.before.name.length, 255);
	assert.equal(bounded.before.model?.length, 511);
	assert.equal(bounded.after.name, "new");
	assert.doesNotMatch(bounded.before.name, /[\uD800-\uDFFF]/u);
	assert.doesNotMatch(bounded.before.model ?? "", /[\uD800-\uDFFF]/u);
	assert.deepEqual(result, copy);
});
