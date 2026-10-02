import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, turn } from "./dashboard-test-fixture.mts";
it("key dispatch and render do not read sources or start hosts", async () => {
	let reads = 0;
	const observed = source(Array.from({ length: 100 }, (_, index) => row(String(index))));
	const list = observed.list;
	observed.list = async (input) => {
		reads++;
		return list(input);
	};
	let snapshots = 0;
	const snapshot = observed.snapshot;
	observed.snapshot = async (id) => {
		snapshots++;
		return snapshot(id);
	};
	const f = fixture(140, 45, observed);
	await turn();
	const count = reads;
	const selected = snapshots;
	for (let index = 0; index < 100; index++) f.ui.render(140);
	assert.equal(reads, count);
	assert.equal(snapshots, selected);
	f.ui.handleInput("?");
	f.ui.render(140);
	f.ui.handleInput("\x1b");
	assert.equal(reads, count);
	assert.equal(snapshots, selected);
	f.ui.dispose();
});

it("selection reads follow key dispatch instead of blocking it", async () => {
	const observed = source([row("one"), row("two")]);
	let reads = 0;
	const read = observed.snapshot;
	observed.snapshot = async (id) => {
		reads++;
		return read(id);
	};
	const f = fixture(80, 24, observed);
	await turn();
	const count = reads;
	f.ui.handleInput("\x1b[B");
	assert.equal(f.state.selected, "two");
	assert.equal(reads, count);
	await turn();
	assert.equal(reads, count + 1);
	f.ui.dispose();
});
