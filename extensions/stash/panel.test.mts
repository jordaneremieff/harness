import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { computePanes, StashPanel, type StashPanelResult, type PanelTheme } from "./panel.ts";
import type { StashEntry } from "./store.ts";

const theme: PanelTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
};

function entry(id: string, title: string, preview?: string, overrides: Partial<StashEntry> = {}): StashEntry {
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
	const calls: { renders: number; done?: StashPanelResult; copies: string[] } = { renders: 0, copies: [] };
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
		copyResume:
			copyResume ??
			(async (selected) => {
				calls.copies.push(selected.meta.id);
			}),
		done: (result) => {
			calls.done = result;
		},
	});
	return { panel, calls, result: () => calls.done };
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
		const { panel, calls, result } = rig(samples());
		panel.handleInput("/");
		for (const char of "continuity") panel.handleInput(char);
		assert.match(panel.render(104).join("\n"), /filter continuity▌.*1 match/);
		assert.match(panel.render(104).join("\n"), /New work/);
		panel.handleInput("\x1b");
		assert.equal(calls.done, undefined);
		assert.match(panel.render(104).join("\n"), /New work/);
		panel.handleInput("\x1b");
		assert.equal(result()?.filter, "continuity");
		assert.equal(result()?.selectedId, samples()[0].meta.id);
	});

	it("accepts Kitty CSI-u printable events for commands and filter text", () => {
		// A terminal with the Kitty keyboard protocol sends CSI-u for every key,
		// so raw single-character handling loses letter commands and typed text.
		const { panel } = rig(samples());
		panel.handleInput("\x1b[47u");
		for (const code of [99, 111, 110, 116, 105, 110, 117, 105, 116, 121]) {
			panel.handleInput(`\x1b[${code}u`);
		}
		assert.match(panel.render(104).join("\n"), /filter continuity▌.*1 match/);
	});

	it("selects pickup on enter and opens lifecycle actions on tab", async () => {
		const first = rig(samples());
		first.panel.handleInput("\x1b[B");
		first.panel.handleInput("\r");
		await flush();
		assert.equal(first.calls.done?.selected?.meta.id, samples()[1].meta.id);
		assert.equal(first.calls.done?.selectedId, samples()[1].meta.id);
		assert.equal(first.calls.done?.selectedIndex, 1);

		const second = rig(samples());
		second.panel.handleInput("\t");
		assert.equal(second.calls.done?.manage?.meta.id, samples()[0].meta.id);
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
		assert.equal(completed.calls.done?.complete?.meta.id, samples()[1].meta.id);
	});

	it("hands the selected entry to the host for a noted pickup on a", async () => {
		const noted = rig(samples());
		noted.panel.handleInput("a");
		assert.ok(noted.calls.done);
		assert.equal(noted.calls.done.note?.meta.id, samples()[0].meta.id);
		assert.equal(noted.calls.done.selected, undefined);

		// An entry with an unknown state must not offer a noted pickup.
		const invalid = rig([entry("20260724T120000Z-bad", "Broken", "body", { previewError: "unreadable header" })]);
		invalid.panel.handleInput("a");
		await flush();
		assert.equal(invalid.calls.done, undefined);
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

	it("keeps the selected row visible in a narrow list and after a resize", () => {
		const entries = Array.from({ length: 12 }, (_, index) => entry(`row-${index}`, `Work ${index}`));
		const { panel, calls } = rig(entries, 5);
		panel.render(104);
		for (let index = 0; index < 9; index++) panel.handleInput("\x1b[B");
		let lines = panel.render(38);
		assert.match(lines.join("\n"), /› ○ 2026-07-24 Work 9/);
		assert.ok(lines.length <= 5);
		for (let index = 0; index < 8; index++) panel.handleInput("\x1b[A");
		lines = panel.render(38);
		assert.match(lines.join("\n"), /› ○ 2026-07-24 Work 1/);
		panel.handleInput("\r");
		assert.equal(calls.done?.selected?.meta.id, "row-1");
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
		const rendered = rig([...samples(), closed])
			.panel.render(104)
			.join("\n");
		assert.match(rendered, /○ 2026-07-24 New work/);
		assert.match(rendered, /◐ 2026-07-24 Long work/);
		assert.match(rendered, /● 2026-07-23 Closed work/);
	});

	it("marks unrecognized and unreadable states with the unknown glyph", () => {
		const invalid = entry("invalid", "Invalid work", "body", {
			meta: {
				id: "invalid",
				title: "Invalid work",
				created: "20260723T130000Z",
				tags: [],
				state: "open",
				invalidState: "mystery",
			},
		});
		const unread = entry("unread", "Unread work", undefined, {
			previewError: "artifact header is unreadable; its state cannot be verified",
		});
		const rendered = rig([...samples(), invalid, unread])
			.panel.render(104)
			.join("\n");
		assert.match(rendered, /◈ 2026-07-23 Invalid work/);
		assert.match(rendered, /◈ 2026-07-24 Unread work/);
		assert.doesNotMatch(rendered, /○ 2026-07-23 Invalid work/);
	});

	it("labels an unknown state in the preview header and the filter", () => {
		const invalid = entry("invalid", "Invalid work", "body", {
			meta: {
				id: "invalid",
				title: "Invalid work",
				created: "20260723T130000Z",
				tags: [],
				state: "open",
				invalidState: "mystery",
			},
		});
		const unread = entry("unread", "Unread work", undefined, {
			previewError: "artifact header is unreadable; its state cannot be verified",
		});
		const entries = [...samples(), invalid, unread];
		// The selected first entry is a sample; its preview never claims the invalid label.
		assert.doesNotMatch(rig(entries).panel.render(104).join("\n"), /unknown \(mystery\) · stashed/);
		// Filtering by "open" must not match the unknown-state entries.
		const openFiltered = rig(entries, 20, "open").panel.render(104).join("\n");
		assert.match(openFiltered, /New work/);
		assert.doesNotMatch(openFiltered, /Invalid work|Unread work/);
		// Filtering by "unknown" must match exactly the unknown-state entries.
		const unknownFiltered = rig(entries, 20, "unknown").panel.render(104).join("\n");
		assert.match(unknownFiltered, /Invalid work/);
		assert.match(unknownFiltered, /Unread work/);
		assert.doesNotMatch(unknownFiltered, /New work|Long work/);
	});

	it("refuses pickup and manage on entries whose state is unknown", () => {
		const invalid = entry("invalid", "Invalid work", "body", {
			meta: {
				id: "invalid",
				title: "Invalid work",
				created: "20260723T130000Z",
				tags: [],
				state: "open",
				invalidState: "mystery",
			},
		});
		const unread = entry("unread", "Unread work", undefined, {
			previewError: "artifact header is unreadable; its state cannot be verified",
		});
		const valid = entry("valid", "Valid work", "body");
		const { panel, calls, result } = rig([invalid, unread, valid], 20);
		// The footer must not advertise actions that the panel blocks on unknown rows.
		const unknownFooter = panel.render(104).join("\n");
		assert.doesNotMatch(unknownFooter, /\[Pick up\]|\[Pick up \+ note\]|\[Actions\]|\[Complete\]/);
		assert.match(unknownFooter, /no lifecycle action is offered/);
		panel.handleInput("\r"); // enter on the invalid entry: no pickup
		assert.equal(calls.done, undefined);
		panel.handleInput("\t"); // tab on the invalid entry: no manage
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b[B"); // move to the unread entry
		panel.handleInput("\r");
		assert.equal(calls.done, undefined);
		panel.handleInput("\x1b[B"); // move to the valid entry
		// The footer advertises actions again once a readable row is selected.
		assert.match(panel.render(104).join("\n"), /\[Pick up\]/);
		panel.handleInput("\r");
		assert.ok(result(), "a readable entry must still pick up");
		assert.equal(result()?.selected?.meta.id, "valid");
	});
});

function click(panel: StashPanel, lines: string[], label: string, width: number) {
	const y = lines.findIndex((line) => line.includes(label));
	assert.ok(y >= 0, `${label} is visible`);
	return panel.handleMouse({
		type: "click",
		button: "left",
		x: lines[y].indexOf(label) + 1,
		y,
		screenX: 0,
		screenY: y,
		width,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	});
}

describe("StashPanel pointer and layout (component input proxy; real pointer delivery is not exercised)", () => {
	for (const width of [80, 100]) {
		it(`keeps every operation visible at ${width} columns`, () => {
			const rendered = rig(samples(), 24).panel.render(width).join("\n");
			for (const label of ["Detail", "Recent", "Search archive", "Filter", "Close", "Actions", "Pick up", "Pick up + note", "Copy command", "Page up", "Page down", "Help"]) {
				assert.ok(rendered.includes(`[${label}]`), `${label} at ${width}`);
			}
		});
	}

	it("a row click selects without acting, a labelled control acts", () => {
		const { panel, calls } = rig(samples(), 24);
		const lines = panel.render(80);
		const y = lines.findIndex((line) => line.includes("Long work"));
		panel.handleMouse({ type: "click", button: "left", x: 6, y, screenX: 6, screenY: y, width: 80, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.equal(Object.keys(calls).includes("done") ? (calls as { done?: unknown }).done : undefined, undefined, "row click never acts");
		assert.match(panel.render(80).join("\n"), /› ◐ 2026-07-24 Long work/);
		click(panel, panel.render(80), "[Pick up]", 80);
		assert.equal((calls as { done?: StashPanelResult }).done?.selected?.meta.id, samples()[1].meta.id);
	});

	it("ignores clicks after a resize until the next render and never hits a replaced row", () => {
		const { panel, calls } = rig(samples(), 24);
		const lines = panel.render(80);
		const stale = panel.handleMouse({ type: "click", button: "left", x: lines.join("\n").split("\n").filter((l) => l.includes("[Pick up]"))[0].indexOf("[Pick up]") + 1, y: lines.findIndex((l) => l.includes("[Pick up]")), screenX: 0, screenY: 0, width: 100, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.equal(stale, undefined);
		assert.equal(calls.done, undefined);
		panel.invalidate();
		assert.equal(panel.handleMouse({ type: "click", button: "left", x: 3, y: 4, screenX: 0, screenY: 4, width: 80, height: 20, shift: false, alt: false, ctrl: false }), undefined);
		panel.dispose();
		assert.equal(panel.handleMouse({ type: "click", button: "left", x: 3, y: 4, screenX: 0, screenY: 4, width: 80, height: 20, shift: false, alt: false, ctrl: false }), undefined);
	});

	it("scrolls the pane under the pointer", () => {
		const { panel } = rig(samples(), 16);
		panel.handleInput("\x1b[B");
		const lines = panel.render(120);
		const wheel = (x: number, delta: number) =>
			panel.handleMouse({ type: "wheel", button: "none", x, y: 4, screenX: x, screenY: 4, width: 120, height: lines.length, shift: false, alt: false, ctrl: false, wheelDelta: delta });
		assert.equal(wheel(80, 1)?.handled, true);
		assert.doesNotMatch(panel.render(120).join("\n"), /preview line 1\s/);
		assert.match(panel.render(120).join("\n"), /› ◐ 2026-07-24 Long work/);
		assert.equal(wheel(80, -1)?.handled, true);
		assert.match(panel.render(120).join("\n"), /preview line 1/);
	});

	it("wheel over the list moves the viewport without changing the selection; explicit selection reveals its row", () => {
		const many = Array.from({ length: 30 }, (_, index) => entry(`20260701T${String(100000 + index).slice(1)}Z-item-${index}`, `Item ${index}`, `body ${index}`));
		const { panel, calls } = rig(many, 20);
		let lines = panel.render(80);
		assert.match(lines.join("\n"), /› . 2026-07-24 Item 0/);
		const wheel = (delta: number) => panel.handleMouse({ type: "wheel", button: "none", x: 10, y: 4, screenX: 10, screenY: 4, width: 80, height: lines.length, shift: false, alt: false, ctrl: false, wheelDelta: delta });
		assert.equal(wheel(1)?.handled, true);
		const scrolled = panel.render(80);
		assert.notDeepEqual(scrolled, lines, "the list viewport moved");
		assert.doesNotMatch(scrolled.join("\n"), /› . 2026-07-24 Item 0/, "the selected row scrolled out of view and stayed selected");
		assert.match(panel.render(80).join("\n"), /1\/30/);
		assert.equal(calls.done, undefined, "wheel never activates");
		panel.handleInput("\x1b[B");
		lines = panel.render(80);
		assert.match(lines.join("\n"), /› . 2026-07-24 Item 1/, "explicit selection reveals its row");
		const second = lines.findIndex((line) => line.includes("Item 3")) + 1;
		panel.handleMouse({ type: "click", button: "left", x: 4, y: second, screenX: 4, screenY: second, width: 80, height: lines.length, shift: false, alt: false, ctrl: false });
		assert.match(panel.render(80).join("\n"), /› . 2026-07-24 Item 3/, "the second line of a stacked row selects it");
		assert.equal(calls.done, undefined);
	});

	it("offers no pickup for a closed record and routes enter to the actions dialog", () => {
		const closed = entry("closed", "Closed work", "done", {
			meta: { id: "closed", title: "Closed work", created: "20260723T120000Z", tags: [], state: "closed", closedAt: "20260723T130000Z", outcome: "done" },
		});
		const { panel, calls } = rig([closed], 24);
		const rendered = panel.render(100).join("\n");
		assert.doesNotMatch(rendered, /\[Pick up\]|\[Pick up \+ note\]|\[Complete\]/);
		assert.match(rendered, /\[Actions\]/);
		panel.handleInput("\r");
		assert.equal(calls.done?.manage?.meta.id, "closed");
		assert.equal(calls.done?.selected, undefined);
	});

	it("a stale archive view offers refresh but no mutating or continuation controls", () => {
		const stalePanel = new StashPanel({
			entries: samples(),
			title: "Stashes",
			theme,
			tui: { requestRender() {} },
			getMaxRows: () => 24,
			scope: "archive",
			query: "needle",
			stale: true,
			nextCursor: "abc",
			coverage: "cursor no longer matches",
			copyResume: async () => {},
			done: () => {},
		});
		const rendered = stalePanel.render(100).join("\n");
		assert.match(rendered, /\[Refresh\]/);
		assert.match(rendered, /results may be stale/);
		assert.doesNotMatch(rendered, /\[Pick up\]|\[Pick up \+ note\]|\[Actions\]|\[Complete\]|\[Continue\]/);
	});

	it("shows Continue for an empty archive page and keeps coverage visible", () => {
		let done: StashPanelResult | undefined;
		const empty = new StashPanel({
			entries: [],
			title: "Stashes",
			theme,
			tui: { requestRender() {} },
			getMaxRows: () => 24,
			scope: "archive",
			query: "needle",
			nextCursor: "abc",
			hasMore: true,
			coverage: "no matches on this page · 256 visited · coverage partial · more pages: Continue",
			copyResume: async () => {},
			done: (result) => {
				done = result;
			},
		});
		const lines = empty.render(80);
		assert.match(lines.join("\n"), /no matches on this page/);
		click(empty, lines, "[Continue]", 80);
		assert.equal(done?.navigation, "continue");
	});

	it("loads the selected preview on demand and cancels it when the selection moves", async () => {
		const aborted: string[] = [];
		const body = entry("a", "A", undefined);
		const other = entry("b", "B", undefined);
		const panel = new StashPanel({
			entries: [body, other],
			title: "Stashes",
			theme,
			tui: { requestRender() {} },
			getMaxRows: () => 24,
			copyResume: async () => {},
			done: () => {},
			loadPreview: (selected, signal) =>
				new Promise((resolve) => {
					signal.addEventListener("abort", () => aborted.push(selected.meta.id));
					if (selected.meta.id === "b") resolve({ ...selected, preview: "loaded b body" });
				}),
		});
		assert.match(panel.render(120).join("\n"), /Preview read pending/);
		panel.handleInput("\x1b[B");
		await flush();
		assert.deepEqual(aborted, ["a"]);
		assert.match(panel.render(120).join("\n"), /loaded b body/);
	});

	it("wraps a long body line so no character is lost to horizontal truncation", () => {
		const long = `start ${"word ".repeat(60)}tail-end-marker`;
		const rendered = rig([entry("w", "Wrap", long)], 40).panel.render(120).join("\n");
		assert.match(rendered, /tail-end-marker/);
	});
});
