import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { it } from "node:test";
import { theme } from "./dashboard-test-fixture.mts";
import { PlaybookBrowser, reflowParagraphs, type PlaybookBrowserSource, type PlaybookTargetState } from "./playbook-browser.ts";
import type { PlaybookCatalog } from "./playbook-catalog.ts";
import type { NoticeKind, View, ViewHost } from "./view-model.ts";

const catalog: PlaybookCatalog = {
	state: "ready",
	dir: "/catalog",
	entries: [
		{ name: "architect", summary: "Keep your context clear for design.", body: "Do the design work yourself.\nGive broad reading to agents." },
		{ name: "maker", summary: "Do the main work yourself.", body: "Read the sources and make the change." },
		{ name: "triage", summary: "Sort incoming reports.", body: "Label each report." },
	],
	diagnostics: [],
};

async function settle(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!condition() && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 1));
	assert.ok(condition(), `${what} never held`);
}

function hostFixture() {
	const controller = new AbortController();
	const notices: Array<[string, NoticeKind | undefined]> = [];
	const pushed: View[] = [];
	let closed: (() => unknown) | undefined;
	let closes = 0;
	const host: ViewHost = {
		theme,
		target: { id: "session", label: "This session" },
		signal: controller.signal,
		requestRender() {},
		notify: (text, kind) => notices.push([text, kind]),
		push: (open) => {
			const child = new AbortController();
			pushed.push(open({ ...host, signal: child.signal }));
		},
		back() {},
		close: (then) => { closes++; closed = then; },
	};
	return { host, notices, pushed, closes: () => closes, runClose: () => closed?.(), abort: () => controller.abort() };
}

function browser(source: Partial<PlaybookBrowserSource> & { state?: PlaybookTargetState }, host = hostFixture()) {
	const applied: string[] = [];
	const receipts: string[] = [];
	const view = new PlaybookBrowser(host.host, {
		subject: "This session",
		catalog: () => catalog,
		read: () => source.state ?? { saved: "maker", origin: "you chose it" },
		apply: (name) => { applied.push(name); return `This session now uses ${name}.`; },
		applied: (receipt) => receipts.push(receipt),
		...source,
	});
	view.focused = true;
	const text = (width = 120, height = 18) => view.render(width, height).map((line) => stripVTControlCharacters(line)).join("\n");
	return { view, host, applied, receipts, text };
}

it("lists off and each playbook, opens on the saved choice and shows its full instructions beside the list", async () => {
	const { view, text } = browser({});
	await settle(() => /uses maker/u.test(text()), "the saved choice");
	const screen = text();
	assert.match(screen, /This session uses maker \(you chose it\)/u);
	assert.match(screen, /Sets how work is divided with agents/u);
	assert.match(screen, /● maker\s+Do the main work yourself/u);
	assert.match(screen, /off\s+No playbook/u);
	assert.match(screen, /architect\s+Keep your context clear/u);
	assert.match(screen, /maker\s+In use · you chose it/u, "the detail heading states the standing");
	assert.match(screen, /Read the sources and make the change\./u);
	assert.match(screen, /File: \/catalog\/maker\.md/u);
	assert.equal(view.actions().some((action) => action.id === "use"), false, "the saved choice offers no Use");
	assert.ok(view.keys().some((hint) => hint.keys.includes("enter") && hint.label === "detail"), "Enter reads the saved choice");
	view.handleInput("\x1b[B");
	assert.equal(view.actions().find((action) => action.id === "use")?.key, "enter");
	assert.ok(view.keys().some((hint) => hint.keys.includes("right")), "Enter is taken, so Right opens the detail");
});

it("saves the selected row with Enter, then closes and reports the receipt; a refusal keeps the view open", async () => {
	const ok = browser({});
	await settle(() => /uses maker/u.test(ok.text()), "the saved choice");
	ok.view.handleInput("\x1b[A");
	ok.view.handleInput("\x1b[A");
	assert.match(ok.text(), /follows each task's instructions/u, "the detail explains off");
	const use = ok.view.actions().find((action) => action.id === "use");
	assert.equal(use?.label, "Turn off for this session");
	use?.run();
	await settle(() => ok.host.closes() === 1, "close after saving");
	assert.deepEqual(ok.applied, ["off"]);
	ok.host.runClose();
	assert.deepEqual(ok.receipts, ["This session now uses off."]);

	const refused = browser({ apply: () => { throw new Error("The host did not confirm the playbook change."); } });
	await settle(() => /uses maker/u.test(refused.text()), "the saved choice");
	refused.view.handleInput("\x1b[B");
	refused.view.actions().find((action) => action.id === "use")?.run();
	await settle(() => refused.host.notices.some(([, kind]) => kind === "error"), "the refusal");
	assert.equal(refused.host.closes(), 0);
	assert.match(refused.host.notices.at(-1)?.[0] ?? "", /did not confirm/u);
	assert.equal(refused.view.actions().find((action) => action.id === "use")?.disabled, undefined, "a refusal allows another try");
});

it("marks a choice that waits for the next run, an unreadable saved name and catalog problems", async () => {
	const pending = browser({ state: { saved: "architect", origin: "you chose it", running: "maker" } });
	await settle(() => /uses architect/u.test(pending.text()), "the saved choice");
	assert.match(pending.text(), /From the next run; the run in progress keeps maker/u);
	assert.match(pending.text(), /○ maker/u);
	assert.match(pending.text(), /Chosen · applies from the next run/u);
	assert.equal(pending.view.actions().some((action) => action.id === "use"), false);

	const unsent = browser({ state: { saved: "maker", origin: "you chose it", unsent: true, note: "The last run did not receive it." } });
	await settle(() => /uses maker/u.test(unsent.text()), "the saved choice");
	assert.match(unsent.text(), /Chosen · the last run did not receive it/u);
	assert.match(unsent.text(), /The last run did not receive it\./u);

	const broken = browser({
		state: { saved: "gone" },
		catalog: () => ({ ...catalog, diagnostics: ["bad.md: line 1: expected # bad."] }),
	});
	await settle(() => /uses gone/u.test(broken.text()), "the saved choice");
	const screen = broken.text(120, 24);
	assert.match(screen, /Its file supplies no instructions now/u);
	assert.match(screen, /● gone\s+No readable file/u);
	assert.match(screen, /No readable file supplies this playbook now/u);
	assert.match(screen, /1 catalog problem/u);
});

it("offers the starter review for bundled names and reads the catalog again after it", async () => {
	let reads = 0;
	let opened = "";
	const missing: PlaybookCatalog = { state: "missing", dir: "/catalog", entries: [], diagnostics: [] };
	const fixture = browser({
		state: { saved: null },
		catalog: () => { reads++; return missing; },
		compare: (name) => { opened = name; return () => ({ title: "Review", render: (width, height) => Array.from({ length: height }, () => " ".repeat(width)), handleInput: () => false }); },
	});
	await settle(() => /uses no playbook/u.test(fixture.text()), "the saved choice");
	assert.match(fixture.text(), /The catalog is not installed yet; these are the bundled starters/u);
	fixture.view.handleInput("\x1b[B");
	assert.match(fixture.text(120, 40), /Bundled starter, not installed yet/u);
	assert.match(fixture.text(120, 40), /must stay clear for the next change/u, "hard-wrapped paragraphs flow at the detail width");
	const compare = fixture.view.actions().find((action) => action.id === "compare");
	assert.equal(compare?.key, "c");
	const before = reads;
	compare?.run();
	assert.equal(fixture.host.pushed.length, 1);
	assert.ok(["architect", "maker", "orchestrator"].includes(opened));
	assert.equal(reads, before, "opening the review reads nothing");
	fixture.view.actions().find((action) => action.id === "reload")?.run();
	assert.equal(reads, before + 1);
});

it("reflows plain paragraphs and keeps Markdown structure", () => {
	assert.equal(reflowParagraphs("One line\nwraps here.\n\nNext\nparagraph."), "One line wraps here.\n\nNext paragraph.");
	assert.equal(reflowParagraphs("Intro\n\n- first\n- second"), "Intro\n\n- first\n- second");
	assert.equal(reflowParagraphs("```\ncode\nkept\n```"), "```\ncode\nkept\n```");
});

it("opens the detail as its own view below the split width", async () => {
	const fixture = browser({});
	await settle(() => /uses maker/u.test(fixture.text(70)), "the saved choice");
	assert.doesNotMatch(fixture.text(70), /Read the sources/u, "the narrow list shows no detail");
	fixture.view.handleInput("\x1b[C");
	assert.equal(fixture.host.pushed.length, 1);
	assert.match(fixture.host.pushed[0].render(70, 12).map((line) => stripVTControlCharacters(line)).join("\n"), /Read the sources and make the change/u);
});
