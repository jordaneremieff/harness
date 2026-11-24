import assert from "node:assert/strict";
import { test } from "node:test";
import { paletteStep } from "./palette-command.ts";
import { type AppEntry, outcomeText, paneLabel, runShow, type ShowContext, webAddress } from "./show.ts";

const brave: AppEntry = {
	name: "Brave Browser",
	path: "/Applications/Brave Browser.app",
	bundleIdentifier: "com.brave.Browser",
	running: true,
	browser: true,
};
const slack: AppEntry = {
	name: "Slack",
	path: "/Applications/Slack.app",
	bundleIdentifier: "com.tinyspeck.slackmacgap",
	running: false,
	browser: false,
};

function context(overrides: Partial<ShowContext> = {}): ShowContext {
	return {
		app: "/agent/apps/AppPane.app",
		installed: async () => true,
		resolve: async (_executable, text) => (text === "brave" ? { app: brave } : text === "slack" ? { app: slack } : {}),
		install: () => "building",
		...overrides,
	};
}

test("apps_show returns the pane program for a browser address", { skip: process.platform !== "darwin" }, async () => {
	const outcome = await runShow({ app: "brave", url: "https://example.com/a" }, context());
	assert.deepEqual(outcome, {
		ok: true,
		app: brave,
		show: [
			"/agent/apps/AppPane.app/Contents/MacOS/AppPane",
			"--app",
			"/Applications/Brave Browser.app",
			"--url",
			"https://example.com/a",
		],
		label: "Brave Browser",
	});
	const text = outcomeText(outcome);
	assert.match(text, /^show: \["\/agent\/apps\/AppPane\.app\/Contents\/MacOS\/AppPane"/u);
	assert.match(text, /closes that window/u);
});

test("apps_show passes a window title for another application", { skip: process.platform !== "darwin" }, async () => {
	const outcome = await runShow({ app: "slack", window: " General " }, context());
	assert.equal(outcome.ok, true);
	assert.deepEqual(outcome.ok && outcome.show.slice(1), ["--app", "/Applications/Slack.app", "--window", "General"]);
	assert.match(outcomeText(outcome), /not running; the pane starts it/u);
	assert.match(outcomeText(outcome), /puts the window back where it was/u);
});

test("apps_show refuses what the pane cannot show", { skip: process.platform !== "darwin" }, async () => {
	assert.deepEqual(await runShow({ app: "slack", url: "https://example.com" }, context()), {
		ok: false,
		error: "Slack is not a browser that a pane can open at an address.",
	});
	assert.equal((await runShow({ app: "brave", url: "file:///etc/hosts" }, context())).ok, false);
	assert.equal((await runShow({ app: "brave", url: "https://a.example", window: "x" }, context())).ok, false);
	assert.deepEqual(await runShow({ app: "zoom" }, context()), {
		ok: false,
		error: 'No application on this Mac matches "zoom".',
	});
	const ambiguous = await runShow({ app: "s" }, context({ resolve: async () => ({ candidates: [slack, brave] }) }));
	assert.equal(ambiguous.ok, false);
	assert.match(outcomeText(ambiguous), /Candidates: Slack \(\/Applications\/Slack\.app\); Brave Browser/u);
});

test("apps_show starts an install when App Pane is missing", { skip: process.platform !== "darwin" }, async () => {
	let resolved = false;
	const outcome = await runShow(
		{ app: "brave" },
		context({
			installed: async () => false,
			resolve: async () => {
				resolved = true;
				return {};
			},
		}),
	);
	assert.deepEqual(outcome, { ok: false, error: "building" });
	assert.equal(resolved, false);
});

test("web addresses and labels are bounded", () => {
	assert.equal(webAddress("http://127.0.0.1:8080/x?y=1"), true);
	for (const bad of ["javascript:alert(1)", "https://", "https://a b.example", "example.com", "https://a.example/\n"])
		assert.equal(webAddress(bad), false, bad);
	assert.equal(webAddress(`https://a.example/${"x".repeat(2048)}`), false);
	assert.equal(paneLabel("A\u0007B"), "A B");
	assert.equal(Array.from(paneLabel("x".repeat(40))).length, 32);
	assert.equal(paneLabel("\u0007"), "App");
});

const request = (answers: unknown[]) =>
	JSON.stringify({ version: 1, command: "apps.open", context: { session: "s", block: "b" }, answers });

test("the palette command asks for an application, then shows it", async () => {
	const list = async () => [brave, slack];
	const first = await paletteStep(["/agent/apps/AppPane.app", request([])], list);
	assert.ok("ask" in first && first.ask);
	const items = (first.ask.prompt as { items: Array<{ id: string; title: string; subtitle: string }> }).items;
	assert.deepEqual(
		items.map(({ title, subtitle }) => [title, subtitle]),
		[
			["Brave Browser", "Running · /Applications/Brave Browser.app"],
			["Slack", "/Applications/Slack.app"],
		],
	);
	const second = await paletteStep(["/agent/apps/AppPane.app", request([items[1].id])], list);
	assert.deepEqual(second, {
		show: {
			argv: ["/agent/apps/AppPane.app/Contents/MacOS/AppPane", "--app", "/Applications/Slack.app"],
			label: "Slack",
			placement: "right",
		},
	});
	assert.deepEqual(await paletteStep(["/agent/apps/AppPane.app", request(["unknown"])], list), {
		error: "That application is no longer available.",
	});
});

test("the palette command refuses invalid requests and a missing install", async () => {
	const list = async () => [brave];
	for (const args of [
		["relative", request([])],
		["/a.app", "{"],
		["/a.app", JSON.stringify({ version: 2, command: "apps.open", context: {}, answers: [] })],
		["/a.app"],
	])
		assert.deepEqual(await paletteStep(args, list), { error: "The app pane request is invalid." });
	const missing = await paletteStep(["/a.app", request([])], async () => {
		throw new Error("ENOENT");
	});
	assert.match(String((missing as { error: string }).error), /not installed/u);
});
