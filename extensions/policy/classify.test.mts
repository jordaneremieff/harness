import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AgentRules } from "./agent-rules.ts";
import { bindAgentRules, captureFor, classify, classifyCaptured, notesFor, redactFor } from "./classify.ts";

afterEach(() => bindAgentRules(null));

describe("captureFor", () => {
	it("returns the text the owning domain declares", () => {
		assert.equal(captureFor("bash", { command: "ls -R ." }), "ls -R .");
	});

	it("returns nothing for a tool no domain owns", () => {
		assert.equal(captureFor("read", { path: "/etc/hosts" }), undefined);
	});

	it("returns nothing when the declared field has another type", () => {
		assert.equal(captureFor("bash", { command: 7 }), undefined);
		assert.equal(captureFor("bash", {}), undefined);
	});
});

describe("classify", () => {
	it("dispatches to the domain that owns the tool", () => {
		assert.deepEqual(classify("bash", { command: "cat notes.md" }), ["routing.cat-read"]);
	});

	it("returns no class for a tool no domain owns", () => {
		assert.deepEqual(classify("write", { path: "/tmp/x", content: "cat notes.md" }), []);
	});

	it("returns no class when the domain captures nothing", () => {
		assert.deepEqual(classify("bash", { timeout: 5 }), []);
	});
});

describe("redactFor", () => {
	it("applies the owning domain's redaction", () => {
		assert.equal(redactFor("bash", "TOKEN=abcdef cat x"), "TOKEN=[redacted] cat x");
	});

	it("keeps an unowned tool's capture unchanged", () => {
		const opaque = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.signature";
		assert.equal(redactFor("read", opaque), opaque);
	});
});

describe("agent rule composition", () => {
	it("merges agent classes with built-in classes and passes the model to scope", async () => {
		const rules = new AgentRules(await mkdtemp(join(tmpdir(), "policy-classify-")));
		assert.equal(
			await rules.add({
				slug: "scoped-cat",
				note: "Avoid this cat shape.",
				match: { tool: "bash", command: "cat" },
				scope: { providers: ["xai"] },
				state: "active",
				model: "xai/grok-4.6",
				session: "s1",
				at: "2026-09-01T07:00:00Z",
			}),
			null,
		);
		bindAgentRules(rules);
		assert.deepEqual(classifyCaptured("bash", "cat notes.md", "xai/grok-4.6"), [
			"agent.scoped-cat",
			"routing.cat-read",
		]);
		assert.deepEqual(classifyCaptured("bash", "cat notes.md", "anthropic/claude"), ["routing.cat-read"]);
	});

	it("falls back to agent guidance when the domain has no built-in note", async () => {
		const rules = new AgentRules(await mkdtemp(join(tmpdir(), "policy-classify-")));
		await rules.add({
			slug: "custom",
			note: "Use the reviewed form.",
			match: { tool: "bash", command: "git" },
			state: "active",
			model: "xai/grok-4.6",
			session: "s1",
			at: "2026-09-01T07:00:00Z",
		});
		bindAgentRules(rules);
		assert.deepEqual(notesFor("bash", ["routing.cat-read", "agent.custom"]), [
			"Use the read tool for file contents.",
			"Use the reviewed form.",
		]);
	});
});

describe("notesFor", () => {
	it("returns guidance in the order the ids are given", () => {
		const notes = notesFor("bash", ["form.env-grep", "routing.cat-read"]);
		assert.equal(notes.length, 2);
		assert.match(notes[0], /printenv/);
		assert.match(notes[1], /read tool/);
	});

	it("returns one line for ids that share wording", () => {
		assert.deepEqual(
			notesFor("bash", ["bounds.du-uncapped", "bounds.find-output-uncapped"]),
			notesFor("bash", ["bounds.du-uncapped"]),
		);
	});

	it("skips an unknown id and an unowned tool", () => {
		assert.deepEqual(notesFor("bash", ["routing.no-such-rule"]), []);
		assert.deepEqual(notesFor("read", ["routing.cat-read"]), []);
	});
});
