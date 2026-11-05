import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CURSOR_MARKER, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { NavigationFrame } from "../../operator-ui/index.ts";
import { actionView, type AgentFormHost } from "./agent-forms.ts";
import { createDashboardState } from "./dashboard-state.ts";
import { type FormCall, fixture, formsHost, row, source, theme, turn } from "./dashboard-test-fixture.mts";
import type { AgentProfile } from "./profile-schema.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const plain = (line: string) => stripVTControlCharacters(line).trimEnd();
const TAB = "\t";
const END = "\u001b[F";

async function until(shown: () => string, pattern: RegExp, label: string): Promise<string> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const text = shown();
		if (pattern.test(text)) return text;
		await turn();
	}
	throw new Error(`the view never showed ${label}; last screen:\n${shown()}`);
}

it("the New conversation form reveals the Directory field after two Tabs at 60x20", async () => {
	const f = fixture(60, 20, source([row()]));
	try {
		await turn();
		await turn();
		f.ui.openNamedAction("new");
		await turn();
		const shown = () => f.ui.render(60).map(plain).join("\n");
		assert.match(shown(), /Purpose/, "the first field is visible");
		f.ui.handleInput(TAB);
		await turn();
		f.ui.handleInput(TAB);
		await turn();
		const directory = f.ui.render(60).find((line) => plain(line).includes("Directory"));
		assert.ok(directory, "Directory is visible after two Tabs");
		assert.ok(directory.includes(CURSOR_MARKER), "and it holds the caret");
	} finally {
		f.ui.dispose();
	}
});

const profile: AgentProfile = {
	identity: "storage:1",
	handle: "@history",
	name: "History expert",
	role: "Study decisions",
	expertise: "Sourced fact about a decision. ".repeat(48).trim(),
	revision: "a".repeat(64),
	updatedAt: 1,
	updatedBy: "editor",
	creator: "founder",
	model: { provider: "test", modelId: "model" },
	thinkingLevel: "high",
	cwd: "/work",
	live: false,
	requests: [],
};

it("the profile editor reveals the expertise caret at the end of a long value", async () => {
	const target = row("storage:1", { name: "Parser review" });
	const calls: FormCall[] = [];
	const host: AgentFormHost = formsHost(target, createDashboardState(), source([target]), calls, {
		profile: async (method) =>
			method === "profile-read" ? profile : { outcome: "applied", deduped: false, profile: { ...profile, revision: "b".repeat(64) } },
	});
	const frame = new NavigationFrame({
		theme,
		target: { id: target.id, label: "Parser review" },
		destinations: () => [{ key: "profile", label: "Profile", open: (view) => actionView("profile", host, view) }],
		rows: () => 24,
		requestRender: () => {},
		close: () => {},
	});
	const raw = () => frame.render(80);
	const shown = () => raw().map(plain).join("\n");
	await until(shown, /Profile: @history/, "the profile");
	frame.render(80);
	const edit = frame.viewActions.find((action) => action.label === "Edit role or expertise");
	assert.ok(edit, "the profile offers its editor");
	edit.run();
	await until(shown, /Edit the profile of/, "the profile editor");
	frame.handleInput(TAB);
	frame.handleInput(END);
	for (let step = 0; step < 2; step++) frame.handleInput("Z");
	const lines = raw();
	assert.ok(lines.some((line) => plain(line).includes("ZZ") && line.includes(CURSOR_MARKER)), "typing at the caret is visible");
	assert.ok(lines.some((line) => /esc cancel/.test(plain(line))), "the footer stays on the last row");
	assert.deepEqual(calls.filter((call) => call.name === "profile-update"), [], "nothing was saved");
});
