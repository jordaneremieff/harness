import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	autoTabLabel,
	capName,
	composeBorderLabel,
	decideTabAction,
	sanitizeName,
} from "./naming.ts";

describe("sanitizeName", () => {
	it("strips control characters and collapses whitespace", () => {
		assert.equal(sanitizeName("  fix\tauth\nflow \u0000 "), "fix auth flow");
		assert.equal(sanitizeName("one\u001Ftwo"), "one two");
	});
});

describe("capName", () => {
	it("keeps names at or under the cap", () => {
		assert.equal(capName("short", 60), "short");
		assert.equal(capName("x".repeat(60), 60), "x".repeat(60));
	});
	it("truncates with an ellipsis suffix", () => {
		const capped = capName("a".repeat(80), 60);
		assert.equal([...capped].length, 60);
		assert.ok(capped.endsWith("…"));
	});
	it("counts astral characters as one", () => {
		assert.equal(capName("🙂🙂🙂", 2), "🙂…");
	});
	it("supports a one-character cap", () => {
		assert.equal(capName("alpha", 1), "a");
	});
});

describe("composeBorderLabel", () => {
	it("composes name and model", () => {
		assert.equal(composeBorderLabel("auth refactor", "Opus"), "auth refactor · Opus");
	});
	it("falls back to the agent kind when unnamed", () => {
		assert.equal(composeBorderLabel(undefined, "Opus"), "pi · Opus");
		assert.equal(composeBorderLabel(undefined, undefined), "pi");
		assert.equal(composeBorderLabel("auth", undefined), "auth");
	});
});

describe("decideTabAction", () => {
	const tabs = [
		{ tabId: "w1:t1", label: "1" },
		{ tabId: "w1:t2", label: "2" },
	];

	it("renames an auto-named tab", () => {
		const action = decideTabAction({ name: "alpha", tabId: "w1:t1", tabs, registryLabel: undefined });
		assert.deepEqual(action, { type: "rename", label: "alpha", registry: "alpha" });
	});

	it("computes the auto label from the display position", () => {
		assert.equal(autoTabLabel(1), "2");
		const moved = [{ tabId: "w1:t9", label: "1" }];
		const action = decideTabAction({ name: "alpha", tabId: "w1:t9", tabs: moved, registryLabel: undefined });
		assert.deepEqual(action, { type: "rename", label: "alpha", registry: "alpha" });
	});

	it("does nothing for an unnamed session on an auto tab", () => {
		const action = decideTabAction({ name: undefined, tabId: "w1:t1", tabs, registryLabel: undefined });
		assert.deepEqual(action, { type: "none", registry: undefined });
	});

	it("leaves a tab it cannot find untouched", () => {
		const action = decideTabAction({ name: "alpha", tabId: "w9:t9", tabs, registryLabel: "alpha" });
		assert.deepEqual(action, { type: "none", registry: "alpha" });
	});

	it("follows the name on a tab it owns", () => {
		const owned = [{ tabId: "w1:t1", label: "alpha" }];
		const action = decideTabAction({ name: "beta", tabId: "w1:t1", tabs: owned, registryLabel: "alpha" });
		assert.deepEqual(action, { type: "rename", label: "beta", registry: "beta" });
	});

	it("is quiet when the name it owns is unchanged", () => {
		const owned = [{ tabId: "w1:t1", label: "alpha" }];
		const action = decideTabAction({ name: "alpha", tabId: "w1:t1", tabs: owned, registryLabel: "alpha" });
		assert.deepEqual(action, { type: "none", registry: "alpha" });
	});

	it("restores the current numeric label when the name clears", () => {
		const owned = [{ tabId: "w1:t1", label: "alpha" }];
		const action = decideTabAction({ name: undefined, tabId: "w1:t1", tabs: owned, registryLabel: "alpha" });
		assert.deepEqual(action, { type: "restore", label: "1", registry: undefined });
	});

	it("forgets a tab the user renamed away from its label", () => {
		const userNamed = [{ tabId: "w1:t1", label: "keep-me" }];
		const action = decideTabAction({ name: "beta", tabId: "w1:t1", tabs: userNamed, registryLabel: "alpha" });
		assert.deepEqual(action, { type: "none", registry: undefined });
	});

	it("never touches a manual label it does not own", () => {
		const manual = [{ tabId: "w1:t1", label: "deploy" }];
		const action = decideTabAction({ name: "alpha", tabId: "w1:t1", tabs: manual, registryLabel: undefined });
		assert.deepEqual(action, { type: "none", registry: undefined });
	});

	it("adopts a tab that already shows the session name", () => {
		const restored = [{ tabId: "w1:t1", label: "alpha" }];
		const action = decideTabAction({ name: "alpha", tabId: "w1:t1", tabs: restored, registryLabel: undefined });
		assert.deepEqual(action, { type: "none", registry: "alpha" });
	});
});
