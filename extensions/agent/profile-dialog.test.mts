import assert from "node:assert/strict";
import { it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { profileCommand, profileText } from "./profile-dialog.ts";
import type { AgentProfile } from "./profile-schema.ts";

const profile: AgentProfile = {
	identity: "retained-storage", handle: "@history", name: "History expert", role: "Study decisions and their sources", expertise: "Sourced fact: reference.md, 2026-01-01",
	revision: "a".repeat(64), updatedAt: 1, updatedBy: "editor", creator: "founder", model: { provider: "fixture", modelId: "model" }, thinkingLevel: "high", cwd: "/workspace", live: false,
	requests: [{ requestId: "request", requester: "second-requester", replyTo: "third-recipient", origin: "model", status: "placed" }],
};

it("profile text separates identity, provenance, current routes, and saved expertise as evidence", () => {
	const text = profileText(profile);
	for (const value of [profile.identity, "@history", "History expert", profile.role, "fixture/model", "high", "founder", "second-requester", "third-recipient", profile.revision]) assert.ok(text.includes(value), value);
	assert.match(text, /Retained; no host started/);
	assert.match(text, /Saved expertise \(evidence, not fresh authority\):\nSourced fact: reference.md/);
	assert.ok(text.indexOf("Request routes:") < text.indexOf("Saved expertise"), "routes precede the saved expertise");
	assert.match(profileText({ ...profile, model: null, requests: [] }), /Model: Unknown[\s\S]*earlier requester evidence is unknown/);
});

it("profile text names unsaved drafts and a revision conflict without presenting them as saved", () => {
	const text = profileText(profile, { expectedRevision: "b".repeat(64), role: "Draft role", expertise: "Draft expertise" });
	assert.match(text, /Draft role \(not saved\): Draft role/);
	assert.match(text, /Draft expertise \(not saved\):\nDraft expertise/);
	assert.match(text, /Conflict: draft retained/);
	assert.doesNotMatch(profileText(profile, { expectedRevision: profile.revision }), /not saved|Conflict/);
});

it("profile reports omitted routes without calling a partial list empty", () => {
	for (const requests of [profile.requests, []]) {
		const complete = { ...profile, requests };
		assert.doesNotMatch(profileText(complete), /omitted from this profile/);
		assert.equal(profileText({ ...complete, requestsOmitted: 0 }), profileText(complete));
		for (const requestsOmitted of [1, 7]) {
			const text = profileText({ ...complete, requestsOmitted });
			assert.ok(text.includes(`${requestsOmitted} additional request route${requestsOmitted === 1 ? "" : "s"} omitted from this profile.`));
			assert.doesNotMatch(text, /No retained active request routes/);
			if (requests.length) assert.ok(text.indexOf("additional request route") < text.indexOf(`${requests[0].requestId} ·`), "coverage precedes the bounded list");
		}
	}
});

it("the profile command returns the full profile text with its omission count", async () => {
	const ctx = { hasUI: false, mode: "print" } as unknown as ExtensionContext;
	const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
	const result = await profileCommand(async (method, input) => {
		calls.push({ method, input });
		return { ...profile, requestsOmitted: 1 };
	}).run([profile.identity], ctx);
	assert.deepEqual(calls, [{ method: "profile-read", input: { sessionId: profile.identity } }]);
	assert.match(String(result), /1 additional request route omitted from this profile\./);
	assert.match(String(result), /Sourced fact: reference\.md/);
	assert.equal(await profileCommand(async () => profile).run([profile.identity], ctx), profileText(profile));
});

it("the profile command refuses a malformed profile instead of rendering it", async () => {
	const ctx = { hasUI: false, mode: "print" } as unknown as ExtensionContext;
	await assert.rejects(profileCommand(async () => ({ identity: "x" })).run(["x"], ctx), /Invalid profile response/);
});
