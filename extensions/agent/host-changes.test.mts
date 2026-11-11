import assert from "node:assert/strict";
import { it } from "node:test";
import { parseHostChanges } from "./host-changes.ts";

it("change frames bind the bounded publication to its current generation and storage", () => {
	const view = { storageId: "storage", updatedAt: "2026-01-01T00:00:00.000Z", rows: [], coverage: { complete: true, omitted: 0 } };
	assert.deepEqual(parseHostChanges({ revision: 0, writerId: "writer", view }, "writer", "storage"), { revision: 0, writerId: "writer", view });
	assert.deepEqual(parseHostChanges({ revision: 0, writerId: "writer" }, "writer", "storage"), { revision: 0, writerId: "writer" });
	for (const value of [{ revision: 0 }, { revision: 0, writerId: "previous", view }, { revision: -1, writerId: "writer" }, { revision: 0, writerId: "writer", pid: 1 }, { revision: 0, writerId: "writer", view: { ...view, storageId: "other" } }, { revision: 0, writerId: "writer", view: { ...view, updatedAt: "bad" } }])
		assert.throws(() => parseHostChanges(value, "writer", "storage"));
});
