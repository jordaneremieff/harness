import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hostFacts, type HostAccessors } from "./host.ts";

const accessors: HostAccessors = {
	version: () => "fixture-version", packageDir: () => "/fixture/package", docsPath: () => "/fixture/docs",
	examplesPath: () => "/fixture/examples", readmePath: () => "/fixture/README.md", agentDir: () => "/fixture/agent",
	configDirName: () => ".fixture", pathExists: () => true,
};

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
