import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostFacts, readContext, type HostAccessors } from "./host.ts";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const accessors: HostAccessors = {
	version: () => "fixture-version", packageDir: () => "/fixture/package", docsPath: () => "/fixture/docs",
	examplesPath: () => "/fixture/examples", readmePath: () => "/fixture/README.md", agentDir: () => "/fixture/agent",
	configDirName: () => ".fixture", pathExists: () => true,
};

describe("live context facts", () => {
	const context = (usage: unknown) => ({ model: { provider: "fixture", id: "model" }, thinkingLevel: "high",
		getContextUsage: () => usage }) as ExtensionContext;
	it("preserves zero, overflow, timestamp, and the host estimate without deriving a budget", () => {
		for (const [tokens, percent] of [[0, 0], [12000, 120]]) {
			assert.deepEqual(readContext(context({ tokens, percent, contextWindow: 10000 }), 123), {
				at: 123, evidence: "host_estimate", state: "available", model: "fixture/model", thinkingLevel: "high",
				tokens, percent, contextWindow: 10000,
			});
		}
	});
	it("distinguishes post-compaction unknown usage from absent and failed accessors", () => {
		assert.equal(readContext(context({ tokens: null, percent: null, contextWindow: 10000 }), 1).state, "unknown");
		assert.equal(readContext(context(undefined), 1).state, "unavailable");
		const ctx = context(undefined);
		ctx.getContextUsage = () => { throw new Error("private-error"); };
		assert.equal(readContext(ctx, 1).state, "unavailable");
		assert.doesNotMatch(JSON.stringify(readContext(ctx, 1)), /private-error/);
	});
	it("rejects invalid numeric estimates without a fabricated zero", () => {
		for (const usage of [{ tokens: NaN, percent: 1, contextWindow: 1000 },
			{ tokens: -1, percent: 1, contextWindow: 1000 }, { tokens: 1, percent: Infinity, contextWindow: 1000 },
			{ tokens: 1, percent: 1, contextWindow: 0 }]) {
			const result = readContext(context(usage), 1);
			assert.equal(result.state, "unavailable");
			assert.equal(result.tokens, null);
			assert.equal(result.percent, null);
		}
	});
});

describe("host facts", () => {
	it("uses only explicit session facts and public accessors", () => {
		const facts = hostFacts({ cwd: "/fixture/work", mode: "json", hasUI: false, projectTrusted: false }, accessors);
		assert.equal(facts.find((f) => f.key === "installedVersion")?.value, "fixture-version");
		assert.equal(facts.find((f) => f.key === "cwd")?.value, "/fixture/work");
		assert.equal(facts.find((f) => f.key === "projectTrusted")?.value, "false");
		assert.match(facts.find((f) => f.key === "agentDirDefault")?.note ?? "", /embedding-configured/);
	});
	it("distinguishes session file presence, ephemeral sessions, and unknown accessors", () => {
		assert.equal(hostFacts({ sessionId: "session", sessionFile: "/fixture/session.jsonl" }, accessors).find((f) => f.key === "sessionId")?.value, "session");
		assert.equal(hostFacts({ sessionFile: "/fixture/session.jsonl" }, accessors).find((f) => f.key === "sessionFile")?.value, "/fixture/session.jsonl");
		assert.equal(hostFacts({ sessionFile: null }, accessors).find((f) => f.key === "sessionFile")?.value, "(ephemeral)");
		assert.equal(hostFacts({}, accessors).find((f) => f.key === "sessionFile")?.value, null);
	});
	it("leaves absent or failed facts unavailable instead of inferring paths or versions", () => {
		const facts = hostFacts({}, { ...accessors, version: () => { throw new Error("unavailable"); }, docsPath: () => "" });
		for (const key of ["cwd", "mode", "hasUI", "projectTrusted", "installedVersion", "docsPath"]) {
			assert.equal(facts.find((f) => f.key === key)?.value, null);
		}
	});
});
