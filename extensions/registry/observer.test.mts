import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	MAX_OBSERVED_BYTES,
	MAX_OBSERVED_RECORDS,
	ObservationStore,
	retainedBytes,
	type ObservableOptions,
} from "./observer.ts";

const sourceInfo = {
	path: "/skills/one/SKILL.md",
	source: "package",
	scope: "user" as const,
	origin: "package" as const,
	baseDir: "/skills/one",
};

function options(over: Partial<ObservableOptions> = {}): ObservableOptions {
	return {
		cwd: "/work",
		customPrompt: "custom",
		appendSystemPrompt: "appended",
		selectedTools: ["read", "bash"],
		contextFiles: [{ path: "/work/AGENTS.md", content: "secret contents that must never be retained" }],
		skills: [
			{
				name: "one",
				filePath: "/skills/one/SKILL.md",
				baseDir: "/skills/one",
				disableModelInvocation: true,
				sourceInfo: { ...sourceInfo },
			},
		],
		...over,
	};
}

describe("observation copying", () => {
	it("returns null until an observation happens, which is not an empty observation", () => {
		const store = new ObservationStore();
		assert.equal(store.snapshot(), null);
		store.observe({ selectedTools: [] }, 10);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.selectedTools.length, 0);
		assert.equal(snapshot.observedAt, 10);
	});

	it("copies only the specified metadata and never prompt or context contents", () => {
		const store = new ObservationStore();
		store.observe(options(), 1);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.deepEqual(snapshot.contextFilePaths, ["/work/AGENTS.md"]);
		assert.deepEqual(snapshot.selectedTools, ["read", "bash"]);
		assert.equal(snapshot.customPromptPresent, true);
		assert.equal(snapshot.appendSystemPromptPresent, true);
		assert.equal(snapshot.skills[0].disableModelInvocation, true);
		const serialized = JSON.stringify(snapshot);
		assert.ok(!serialized.includes("secret contents"), "context-file content is not retained");
		assert.ok(!serialized.includes("appended"), "appended prompt text is not retained");
		assert.ok(!serialized.includes('"custom"'), "custom prompt text is not retained");
	});

	it("copies the skill record instead of aliasing the caller's object", () => {
		const store = new ObservationStore();
		const input = options();
		store.observe(input, 1);
		input.skills![0].sourceInfo.path = "/mutated";
		input.skills![0].name = "mutated";
		assert.equal(store.snapshot()?.skills[0].sourceInfo.path, "/skills/one/SKILL.md");
		assert.equal(store.snapshot()?.skills[0].name, "one");
	});

	it("clears on reset so observations never cross a session boundary", () => {
		const store = new ObservationStore();
		store.observe(options(), 1);
		store.clear();
		assert.equal(store.snapshot(), null);
	});
});

describe("observation bounds", () => {
	it("stops at the record bound and reports overflow", () => {
		const store = new ObservationStore();
		const tools = Array.from({ length: MAX_OBSERVED_RECORDS + 25 }, (_, i) => `tool-${i}`);
		store.observe({ cwd: "/w", selectedTools: tools }, 1);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.selectedTools.length, MAX_OBSERVED_RECORDS);
		assert.equal(snapshot.recordCount, MAX_OBSERVED_RECORDS);
		assert.equal(snapshot.overflowRecords, true);
	});

	it("bounds the retained snapshot itself, not the sum of field values", () => {
		const store = new ObservationStore();
		const big = "x".repeat(4096);
		const tools = Array.from({ length: 400 }, (_, i) => `${big}-${i}`);
		store.observe({ cwd: "/w", selectedTools: tools }, 1);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.overflowBytes, true);
		assert.ok(snapshot.selectedTools.length < 400);
		assert.ok(
			retainedBytes(snapshot) <= MAX_OBSERVED_BYTES,
			`serialized snapshot ${retainedBytes(snapshot)} exceeds ${MAX_OBSERVED_BYTES}`,
		);
	});

	it("charges an oversized cwd to the same budget and keeps the snapshot within it", () => {
		const store = new ObservationStore();
		store.observe({ cwd: "/".padEnd(MAX_OBSERVED_BYTES + 4096, "c"), selectedTools: ["read"] }, 1);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.cwd, "");
		assert.equal(snapshot.overflowBytes, true);
		assert.ok(retainedBytes(snapshot) <= MAX_OBSERVED_BYTES);
	});

	it("settles a cwd-only snapshot near the exact serialized bound", () => {
		const store = new ObservationStore();
		store.observe({ cwd: "" }, 1);
		const overhead = retainedBytes(store.snapshot());
		for (let delta = -8; delta <= 8; delta += 1) {
			store.observe({ cwd: "x".repeat(MAX_OBSERVED_BYTES - overhead + delta) }, 1);
			assert.ok(retainedBytes(store.snapshot()) <= MAX_OBSERVED_BYTES);
			assert.equal(store.snapshot()?.bytes, retainedBytes(store.snapshot()));
		}
	});

	it("charges escaping and UTF-8 overhead against the snapshot bound", () => {
		const store = new ObservationStore();
		store.observe({ selectedTools: Array.from({ length: 1000 }, () => '\\n"漢'.repeat(100)) }, 1);
		assert.ok(retainedBytes(store.snapshot()) <= MAX_OBSERVED_BYTES);
		assert.equal(store.snapshot()?.overflowBytes, true);
	});

	it("keeps the recorded byte count consistent with the bound it reports", () => {
		const store = new ObservationStore();
		store.observe(options(), 1);
		const snapshot = store.snapshot();
		assert.ok(snapshot);
		assert.equal(snapshot.bytes, retainedBytes(snapshot));
		assert.ok(snapshot.bytes <= MAX_OBSERVED_BYTES);
	});
});
