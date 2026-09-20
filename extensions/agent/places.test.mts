import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PlaceBook } from "./places.ts";

function base(): string {
	return mkdtempSync(join(tmpdir(), "agent-places-"));
}

describe("place bindings", () => {
	it("resolves the longest matching area and keeps unrelated areas separate", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/project", "session-root");
			book.bind("/work/project/extensions/agent", "session-agent", "the agent slice");
			assert.equal(book.resolve("/work/project/README.md")?.sessionId, "session-root");
			assert.equal(book.resolve("/work/project/extensions/agent")?.sessionId, "session-agent");
			assert.equal(book.resolve("/work/project/extensions/agent/worker.ts")?.sessionId, "session-agent");
			assert.equal(book.resolve("/work/project-two/file.ts"), undefined);
			assert.equal(book.exact("/work/project/extensions")?.sessionId, undefined);
			assert.equal(book.resolve("/work/project/extensions/agent")?.topic, "the agent slice");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rebinds an area in place and unbinds it", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/area", "first");
			book.bind("/work/area", "second", "topic");
			assert.equal(book.read().length, 1);
			assert.equal(book.exact("/work/area")?.sessionId, "second");
			assert.equal(book.unbind("/work/area")?.sessionId, "second");
			assert.equal(book.unbind("/work/area"), undefined);
			assert.deepEqual(book.read(), []);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("persists bindings as readable JSON and survives a damaged file", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			book.bind("/work/area", "session-one");
			assert.deepEqual(JSON.parse(readFileSync(book.file, "utf8")).places[0].sessionId, "session-one");
			writeFileSync(book.file, "{ not json", "utf8");
			assert.deepEqual(book.read(), []);
			assert.equal(book.resolve("/work/area"), undefined);
			book.bind("/work/area", "session-two");
			assert.equal(book.exact("/work/area")?.sessionId, "session-two");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops records that are not bindings", () => {
		const root = base();
		try {
			const book = new PlaceBook(root);
			writeFileSync(
				book.file,
				JSON.stringify({ places: [{ area: "/work/area", sessionId: "ok", boundAt: "2026-01-01T00:00:00.000Z" }, { area: "/work/other" }, null] }),
				"utf8",
			);
			assert.deepEqual(
				book.read().map((binding) => binding.sessionId),
				["ok"],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
