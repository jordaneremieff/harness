import assert from "node:assert/strict";
import { it } from "node:test";
import { initTheme, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager as Keys, setKeybindings, TUI_KEYBINDINGS, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { paneState, type PeerDocument, type PeerTranscript, type PeerTranscriptFactory } from "./peer-contract.ts";
import { createPeerWindowState } from "./peer-contract.ts";
import { MergedTranscript, PeerPane } from "./peer-pane.ts";

initTheme("dark");
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new Keys({ ...TUI_KEYBINDINGS, "app.interrupt": { defaultKeys: "escape", description: "Cancel" } }) as KeybindingsManager;
setKeybindings(keys);

function fixed(lines: number, text: string): PeerTranscriptFactory {
	return {
		create: (): PeerTranscript => ({
			render: (): PeerDocument => ({ lines: Array.from({ length: lines }, (_, index) => `${text} ${index}`), anchors: [{ id: "first", line: 0 }, { id: "middle", line: Math.floor(lines / 2) }] }),
			invalidate: () => {},
		}),
	};
}

function pane(factory: PeerTranscriptFactory, paneKey = "agent:a", shared?: ReturnType<typeof createPeerWindowState>) {
	const state = shared ?? createPeerWindowState();
	const paneValue = paneState(state, paneKey);
	const peer = new PeerPane({
		key: paneKey,
		kind: "agent",
		tui: { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI,
		theme,
		keys,
		factory,
		state: paneValue,
		onSubmit: () => {},
		onEscape: () => {},
	});
	peer.setDescriptor({ id: paneKey, kind: "agent", name: "reader", cwd: "/work/agent", model: "test/m", thinkingLevel: "high", state: "idle", cost: 0.5 });
	return { peer, state, paneValue };
}

function content(revision: string, live = ""): Parameters<PeerPane["setContent"]>[0] {
	return { entries: [], revision, live: [], liveRevision: live, cwd: "/work/agent", expanded: false, showThinking: true };
}

it("renders exactly the allocated height with no line wider than the pane", () => {
	const { peer } = pane(fixed(200, "line"));
	peer.setContent(content("r1"));
	for (const width of [40, 20, 10]) {
		for (const height of [25, 10, 4, 1, 0]) {
			const lines = peer.render(width, height);
			assert.equal(lines.length, height, `height ${height}`);
			assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width} height ${height}`);
		}
	}
});

it("offsets live anchors after the committed document", () => {
	const head: PeerTranscript = { render: () => ({ lines: ["a", "b"], anchors: [{ id: "h", line: 0 }] }), invalidate: () => {} };
	const live: PeerTranscript = { render: () => ({ lines: ["c"], anchors: [{ id: "l", line: 0 }] }), invalidate: () => {} };
	const document = new MergedTranscript(head, live).render(40);
	assert.deepEqual(document.lines, ["a", "b", "", "c"]);
	assert.deepEqual(document.anchors, [{ id: "h", line: 0 }, { id: "l", line: 3 }]);
});

it("keeps the reading anchor when a pane is closed and created again", () => {
	const state = createPeerWindowState();
	const { peer, paneValue } = pane(fixed(200, "line"), "agent:a", state);
	peer.setContent(content("r1"));
	peer.render(60, 20);
	assert.equal(paneValue.view.follow, true);
	peer.scrollLines(-6);
	assert.equal(paneValue.view.follow, false);
	assert.equal(paneValue.view.anchor?.id, "middle");
	const offset = paneValue.view.anchor?.offset;

	const reopened = pane(fixed(200, "line"), "agent:a", state);
	reopened.peer.setContent(content("r1"));
	reopened.peer.render(60, 20);
	reopened.peer.captureView();
	assert.equal(reopened.paneValue.view.follow, false, "the reading position is restored, not reset to follow");
	assert.equal(reopened.paneValue.view.anchor?.id, "middle");
	assert.equal(reopened.paneValue.view.anchor?.offset, offset);
});

it("shows the caret only while this pane owns focus", () => {
	const { peer } = pane(fixed(200, "line"));
	peer.setContent(content("r1"));
	peer.focus();
	assert.ok(peer.render(60, 20).some((line) => line.includes(CURSOR_MARKER)));
	peer.blur();
	assert.ok(peer.render(60, 20).every((line) => !line.includes(CURSOR_MARKER)));
});

it("keeps a draft in the shared state across pane recreation", () => {
	const state = createPeerWindowState();
	const first = pane(fixed(10, "line"), "agent:a", state);
	first.peer.composer.setText("recover me");
	first.peer.saveDraft();
	const second = pane(fixed(10, "line"), "agent:a", state);
	second.peer.setContent(content("r1"));
	assert.match(second.peer.render(60, 20).join("\n"), /recover me/);
});
