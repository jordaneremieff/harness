import assert from "node:assert/strict";
import { it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { Harness, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { AgentMetaDoc, writeConversationName } from "./durable-controls.ts";
import { initializeProfile, readProfile, updateProfile, projectProfiles, profileText } from "./profile.ts";
import { handleSlug, handleStorageId } from "./identity.ts";

const context = BACKGROUND_CONTEXT;
async function fixture(t: { after(fn: () => Promise<void>): void }) {
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, context);
	t.after(() => harness.close(context));
	const storageId = handleStorageId("history", process.cwd());
	const root = await harness.root(context, { init: async (tx, id) => {
		const meta = await tx.doc(AgentMetaDoc, id);
		meta.name = "History"; meta.owner = "requester-a";
		await initializeProfile(tx, id, storageId, { handle: "history", role: "Find sourced intent" });
	} });
	return { harness, root, storageId, read: () => readProfile(harness, storageId, root.id, context, true) };
}

it("uses a deterministic concern address independent of mutable display fields", () => {
	assert.equal(handleStorageId("history", process.cwd()), handleStorageId("history", process.cwd()));
	assert.notEqual(handleStorageId("history", process.cwd()), handleStorageId("architecture", process.cwd()));
	for (const bad of ["", "History", "@history", "a--b", "a-", "-a", "a/b", "a b", "a".repeat(65)]) assert.throws(() => handleSlug(bad));
});
it("updates native profile and identity instructions atomically without a model turn", async (t) => {
	const f = await fixture(t);
	const first = await f.read();
	assert.equal(first.handle, "@history");
	assert.match((await f.root.agent(context)).instructions ?? "", new RegExp(f.storageId));
	const change = { expectedRevision: first.revision, role: "Inspect current sources", expertise: "Claim: fixture fact. Source: fixture v1; scope: one record.", requestId: "update-one", senderIdentity: "requester-b" };
	const result = await updateProfile(f.harness, f.storageId, f.root.id, change, context);
	assert.equal(result.outcome, "applied");
	assert.equal(result.profile.creator, "requester-a");
	assert.equal(result.profile.updatedBy, "requester-b");
	assert.match((await f.root.agent(context)).instructions ?? "", /Inspect current sources/u);
	assert.doesNotMatch((await f.root.agent(context)).instructions ?? "", /fixture fact/u);
	assert.equal((await updateProfile(f.harness, f.storageId, f.root.id, change, context)).deduped, true);
	await assert.rejects(updateProfile(f.harness, f.storageId, f.root.id, { ...change, expertise: "changed" }, context), /different update/u);
	const conflict = await updateProfile(f.harness, f.storageId, f.root.id, { ...change, requestId: "different", expertise: "wrong" }, context);
	assert.equal(conflict.outcome, "conflict");
	assert.equal(conflict.profile.expertise, change.expertise);
	assert.equal((await f.harness.inspect(context)).tasks.length, 0);
});
it("retains profile across reset and keeps a rename true in native instructions", async (t) => {
	const f = await fixture(t);
	const initial = await f.read();
	await updateProfile(f.harness, f.storageId, f.root.id, { expectedRevision: initial.revision, expertise: "Source: retained fixture", requestId: "knowledge", senderIdentity: f.storageId }, context);
	await writeConversationName(f.root, "Session archive", context);
	assert.match((await f.root.agent(context)).instructions ?? "", /Session archive/u);
	await f.root.reset(undefined, context);
	const profile = await f.read();
	assert.equal(profile.expertise, "Source: retained fixture");
	assert.equal(profile.name, "Session archive");
	assert.equal(profile.handle, "@history");
});
it("bounds expertise bytes and qualifies Unicode-safe shortened role hints", async (t) => {
	assert.throws(() => profileText("x".repeat(16385), "expertise"));
	assert.throws(() => profileText("\ud800", "role"));
	const f = await fixture(t);
	const profile = await f.read();
	await updateProfile(f.harness, f.storageId, f.root.id, { expectedRevision: profile.revision, role: "😀".repeat(321), requestId: "long-role", senderIdentity: f.storageId }, context);
	const hints = await projectProfiles(f.harness, f.storageId, [f.root.id], context);
	assert.equal(hints.coverage.complete, false);
	assert.equal([...hints.rows[0].role].length, 320);
	assert.doesNotMatch(hints.rows[0].role, /[\ud800-\udfff]/u);
});
