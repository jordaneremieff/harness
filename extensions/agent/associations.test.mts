import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ASSOCIATION_ENTRY, associatedSessions, associationReaches, type AssociationEntry } from "./associations.ts";

function relation(parentSessionId: string, childSessionId: string, attached = true, previousSessionId?: string): AssociationEntry {
	return { version: 1, parentSessionId, storeRoot: "/store", childSessionId, attached, ...(previousSessionId ? { previousSessionId } : {}) };
}

test("associations use exact parent identity and store scope across all native branches", () => {
	const native = SessionManager.inMemory();
	const parent = native.getSessionId();
	const branch = native.appendCustomEntry("branch", {});
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "child"));
	native.branch(branch);
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "shared"));
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "child"));
	assert.deepEqual([...associatedSessions(native.getEntries(), parent, "/store")], ["child", "shared"]);
	assert.equal(associatedSessions(native.getEntries(), "fork", "/store").size, 0);
	assert.equal(associatedSessions(native.getEntries(), parent, "/other-store").size, 0);
	assert.equal(native.buildSessionContext().messages.length, 0, "ownership entries do not enter model context");
});

test("replacement and detach update the current association without replay instructions", () => {
	const native = SessionManager.inMemory();
	const parent = native.getSessionId();
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "old"));
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "new", true, "old"));
	assert.deepEqual([...associatedSessions(native.getEntries(), parent, "/store")], ["new"]);
	native.appendCustomEntry(ASSOCIATION_ENTRY, relation(parent, "new", false));
	assert.equal(associatedSessions(native.getEntries(), parent, "/store").size, 0);
});

test("malformed current associations do not acquire ownership", () => {
	const native = SessionManager.inMemory();
	const parent = native.getSessionId();
	for (const data of [null, [], "invalid", {}, { ...relation(parent, "child"), version: 2 }, { ...relation(parent, "" ) }, { ...relation(parent, "child"), attached: "yes" }, relation(parent, "child", false, "old")]) native.appendCustomEntry(ASSOCIATION_ENTRY, data);
	assert.equal(associatedSessions(native.getEntries(), parent, "/store").size, 0);
});

test("graph traversal deduplicates shared children and stops at cycles", () => {
	const graph = new Map([["root", ["left", "right"]], ["left", ["shared"]], ["right", ["shared"]], ["shared", ["root"]]]);
	let reads = 0;
	const children = (id: string) => { reads++; return graph.get(id) ?? []; };
	assert.equal(associationReaches("root", "missing", children), false);
	assert.equal(reads, 4);
	assert.equal(associationReaches("shared", "root", children), true);
});
