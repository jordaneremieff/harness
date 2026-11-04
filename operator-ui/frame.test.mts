import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type Destination, NavigationFrame } from "./frame.ts";
import type { OperatorView, ViewHost } from "./view.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const ESC = "\u001b";
const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line));

interface Probe {
	readonly hosts: ViewHost[];
	readonly signals: AbortSignal[];
	escapes: number;
}

/** A view that counts "+" keys, offers one action that opens a nested view, and can consume Escape once. */
function counter(host: ViewHost, title: string, probe: Probe): OperatorView {
	probe.hosts.push(host);
	probe.signals.push(host.signal);
	let count = 0;
	return {
		title,
		render: (_width, height) => Array.from({ length: height }, (_, row) => (row === 0 ? `${title} count ${count}` : "")),
		handleInput: (data) => {
			if (data !== "+") return false;
			count++;
			return true;
		},
		escape: () => {
			if (probe.escapes <= 0) return false;
			probe.escapes--;
			return true;
		},
		actions: () => [{ id: "open", label: "Open nested", primary: true, run: () => host.push((next) => counter(next, "Nested", probe)) }],
	};
}

function frame(destinations: Destination[], patch: { initial?: string } = {}) {
	const closes: Array<(() => void) | undefined> = [];
	const view = new NavigationFrame({
		theme,
		target: { id: "session", label: "This session · work" },
		destinations: () => destinations,
		initial: patch.initial,
		rows: () => 12,
		requestRender: () => {},
		close: (then) => closes.push(then),
	});
	return { view, closes, screen: () => plain(view.render(80)).join("\n") };
}

function probe(): Probe {
	return { hosts: [], signals: [], escapes: 0 };
}

it("destinations show as tabs with the target and the way out, and each keeps its own state", () => {
	const seen = probe();
	const f = frame([
		{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) },
		{ key: "b", label: "Beta", open: (host) => counter(host, "Beta", seen) },
	]);
	const first = f.screen();
	for (const text of ["Alpha", "Beta", "This session · work", "Close"]) assert.ok(first.includes(text), `${text} missing`);
	f.view.handleInput("+");
	f.view.handleInput("+");
	f.view.navigate("b");
	assert.ok(f.screen().includes("Beta count 0"));
	f.view.navigate("a");
	assert.ok(f.screen().includes("Alpha count 2"), "returning to a destination keeps its view state");
	assert.equal(seen.hosts.length, 2, "a destination opens once while the frame stays open");
});

it("push adds a nested view with a Back breadcrumb, and back leaves it", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	seen.hosts[0]?.push((host) => counter(host, "Nested", seen));
	assert.equal(f.view.viewTitle, "Nested");
	const nested = f.screen();
	assert.ok(nested.includes("‹ Back"));
	assert.ok(nested.includes("Alpha › Nested"));
	seen.hosts[1]?.back();
	assert.equal(f.view.viewTitle, "Alpha");
	assert.ok(seen.signals[1]?.aborted, "leaving a nested view aborts its requests");
	assert.equal(seen.signals[0]?.aborted, false);
});

it("Escape closes the menu, then lets the view consume it, then leaves the nested view, then closes the frame", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	seen.hosts[0]?.push((host) => counter(host, "Nested", seen));
	seen.escapes = 1;
	f.view.handleInput(ESC);
	assert.equal(f.view.viewTitle, "Nested", "the view consumed the first Escape");
	f.view.handleInput(ESC);
	assert.equal(f.view.viewTitle, "Alpha", "the next Escape leaves the nested view");
	assert.equal(f.closes.length, 0);
	f.view.handleInput(ESC);
	assert.equal(f.closes.length, 1, "Escape at the root closes the frame");
	assert.ok(seen.signals.every((signal) => signal.aborted), "closing aborts every view's requests");
});

it("a view that fails to open or to draw costs only its destination", () => {
	const seen = probe();
	const f = frame([
		{
			key: "bad",
			label: "Broken",
			open: () => {
				throw new Error("the owner module failed");
			},
		},
		{ key: "draw", label: "Faulty", open: () => ({ title: "Faulty", render: () => { throw new Error("paint failed"); }, handleInput: () => false }) },
		{ key: "good", label: "Working", open: (host) => counter(host, "Working", seen) },
	]);
	assert.ok(f.screen().includes("Broken is unavailable here"));
	assert.ok(f.screen().includes("the owner module failed"));
	f.view.navigate("draw");
	assert.ok(f.screen().includes("paint failed"));
	f.view.navigate("good");
	f.view.handleInput("+");
	assert.ok(f.screen().includes("Working count 1"));
});

it("an unavailable destination stays listed and explains itself", () => {
	const f = frame([{ key: "off", label: "Offline", unavailable: "/offline is not registered by its owner", open: () => { throw new Error("never opened"); } }]);
	const screen = f.screen();
	assert.ok(screen.includes("Offline"));
	assert.ok(screen.includes("/offline is not registered by its owner"));
});

it("close passes its continuation to the host, which runs it after the frame leaves", () => {
	const seen = probe();
	const f = frame([{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) }]);
	f.view.render(80);
	const ran: string[] = [];
	seen.hosts[0]?.close(() => ran.push("after"));
	assert.equal(f.closes.length, 1);
	assert.deepEqual(ran, [], "the frame does not run the continuation itself");
	f.closes[0]?.();
	assert.deepEqual(ran, ["after"]);
	seen.hosts[0]?.close();
	assert.equal(f.closes.length, 1, "a closed frame ignores a second close");
});

it("Tab moves from the view to its actions, then to the destination row; Enter runs the focused action", () => {
	const seen = probe();
	const f = frame([
		{ key: "a", label: "Alpha", open: (host) => counter(host, "Alpha", seen) },
		{ key: "b", label: "Beta", open: (host) => counter(host, "Beta", seen) },
	]);
	f.view.render(80);
	f.view.handleInput("\t");
	f.view.render(80);
	f.view.handleInput("\r");
	assert.equal(f.view.viewTitle, "Nested", "Enter on the focused action ran it");
	f.view.handleInput(ESC);
	f.view.handleInput("\t");
	f.view.handleInput("\t");
	f.view.handleInput("\u001b[C");
	f.view.handleInput("\r");
	assert.equal(f.view.activeKey, "b", "the destination row takes arrows and Enter");
});
