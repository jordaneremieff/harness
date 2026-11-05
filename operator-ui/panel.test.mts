import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { LoadingView } from "./loading.ts";
import { readPanelModule } from "./panel.ts";
import { ReaderView } from "./reader.ts";
import type { OperatorView, ViewHost } from "./view.ts";

initTheme("dark");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const view = (title: string): OperatorView => ({ title, render: (_width, height) => Array.from({ length: height }, () => title), handleInput: () => false });

it("a panel module is accepted only in the current shape", () => {
	const module = readPanelModule(() => ({ version: 2, title: "Stashes", open: () => view("Stashes") }));
	assert.equal(module.title, "Stashes");
	assert.throws(() => readPanelModule({ version: 2 }), /not a function/);
	assert.throws(() => readPanelModule(() => ({ version: 1, title: "Old", open: () => view("Old") })), /unsupported panel module version 1/);
	assert.throws(() => readPanelModule(() => ({ version: 2, title: " ", open: () => view("x") })), /no title/);
	assert.throws(() => readPanelModule(() => ({ version: 2, title: "No open" })), /no open function/);
	assert.throws(() => readPanelModule(() => null), /returned no module/);
});

function host(controller = new AbortController()): ViewHost & { renders: number } {
	const self = {
		theme,
		target: { id: "t", label: "Target" },
		signal: controller.signal,
		renders: 0,
		requestRender() {
			self.renders++;
		},
		notify: () => {},
		push: () => {},
		back: () => {},
		close: () => {},
	};
	return self;
}

const text = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line)).join("\n");

it("a loading view reads once, then shows the built view; a failure shows its reason in place", async () => {
	const ready = host();
	let reads = 0;
	const loading = new LoadingView("Configure", ready, async () => {
		reads++;
		return view("Built form");
	});
	assert.ok(text(loading.render(40, 3)).includes("Reading"));
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(text(loading.render(40, 3)).includes("Built form"));
	loading.render(40, 3);
	assert.equal(reads, 1, "painting never reads again");
	const failing = new LoadingView("Configure", host(), async () => {
		throw new Error("the host lists no models");
	});
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(text(failing.render(60, 3)).includes("the host lists no models"));
});

it("a loading view drops a late answer after its host left", async () => {
	const controller = new AbortController();
	const left = host(controller);
	let disposed = false;
	let release!: (value: OperatorView) => void;
	const loading = new LoadingView("Configure", left, () => new Promise<OperatorView>((resolve) => (release = resolve)));
	controller.abort();
	release({ ...view("Late"), dispose: () => (disposed = true) });
	await Promise.resolve();
	await Promise.resolve();
	assert.ok(!text(loading.render(40, 2)).includes("Late"));
	assert.equal(disposed, true, "the late view is disposed, not shown");
});

it("a reader view shows wrapped content and the owner's actions", () => {
	const reader = new ReaderView("Details", host(), () => "identity one\ndirectory /work", () => [{ id: "again", label: "Read again", run: () => {} }]);
	const shown = text(reader.render(40, 4));
	assert.ok(shown.includes("identity one"));
	assert.ok(shown.includes("directory /work"));
	assert.deepEqual(reader.actions().map((action) => action.label), ["Read again"]);
	assert.deepEqual(reader.keys().map((hint) => hint.label), ["scroll", "page"], "the footer names the reader's own keys");
});
