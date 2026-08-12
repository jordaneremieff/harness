import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	autoTabLabel,
	capName,
	classifyFallbackLabel,
	decideTabAction,
	firstMessageLabel,
	firstUserMessage,
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

describe("classifyFallbackLabel", () => {
	const options = { maxName: 60 };

	it("keeps an ordinary task sentence", () => {
		assert.equal(classifyFallbackLabel("Fix the retry loop in the socket client", options), "Fix the retry loop in the socket client");
	});

	it("strips a template prefix and keeps the work", () => {
		assert.equal(classifyFallbackLabel("Objective: harden the herdr client", options), "harden the herdr client");
		assert.equal(classifyFallbackLabel("Goal — ship the tab fallback", options), "ship the tab fallback");
		assert.equal(classifyFallbackLabel("Lane 3 — audit the socket layer", options), "audit the socket layer");
		assert.equal(classifyFallbackLabel("## Review the naming guards", options), "Review the naming guards");
		assert.equal(classifyFallbackLabel("Please review the naming guards", options), "review the naming guards");
	});

	it("rejects a slash command opener", () => {
		assert.equal(classifyFallbackLabel("/stash new herdr work", options), undefined);
	});

	it("rejects a markup opener", () => {
		assert.equal(classifyFallbackLabel("<task>do the thing</task>", options), undefined);
	});

	it("rejects a harness boilerplate opener", () => {
		assert.equal(classifyFallbackLabel("Resume the stashed effort in the artifact below.", options), undefined);
		assert.equal(classifyFallbackLabel("Reply with exactly: ready", options), undefined);
		assert.equal(classifyFallbackLabel("You are an expert reviewer. Check the diff.", options), undefined);
	});

	it("rejects a short single word and text without letters", () => {
		assert.equal(classifyFallbackLabel("hi", options), undefined);
		assert.equal(classifyFallbackLabel("continue", options), undefined);
		assert.equal(classifyFallbackLabel("12345678901234", options), undefined);
		assert.equal(classifyFallbackLabel("   ", options), undefined);
	});

	it("keeps a long single word", () => {
		assert.equal(classifyFallbackLabel("reconciliation", options), "reconciliation");
	});

	it("rejects a label already shown in the workspace", () => {
		const taken = ["Fix the retry loop"];
		assert.equal(classifyFallbackLabel("fix the retry loop", { maxName: 60, taken }), undefined);
		assert.equal(classifyFallbackLabel("Fix the timeout budget", { maxName: 60, taken }), "Fix the timeout budget");
	});

	it("caps a long opener", () => {
		const label = classifyFallbackLabel(`Objective: ${"a".repeat(200)}`, { maxName: 20 });
		assert.equal([...(label ?? "")].length, 20);
		assert.ok(label?.endsWith("…"));
	});

	it("strips control characters before judging the opener", () => {
		assert.equal(classifyFallbackLabel("Objective:\tbuild\nthe picker", options), "build the picker");
	});
});

describe("firstUserMessage", () => {
	it("reads the first textual user message in append order", () => {
		const entries = [
			{ type: "session" },
			{ type: "message", message: { role: "assistant", content: "hello" } },
			{ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "real work" }] } },
			{ type: "message", message: { role: "user", content: "later" } },
		];
		assert.equal(firstUserMessage(entries), "real work");
	});

	it("skips an empty user message", () => {
		const entries = [
			{ type: "message", message: { role: "user", content: "   " } },
			{ type: "message", message: { role: "user", content: "the real one" } },
		];
		assert.equal(firstUserMessage(entries), "the real one");
	});

	it("returns undefined for a session without user text", () => {
		assert.equal(firstUserMessage([{ type: "model_change" }]), undefined);
		assert.equal(firstMessageLabel([{ type: "model_change" }], { maxName: 60 }), undefined);
	});

	it("labels a resumed session from its entries", () => {
		const entries = [{ type: "message", message: { role: "user", content: "Objective: rebuild the index" } }];
		assert.equal(firstMessageLabel(entries, { maxName: 60 }), "rebuild the index");
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
