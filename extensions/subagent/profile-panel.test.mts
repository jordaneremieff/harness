import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	TuiMainScreen,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "./console.ts";
import { openProfilePanel, type ProfilePanelDefinition, type ProfilePanelDeps } from "./profile-panel.ts";
import type { ProfileEntry } from "./profiles.ts";

type Component = {
	focused: boolean;
	render(width: number): string[];
	handleInput(data: string): void;
	invalidate(): void;
	dispose(): void;
};
const theme = {
	getBgAnsi: (color: string) => (color === "selectedBg" ? "\x1b[44m" : "\x1b[40m"),
	fg: (_color: string, text: string) => `\x1b[37m${text}\x1b[39m`,
	bg: (color: string, text: string) => `${color === "selectedBg" ? "\x1b[44m" : "\x1b[40m"}${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
} as unknown as Theme;
const tab = "\t";
const enter = "\r";
const esc = "\x1b";
const up = "\x1b[A";
const down = "\x1b[B";
const save = "\x13";
function record(name: string, overrides = {}): Extract<ProfileEntry, { ok: true }> {
	return {
		ok: true,
		name,
		path: `/profiles/${name}.json`,
		sha256: "a".repeat(64),
		enabled: true,
		grounding: [],
		...overrides,
	};
}
function store(initial: ProfileEntry[] = []) {
	const entries = new Map(initial.map((entry) => [entry.name, entry]));
	const calls: { action: string; name: string; definition?: ProfilePanelDefinition; sha256?: string }[] = [];
	let fail = "";
	let truncated = false;
	const check = (name: string, sha256: string) => {
		if (fail) throw new Error(fail);
		const entry = entries.get(name);
		if (!entry || !("sha256" in entry) || entry.sha256 !== sha256)
			throw new Error("Profile changed. Refresh before another write.");
	};
	const validate = (name: string, definition: ProfilePanelDefinition) => {
		if (!name || /\s/.test(name)) throw new Error("Expected a profile name.");
		if (!Array.isArray(definition.grounding)) throw new Error("Grounding must be an array.");
		if (fail) throw new Error(fail);
	};
	const deps: ProfilePanelDeps = {
		list: () => {
			if (fail === "list failed") throw new Error(fail);
			return { entries: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)), truncated };
		},
		read: (name) => {
			if (fail === "read failed") throw new Error(fail);
			return entries.get(name)!;
		},
		create: (name, definition) => {
			calls.push({ action: "create", name, definition });
			validate(name, definition);
			if (entries.has(name)) throw new Error("Profile already exists.");
			const entry = record(name, definition);
			entries.set(name, entry);
			return entry;
		},
		update: (name, definition, sha256) => {
			calls.push({ action: "update", name, definition, sha256 });
			check(name, sha256);
			validate(name, definition);
			const entry = record(name, { ...definition, sha256: "b".repeat(64) });
			entries.set(name, entry);
			return entry;
		},
		remove: (name, sha256) => {
			calls.push({ action: "remove", name, sha256 });
			check(name, sha256);
			entries.delete(name);
		},
		setEnabled: (name, enabled, sha256) => {
			calls.push({ action: "toggle", name, sha256 });
			check(name, sha256);
			const entry = record(name, { ...entries.get(name), enabled, sha256: "b".repeat(64) });
			entries.set(name, entry);
			return entry;
		},
	};
	return {
		deps,
		entries,
		calls,
		setFail: (value: string) => {
			fail = value;
		},
		setTruncated: () => {
			truncated = true;
		},
	};
}
async function panel(
	deps: ProfilePanelDeps,
	run: (component: Component, terminal: { rows: number }, closed: () => number) => void,
	filter?: string,
	keys = new KeybindingsManager(TUI_KEYBINDINGS),
) {
	let closes = 0;
	const terminal = { rows: 30 };
	const ctx = {
		ui: {
			custom: async (
				factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => Component,
				options: unknown,
			) => {
				assert.deepEqual(options, {
					overlay: true,
					overlayOptions: { width: "90%", minWidth: 100, maxHeight: "100%", margin: 1 },
				});
				const component = factory({ terminal, requestRender() {} }, theme, keys, () => {
					closes++;
				});
				component.focused = true;
				try {
					run(component, terminal, () => closes);
				} finally {
					component.dispose();
					component.dispose();
				}
			},
		},
	} as unknown as ExtensionCommandContext;
	await openProfilePanel(ctx, deps, filter);
}
function text(component: Component, width = 100) {
	return component.render(width).map(stripTerminalSequences).join("\n");
}
function press(component: Component, ...keys: string[]) {
	for (const key of keys) component.handleInput(key);
}
function replace(component: Component, value: string) {
	press(component, "\x01", "\x0b", value);
}

describe("profile manager", () => {
	it("creates a complete profile through native fields and commits only on Save", async () => {
		const s = store();
		await panel(s.deps, (c) => {
			assert.match(text(c), /No profiles/);
			press(c, "n", "review", tab, "provider/model", tab, " ", " ", " ", " ", " ", tab, "/project", tab);
			replace(c, '[{"name":"guide","path":"/docs/guide.md"}]');
			press(c, tab, " ");
			assert.match(text(c), /Enabled: false/);
			assert.equal(s.calls.length, 0);
			press(c, tab, "First instruction.", enter, "Second instruction.", tab, enter);
			assert.equal(s.calls.length, 1);
			assert.deepEqual(s.calls[0], {
				action: "create",
				name: "review",
				definition: {
					model: "provider/model",
					thinking: "high",
					cwd: "/project",
					grounding: [{ name: "guide", path: "/docs/guide.md" }],
					enabled: false,
					instructions: "First instruction.\nSecond instruction.",
				},
			});
			assert.match(text(c), /review · disabled/);
		});
	});
	it("updates captured identity and digest and leaves the stored name immutable", async () => {
		const s = store([
			record("review", {
				model: "old",
				cwd: "/project",
				thinking: "low",
				grounding: [{ name: "guide", path: "/guide.md" }],
			}),
		]);
		await panel(s.deps, (c) => {
			press(c, enter, up, "different");
			assert.match(text(c), /Name: review/);
			assert.equal(c.render(100).join("").includes(CURSOR_MARKER), false);
			press(c, tab);
			replace(c, "new");
			press(c, save);
			assert.equal(s.calls[0].name, "review");
			assert.equal(s.calls[0].sha256, "a".repeat(64));
			assert.deepEqual(s.calls[0].definition, {
				model: "new",
				cwd: "/project",
				thinking: "low",
				grounding: [{ name: "guide", path: "/guide.md" }],
				enabled: true,
			});
		});
	});
	it("cancels create, edit, and Save/Cancel field actions without mutation", async () => {
		const s = store([record("review")]);
		await panel(s.deps, (c, _t, closed) => {
			press(c, "n", "draft", esc, enter, "model", esc);
			press(c, "n", "other", up, enter);
			assert.match(text(c), /Profiles/);
			assert.equal(s.calls.length, 0);
			press(c, esc, esc);
			assert.equal(closed(), 1);
			assert.equal(c.focused, false);
		});
	});
	it("retains input after JSON and store validation failures", async () => {
		const s = store();
		await panel(s.deps, (c) => {
			press(c, "n", tab, "saved-model", tab, tab, tab);
			replace(c, "{");
			press(c, save);
			assert.match(text(c), /Grounding must contain valid JSON/);
			assert.equal(s.calls.length, 0);
			replace(c, "{}");
			press(c, save);
			assert.match(text(c), /Expected a profile name/);
			press(c, up, up, up, up, "review", save);
			assert.match(text(c), /Grounding must be an array/);
			press(c, tab);
			assert.match(text(c), /saved-model/);
			press(c, tab, tab, tab);
			replace(c, "[]");
			press(c, save);
			assert.equal(s.entries.get("review")?.ok, true);
		});
	});
	it("refuses stale writes without replacing the draft or captured digest", async () => {
		const s = store([record("review")]);
		await panel(s.deps, (c) => {
			press(c, enter, "draft-model");
			s.entries.set("review", record("review", { sha256: "c".repeat(64) }));
			press(c, save);
			assert.match(text(c), /Profile changed/);
			assert.match(text(c), /draft-model/);
			press(c, save);
			assert.equal(s.calls[1].sha256, "a".repeat(64));
			press(c, esc, enter);
			assert.doesNotMatch(text(c), /draft-model/);
		});
	});
	it("confirms removal explicitly, preserves failed confirmation, and toggles", async () => {
		const s = store([record("review")]);
		await panel(s.deps, (c) => {
			press(c, "d", enter);
			assert.equal(s.calls.length, 0);
			press(c, "d", tab, esc);
			assert.equal(s.calls.length, 0);
			press(c, "t");
			assert.match(text(c), /disabled/);
			press(c, "t");
			assert.match(text(c), /enabled/);
			press(c, "d", tab);
			s.setFail("write refused");
			press(c, enter);
			assert.match(text(c), /write refused/);
			s.setFail("");
			press(c, enter);
			assert.equal(s.entries.size, 0);
			assert.match(text(c), /Removed review/);
		});
	});
	it("preserves named selection across reorder, refresh, filter cancellation, and list failures", async () => {
		const s = store([record("alpha"), record("zulu")]);
		await panel(s.deps, (c) => {
			press(c, down);
			s.entries.set("beta", record("beta"));
			press(c, "r", "t");
			assert.equal(s.calls[0].name, "zulu");
			press(c, "/", "alpha", esc, "t");
			assert.equal(s.calls[1].name, "zulu");
			s.setFail("list failed");
			press(c, "r");
			assert.match(text(c), /list failed/);
			s.setFail("");
			press(c, "/", "alpha", enter, "t");
			assert.equal(s.calls[2].name, "alpha");
		});
	});
	it("shows truncation, broken files, readable errors, and blocks mutations without a digest", async () => {
		const s = store([
			{ ok: false, name: "broken", path: "/profiles/broken.json", error: "Bad file\x1b[2J\u202ereversed" },
		]);
		s.setTruncated();
		await panel(s.deps, (c) => {
			assert.match(text(c), /partial/);
			assert.match(text(c), /broken/);
			assert.ok(!c.render(100).join("").includes("\x1b[2J"));
			press(c, "e");
			assert.match(text(c), /No readable digest/);
			press(c, "d");
			assert.match(text(c), /No readable digest/);
			press(c, "t");
			assert.match(text(c), /Broken profile/);
			assert.equal(s.calls.length, 0);
		});
	});
	it("replaces and removes broken profiles with a captured readable digest", async () => {
		const broken = {
			ok: false as const,
			name: "broken",
			path: "/profiles/broken.json",
			error: "Bad JSON",
			sha256: "a".repeat(64),
		};
		const s = store([broken]);
		await panel(s.deps, (c) => {
			press(c, "e", "repaired-model", save);
			assert.equal(s.entries.get("broken")?.ok, true);
			assert.equal(s.calls[0].sha256, broken.sha256);
		});
		const r = store([broken]);
		await panel(r.deps, (c) => {
			press(c, "d", tab, enter);
			assert.equal(r.entries.size, 0);
		});
	});
	it("keeps fields and controls reachable after narrow and short resizes", async () => {
		const s = store();
		await panel(s.deps, (c, t) => {
			press(c, "n", "界".repeat(100));
			for (const rows of [30, 12, 8, 5, 3])
				for (const width of [100, 30, 20, 8, 1]) {
					t.rows = rows;
					for (let i = 0; i < 9; i++) {
						const lines = c.render(width);
						assert.ok(lines.length <= Math.max(1, rows - 2));
						for (const line of lines) assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
						press(c, tab);
					}
				}
			t.rows = 8;
			for (let i = 0; i < 9; i++) {
				assert.match(text(c, 30), new RegExp(`${i + 1}/9`));
				press(c, tab);
			}
			press(c, esc, "?", ...Array.from({ length: 80 }, () => down));
			assert.match(text(c, 30), /Escape\s+returns/);
		});
	});
	it("forwards focus to native input and restores the prior focus through public TUI overlays", async () => {
		const terminal = {
			rows: 30,
			columns: 100,
			write() {},
			start() {},
			stop() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			drainInput: async () => {},
			kittyProtocolActive: false,
			setProgress() {},
			get isKittyProtocolActive() {
				return false;
			},
		};
		const tui = new TuiMainScreen(terminal);
		const previous = { focused: false, render: () => ["prior draft"], invalidate() {} };
		tui.setFocus(previous);
		const deps = store().deps;
		const ctx = {
			ui: {
				custom: async (factory: (tui: unknown, theme: Theme, keys: unknown, done: () => void) => Component) => {
					const c = factory(tui, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => {});
					const handle = tui.showOverlay(c, { width: "90%" });
					press(c, "n", "abc");
					assert.equal(previous.focused, false);
					assert.equal(c.focused, true);
					assert.ok(c.render(90).join("").includes(CURSOR_MARKER));
					handle.unfocus();
					assert.equal(c.focused, false);
					assert.ok(!c.render(90).join("").includes(CURSOR_MARKER));
					handle.focus();
					assert.ok(c.render(90).join("").includes(CURSOR_MARKER));
					tui.hideOverlay();
					assert.equal(previous.focused, true);
					assert.equal(c.focused, false);
					c.dispose();
				},
			},
		} as unknown as ExtensionCommandContext;
		try {
			await openProfilePanel(ctx, deps);
		} finally {
			tui.stop();
		}
	});
	it("retains untouched multiline instructions and uses native normalization only after text changes", async () => {
		const original = "Keep\ttabs.\r\nKeep lines.\n";
		const s = store([record("review", { instructions: original })]);
		await panel(s.deps, (c) => {
			press(c, enter, "model", save);
			assert.equal(s.calls[0].definition?.instructions, original);
			press(c, "t");
			assert.equal((s.entries.get("review") as { instructions: string }).instructions, original);
			press(c, enter, tab, tab, tab, tab, tab, "cancelled", esc);
			assert.equal((s.entries.get("review") as { instructions: string }).instructions, original);
			press(c, enter, tab, tab, tab, tab, tab, "Added.", enter, "Another line.");
			assert.equal(s.calls.length, 2, "Enter must not save instructions");
			press(c, save);
			assert.equal(s.calls[2].definition?.instructions, "Keep    tabs.\nKeep lines.\nAdded.\nAnother line.");
		});
	});
	it("keeps the native multiline cursor visible through short resizes and rejects direction controls", async () => {
		await panel(store().deps, (c, terminal) => {
			press(c, "n", "review", tab, tab, tab, tab, tab, tab);
			press(c, "first", enter, "second", enter, "third", enter, "fourth", enter, "fifth", enter, "sixth");
			for (const rows of [30, 12, 8, 5]) {
				terminal.rows = rows;
				const rendered = c.render(30);
				assert.ok(rendered.length <= rows - 2);
				assert.ok(rendered.join("").includes(CURSOR_MARKER));
			}
			terminal.rows = 20;
			press(c, "\u202e");
			assert.match(text(c), /refuse control characters/);
			assert.ok(!c.render(30).join("").includes("\u202e"));
		});
	});
	it("restores enclosing backgrounds after theme resets and retains frame/footer order", async () => {
		await panel(store([record("review")]).deps, (c) => {
			const lines = c.render(100);
			assert.match(stripTerminalSequences(lines[0]), /^┌/);
			assert.match(stripTerminalSequences(lines.at(-3)!), /^├/);
			assert.match(stripTerminalSequences(lines.at(-2)!), /esc close/);
			assert.match(stripTerminalSequences(lines.at(-1)!), /^└/);
			assert.ok(lines[0].includes("\x1b[0m\x1b[40m"));
			assert.ok(lines.some((line) => line.includes("\x1b[44m")));
			press(c, "n", "\x1b[200~bad\x1b[2J\u202etext\x1b[201~");
			assert.ok(!c.render(100).join("").includes("\x1b[2J"));
			assert.ok(!text(c).includes("\u202e"));
			c.invalidate();
		});
	});
});
