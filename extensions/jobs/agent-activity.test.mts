import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_LIST_LIMIT, ObservedAgentJobs } from "./agent-activity.ts";

function storage(id: number): string {
	return `00000000-0000-0000-0000-${String(id).padStart(12, "0")}`;
}

const item = { id: "12", label: "make\n docs", startedAt: 100, conversationId: 2 };
const event = (id: number, items: unknown[], sessionId = "here") => ({
	source: "jobs",
	sessionId,
	storageId: storage(id),
	items,
});

test("active jobs from separate hosts have distinct addresses; a replacement withdraws only its own rows", () => {
	const jobs = new ObservedAgentJobs();
	jobs.receive(event(0, [item], "other"));
	jobs.receive(event(1, [item]));
	jobs.bind("here");
	jobs.receive(event(2, [item]));
	jobs.receive(event(2, [item]));
	const rows = jobs.list();
	assert.equal(jobs.count, 2);
	assert.equal(new Set(rows.map(({ id }) => id)).size, 2);
	assert.deepEqual(
		rows.map(({ agent }) => agent?.identity),
		[`${storage(1)}:2`, `${storage(2)}:2`],
	);
	assert.equal(rows[0]?.commandPreview, "make docs");
	jobs.receive(event(1, []));
	jobs.receive(event(2, [], "other"));
	assert.equal(jobs.count, 1);
	assert.deepEqual(jobs.list(), rows.slice(1));
	jobs.bind("next");
	assert.equal(jobs.count, 0);
});

test("opening the list has a row budget without capping the footer count", () => {
	const jobs = new ObservedAgentJobs();
	jobs.bind("here");
	for (let id = 0; id < 256; id++) jobs.receive(event(id, [item]));
	assert.equal(jobs.count, 256);
	assert.equal(jobs.list().length, AGENT_LIST_LIMIT);
	for (let id = 0; id < 256; id++) jobs.receive(event(id, []));
	assert.equal(jobs.count, 0);
	assert.deepEqual(jobs.list(), []);
});
