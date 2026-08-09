import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { computePanes, StashPanel } from "./panel.ts";
import type { StashEntry } from "./store.ts";

const theme: never = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as never;

function entry(id: string, title: string, preview: string, overrides: Partial<StashEntry> = {}): StashEntry {
	return {
		meta: {
			id,
			title,
			created: "20260724T120000Z",
			project: "/tmp/project",
			branch: "main",
			sessionId: "session-1",
			tags: ["continuity"],
			state: "open",
		},
		path: `/tmp/${id}.md`,
		preview,
		previewTruncated: false,
		...overrides,
	};
}

function rig(
	entries: StashEntry[],
	rows = 20,
	initialFilter = "",
	hasMore = false,
	copyResume?: (selected: StashEntry) => Promise<void>,
	initialSelectedId?: string,
	initialSelectedIndex?: number,
) {
	const calls = { renders: 0, done: undefined as unknown, copies: [] as string[] };
	const panel = new StashPanel({
		entries,
		title: "Stashes",
		theme,
		tui: { requestRender: () => calls.renders++ },
		getMaxRows: () => rows,
		hasMore,
		initialFilter,
		initialSelectedId,
		initialSelectedIndex,
		copyResume: copyResume ?? (async (selected) => {
			calls.copies.push(selected.meta.id);
		}),
		done: (result) => {
			calls.done = result;
		},
	});
	return { panel, calls };
}

function samples(): StashEntry[] {
	return [
		entry("20260724T120000Z-new", "New work", "# New work\n\nLatest state."),
		entry(
			"20260724T110000Z-long",
			"Long work",
			Array.from({ length: 30 }, (_, i) => `preview line ${i + 1}`).join("\n"),
			{
				meta: {
					id: "20260724T110000Z-long",
					title: "Long work",
					created: "20260724T110000Z",
					tags: ["release"],
					state: "active",
					activatedAt: "20260724T113000Z",
				},
			},
		),
	];
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("StashPanel", () => {
	it("renders a bordered two-pane list and Markdown preview", () => {
		const markdown = entry("markdown", "Markdown", "## Rendered heading\n\n- **important** item");
		const { panel } = rig([markdown]);
		const lines = panel.render(104);
		const rendered = lines.join("\n");
		assert.match(rendered, /^┌─ ✦ Stashes/m);
		assert.match(rendered, /› ○ 2026-07-24 Markdown\s+│/);
		assert.match(rendered, /\/tmp\/project/);
		assert.match(rendered, /session: session-1/);
		assert.match(rendered, /file: \/tmp\/markdown\.md/);
		assert.match(rendered, /Rendered heading/);
		assert.doesNotMatch(rendered, /## Rendered heading/);
		assert.match(rendered, /- important item/);
		for (const line of lines) assert.equal(visibleWidth(line), 104);
		assert.match(rig(samples(), 20, "", true).panel.render(104).join("\n"), /1\/2\+/);
		assert.deepEqual(computePanes(100), { listWidth: 36, previewWidth: 61 });
	});

	it("uses an explicit filter mode so action keys remain available", () => {
		const { panel, calls } = rig(samples());
		panel.handleInput("/");
		for (const char of "continuity") panel.handleInput(char);
		assert.match(panel.render(104).join("\n"), /filter continuity▌.*1 match/);
		assert.match(panel.render(104).join("\n"), /New work/);
		panel.handleInput("\x1b");
		assert.equal(calls.done, undefined);
		assert.match(panel.render(104).join("\n"), /New work/);
		panel.handleInput("\x1b");
		assert.equal((calls.done as any).filter, "continuity");
		assert.equal((calls.done as any).selectedId, samples()[0].meta.id);
	});

	it("selects pickup on enter and opens lifecycle actions on tab", async () => {
		const first = rig(samples());
		first.panel.handleInput("\x1b[B");
		first.panel.handleInput("\r");
		await flush();
		assert.equal((first.calls.done as any).selected.meta.id, samples()[1].meta.id);
		assert.equal((first.calls.done as any).selectedId, samples()[1].meta.id);
		assert.equal((first.calls.done as any).selectedIndex, 1);

		const second = rig(samples());
		second.panel.handleInput("\t");
		assert.equal((second.calls.done as any).manage.meta.id, samples()[0].meta.id);
	});

	it("copies a resume command in place and opens completion directly for an active stash", async () => {
		const copied = rig(samples());
		copied.panel.handleInput("c");
		await flush();
		assert.deepEqual(copied.calls.copies, [samples()[0].meta.id]);
		assert.equal(copied.calls.done, undefined);
		assert.match(copied.panel.render(72).join("\n"), /copied ✓/);

		const completed = rig(samples());
		completed.panel.handleInput("\x1b[B");
		completed.panel.handleInput("o");
		assert.equal((completed.calls.done as any).complete.meta.id, samples()[1].meta.id);
	});

	it("shows clipboard failures in the footer", async () => {
		const failed = rig(samples(), 20, "", false, async () => {
			throw new Error("clipboard unavailable");
		});
		failed.panel.handleInput("c");
		await flush();
		assert.match(failed.panel.render(104).join("\n"), /clipboard copy failed/);
		assert.equal(failed.calls.done, undefined);
	});

	it("shows copy busy state, suppresses duplicates, and stops feedback after disposal", async () => {
		let resolveCopy: (() => void) | undefined;
		let starts = 0;
		const pending = new Promise<void>((resolve) => {
			resolveCopy = resolve;
		});
		const { panel, calls } = rig(samples(), 20, "", false, async () => {
			starts++;
			return pending;
		});
		panel.handleInput("c");
		panel.handleInput("c");
		assert.equal(starts, 1);
		assert.match(panel.render(104).join("\n"), /copying…/);
		const rendersBeforeDispose = calls.renders;
		panel.dispose();
		resolveCopy?.();
		await flush();
		assert.equal(calls.renders, rendersBeforeDispose);
	});

	it("keeps the footer at tiny terminal heights", () => {
		for (const rows of [1, 2, 3, 8, 10]) {
			const { panel } = rig(samples(), rows);
			const lines = panel.render(38);
			assert.ok(lines.length <= rows, `${lines.length} lines exceed ${rows}`);
			assert.match(lines.join("\n"), /esc|close/i);
			for (const line of lines) assert.equal(visibleWidth(line), 38);
		}
	});

	it("shows a useful empty state and never emits untrusted terminal controls", () => {
		const hostile = entry("safe-id", "bad\x1b]0;title\x07", "body\x1b[31mred\x1b[0m");
		const rendered = rig([hostile]).panel.render(60).join("\n");
		assert.ok(!rendered.includes("\x1b"));
		assert.match(rendered, /\\x1b/);
		assert.match(rig([]).panel.render(60).join("\n"), /No stashes yet/);
	});

	it("pages a long preview with b/space without losing the selected stash", () => {
		const { panel } = rig(samples(), 16);
		panel.handleInput("\x1b[B");
		assert.match(panel.render(104).join("\n"), /preview line 1/);
		panel.handleInput(" ");
		const paged = panel.render(104).join("\n");
		assert.doesNotMatch(paged, /preview line 1\s/);
		assert.match(paged, /› ◐ 2026-07-24 Long work/);
		panel.handleInput("b");
		assert.match(panel.render(104).join("\n"), /preview line 1/);
	});

	it("shows self-contained help and returns without closing", () => {
		const { panel, calls } = rig(samples(), 20);
		panel.handleInput("h");
		assert.match(panel.render(104).join("\n"), /What this is/);
		assert.match(panel.render(104).join("\n"), /\/stash new <hint>/);
		assert.match(panel.render(104).join("\n"), /Closing/);
		assert.doesNotMatch(panel.render(104).join("\n"), /Keys/);
		panel.handleInput("h");
		assert.equal(calls.done, undefined);
		assert.match(panel.render(104).join("\n"), /New work/);
	});

	it("restores the nearest row when a selected id disappears", () => {
		const { panel } = rig(samples(), 20, "", false, undefined, "removed-id", 1);
		assert.match(panel.render(104).join("\n"), /› ◐ 2026-07-24 Long work/);
	});

	it("maps lifecycle states to distinct glyph rows", () => {
		const closed = entry("closed", "Closed work", "done", {
			meta: { id: "closed", title: "Closed work", created: "20260723T120000Z", tags: [], state: "closed" },
		});
		const rendered = rig([...samples(), closed]).panel.render(104).join("\n");
		assert.match(rendered, /○ 2026-07-24 New work/);
		assert.match(rendered, /◐ 2026-07-24 Long work/);
		assert.match(rendered, /● 2026-07-23 Closed work/);
	});
});
