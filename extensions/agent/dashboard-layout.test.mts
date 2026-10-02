import assert from "node:assert/strict";
import { it } from "node:test";
import { visibleWidth, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { fixture, source, row, turn } from "./dashboard-test-fixture.mts";
import { fitHints } from "./dashboard-layout.ts";
it("each surface occupies the exact terminal rectangle and keeps Esc last", async () => {
	for (const [width, height] of [
		[140, 45],
		[80, 24],
	]) {
		const f = fixture(
			width,
			height,
			source(Array.from({ length: 100 }, (_, index) => row(String(index), { name: "界🙂".repeat(60) }))),
		);
		await turn();
		for (const key of ["", "\t", "\x1b", "\r", "\x1b", "a", "\x1b", "?", "\x1b", "/", "\x1b", "n"]) {
			if (key) f.ui.handleInput(key);
			const lines = f.ui.render(width);
			assert.equal(lines.length, height, key);
			assert.ok(
				lines.every((line) => visibleWidth(line) <= width),
				key,
			);
			assert.match(lines.at(-1) ?? "", /Esc/);
		}
		f.ui.handleInput("first\nsecond\nthird\nfourth\nfifth\nsixth\nseventh\neighth");
		const lines = f.ui.render(width);
		assert.equal(lines.length, height);
		assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
		f.ui.dispose();
	}
	assert.match(fitHints(["one", "two", "three"], "Esc back", 12), /Esc back/);
});
