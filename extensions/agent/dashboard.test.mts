import assert from "node:assert/strict";
import { it } from "node:test";
import { fixture, source, row, page, turn, deferred, conversationFrame } from "./dashboard-test-fixture.mts";
import { agentState } from "./dashboard-state.ts";
import { dashboardActions } from "./dashboard-actions.ts";
import type { ConversationFrame } from "./live-frames.ts";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";

for (const [width, height] of [
	[140, 45],
	[80, 24],
]) {
	it(`the header qualifies a subtotal when inventory coverage is incomplete at ${width}`, async () => {
		const observed = source();
		observed.list = async () => ({
			...page([row()]),
			coverage: { complete: false, storagesVisited: 1, skipped: 0, omitted: 0, nextCursor: "more" },
		});
		const f = fixture(width, height, observed);
		try {
			await turn();
			assert.match(f.ui.render(width)[0] ?? "", /≥\$0.42 retained/);
		} finally {
			f.ui.dispose();
		}
	});
	it(`Actions states the hidden count and keeps the selected entry with neighbors at ${width}`, async () => {
		const f = fixture(width, height);
		try {
			await turn();
			f.ui.handleInput("a");
			for (let index = 0; index < dashboardActions(row()).length; index++) {
				const screen = f.ui.render(width).join("\n");
				assert.match(screen, /› /);
				if (width === 80) assert.match(screen, /\+4 more/);
				else assert.match(screen, /Reconnect[\s\S]*Run agent command[\s\S]*Details/);
				f.ui.handleInput("\x1b[B");
			}
			assert.match(f.ui.render(width).join("\n"), /› Details/);
		} finally {
			f.ui.dispose();
		}
	});
	it(`live state drives message labels and action availability at ${width}`, async () => {
		const observed = source([row("one")]);
		let notify = () => {};
		observed.subscribe = (listener) => {
			notify = listener;
			return () => {};
		};
		let frame = conversationFrame();
		observed.frame = () => frame;
		observed.availability = () => ({ state: "live", at: frame.observedAt });
		const f = fixture(width, height, observed);
		try {
			await turn();
			for (const busy of [false, true, false]) {
				frame = { ...frame, revision: frame.revision + 1, status: { ...frame.status, busy } };
				notify();
				f.ui.handleInput("\t");
				assert.match(f.ui.render(width).join("\n"), busy ? /Steer at next step/ : /Send · starts a turn/);
				f.ui.handleInput("\x1b");
				f.ui.handleInput("a");
				const screen = f.ui.render(width).join("\n");
				assert.match(screen, busy ? /Stop current work first/ : /Stop current work · No current work/);
				if (!busy) assert.doesNotMatch(screen, /Stop current work first/);
				f.ui.handleInput("\x1b");
			}
		} finally {
			f.ui.dispose();
		}
	});
	for (const outcome of ["success", "newer", "same-text-new-revision", "refusal"]) {
		it(`late admission reconciles the reopened editor (${outcome}, ${width})`, async () => {
			const gate = deferred();
			const started = deferred();
			const observed = source();
			const f = fixture(width, height, observed, {
				submit: async () => {
					started.resolve();
					await gate.promise;
					if (outcome === "refusal") throw new Error("owner refused");
					return { text: "admitted" };
				},
			});
			await turn();
			f.ui.handleInput("\t");
			f.ui.handleInput("first");
			f.ui.handleInput("\r");
			await started.promise;
			f.ui.dispose();
			const reopened = fixture(width, height, observed, undefined, f.state);
			try {
				await turn();
				reopened.ui.handleInput("\t");
				if (outcome === "newer" || outcome === "same-text-new-revision") {
					reopened.ui.handleInput("\x03");
					reopened.ui.handleInput(outcome === "newer" ? "newer" : "first");
				}
				gate.resolve();
				await turn();
				const text = outcome === "success" ? "" : outcome === "newer" ? "newer" : "first";
				assert.equal(agentState(f.state, "storage:1").draft, text);
				const screen = stripVTControlCharacters(reopened.ui.render(width).join("\n"));
				if (outcome === "success") assert.doesNotMatch(screen, /^first\s*$/m);
				reopened.ui.dispose();
				assert.equal(agentState(f.state, "storage:1").draft, text);
			} finally {
				gate.resolve();
				reopened.ui.dispose();
			}
		});
	}
	it(`Find observes and previews the current match before commit at ${width}`, async () => {
		const observed = source([
			row("one", { name: "Audit" }),
			row("two", { name: "Build" }),
			row("three", { name: "Build more" }),
		]);
		const selected: Array<string | undefined> = [];
		observed.select = (id) => selected.push(id);
		observed.snapshot = async (id) => ({
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: `Transcript for ${id}`, timestamp: 0 }] }],
			partial: false,
			revision: id,
			nextBefore: null,
		});
		const f = fixture(width, height, observed);
		try {
			await turn();
			assert.equal(f.state.selected, "one");
			f.ui.handleInput("/");
			f.ui.handleInput("Build");
			await turn();
			assert.equal(f.state.selected, "three");
			assert.equal(selected.at(-1), "three");
			assert.match(f.ui.render(width).join("\n"), /Transcript for three/);
			f.ui.handleInput("\x1b[B");
			await turn();
			assert.equal(selected.at(-1), "two");
			assert.match(f.ui.render(width).join("\n"), /Transcript for two/);
			f.ui.handleInput("\x1b");
			await turn();
			assert.equal(f.state.selected, "one");
			assert.equal(selected.at(-1), "one");
		} finally {
			f.ui.dispose();
		}
	});
	it(`Find reserves a row without deleting metadata or conversation at ${width}`, async () => {
		for (const count of [1, 3]) {
			const records = Array.from({ length: count }, (_, index) => row(`build-${index}`, { name: `Build ${index}` }));
			const f = fixture(width, height, source(records));
			try {
				await turn();
				const console = (
					f.ui as unknown as { console: { conversation: { render(width: number, height: number): string[] } } }
				).console;
				console.conversation.render = (_width, rows) =>
					Array.from({ length: rows }, (_, index) => (index === 0 ? "FIRST-CONVERSATION-LINE" : ""));
				f.ui.handleInput("/");
				f.ui.handleInput("Build");
				const lines = f.ui.render(width);
				assert.equal(lines.length, height);
				assert.match(lines.join("\n"), /› ● Build/);
				assert.match(lines.join("\n"), /FIRST-CONVERSATION-LINE/);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
			} finally {
				f.ui.dispose();
			}
		}
	});
	it(`zero matches do not start an agent and retain truthful hints at ${width}`, async () => {
		const f = fixture(width, height);
		try {
			await turn();
			f.ui.handleInput("/");
			f.ui.handleInput("no-match");
			f.ui.handleInput("\r");
			const screen = f.ui.render(width).join("\n");
			assert.match(screen, /0 matches of 1 loaded/);
			assert.match(screen, /Esc clear find/);
			assert.doesNotMatch(screen, /Enter (new agent|or n starts)/);
			f.ui.handleInput("\r");
			assert.equal(f.ui.navigation.screen, "roster");
			f.ui.handleInput("\x1b");
			assert.equal(f.state.filter, "");
			assert.equal(f.counts().closes, 0);
			f.ui.handleInput("\x1b");
			assert.equal(f.counts().closes, 1);
		} finally {
			f.ui.dispose();
		}
	});
	for (const index of [0, 1, 6]) {
		it(`action refusal is visible immediately at ${width} (action ${index})`, async () => {
			const f = fixture(width, height, source([row("one", { state: index === 0 ? "working" : "idle" })]), {
				action: async () => {
					throw new Error("Host refusal marker");
				},
			});
			try {
				await turn();
				f.ui.handleInput("a");
				for (let step = 0; step < index; step++) f.ui.handleInput("\x1b[B");
				f.ui.handleInput("\r");
				await turn();
				assert.equal(f.ui.navigation.screen, "actions");
				assert.match(f.ui.render(width).join("\n"), /Host refusal marker/);
			} finally {
				f.ui.dispose();
			}
		});
	}
	for (const action of ["fork", "rewind"]) {
		const index = dashboardActions(row()).findIndex((choice) => choice.name === action);
		it(`branch action opens the created console without losing source state at ${width} (${action})`, async () => {
			const rows = [row("one")];
			const f = fixture(width, height, source(rows), {
				action: async () => {
					rows.push(row("branch", { name: "New branch", state: "idle" }));
					return { text: "Branch created", sessionId: "branch" };
				},
			});
			try {
				await turn();
				f.ui.handleInput("\t");
				f.ui.handleInput("source draft");
				f.ui.handleInput("\x1b");
				f.ui.handleInput("a");
				for (let step = 0; step < index; step++) f.ui.handleInput("\x1b[B");
				f.ui.handleInput("\r");
				await turn();
				assert.equal(f.ui.navigation.screen, "console");
				assert.equal(f.state.selected, "branch");
				assert.match(f.ui.render(width).join("\n"), /Message to New branch.*Send · starts a turn/);
				assert.equal(agentState(f.state, "one").draft, "source draft");
			} finally {
				f.ui.dispose();
			}
		});
	}
	it(`Details retains long Unicode and exact source suffixes at ${width}`, async () => {
		const values = [`/work/${"界".repeat(150)}EXACT_PATH_END`, `provider/${"m".repeat(240)}EXACT_MODEL_END`];
		const f = fixture(width, height, undefined, { action: async () => ({ text: values.join("\n") }) });
		try {
			await turn();
			f.ui.handleInput("a");
			f.ui.handleInput("\x1b[F");
			f.ui.handleInput("\r");
			await turn();
			assert.equal(f.ui.navigation.screen, "result");
			let readable = "";
			for (let step = 0; step < 12; step++) {
				const lines = f.ui.render(width);
				assert.ok(lines.every((line) => visibleWidth(line) <= width));
				readable += lines
					.slice(1, height - 2)
					.map((line) => line.trim())
					.join("");
				f.ui.handleInput("\x1b[6~");
			}
			for (const value of values) assert.ok(readable.includes(value), `Source value missing at ${width}`);
		} finally {
			f.ui.dispose();
		}
	});
	for (const patch of [
		{ owner: "unavailable" as const, state: "unavailable" as const, error: "Claim conflict marker" },
		{ health: { lastError: "Host error marker" } },
		{
			health: { compactionFailure: { reason: "manual" as const, at: "now", errorMessage: "Compaction error marker" } },
		},
		{ health: { autoRetry: { attempt: 3, maxAttempts: 3, delayMs: 0, errorMessage: "Exhausted retry marker" } } },
		{ state: "failed" as const, error: "Work failure marker" },
	]) {
		it(`selected Attention reason appears once at ${width} (${JSON.stringify(patch)})`, async () => {
			const f = fixture(width, height, source([row("one", patch)]));
			try {
				await turn();
				const screen = f.ui.render(width).join("\n");
				assert.equal(screen.split("marker").length - 1, 1);
			} finally {
				f.ui.dispose();
			}
		});
	}
}
it("late admission adds successful message history to the reopened composer", async () => {
	const gate = deferred();
	const started = deferred();
	const observed = source();
	const f = fixture(80, 24, observed, {
		submit: async () => {
			started.resolve();
			await gate.promise;
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\t");
	f.ui.handleInput("first");
	f.ui.handleInput("\r");
	await started.promise;
	f.ui.dispose();
	const reopened = fixture(80, 24, observed, undefined, f.state);
	try {
		await turn();
		reopened.ui.handleInput("\t");
		gate.resolve();
		await turn();
		reopened.ui.handleInput("\x1b[A");
		assert.equal(agentState(f.state, "storage:1").draft, "first");
	} finally {
		gate.resolve();
		reopened.ui.dispose();
	}
});
it("a created branch outside the published roster never retains the source as its recipient", async () => {
	const sent: string[] = [];
	const f = fixture(80, 24, source([row("one")]), {
		action: async () => ({ text: "Forked", sessionId: "branch" }),
		submit: async (input) => {
			sent.push(input.id);
			return { text: "admitted" };
		},
	});
	try {
		await turn();
		f.ui.handleInput("a");
		for (let index = 0; index < dashboardActions(row()).findIndex((choice) => choice.name === "fork"); index++) f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\r");
		await turn();
		assert.equal(f.ui.navigation.screen, "console");
		assert.match(f.ui.render(80).join("\n"), /\$\?/);
		assert.doesNotMatch(f.ui.render(80).join("\n"), /test\/model high/);
		f.ui.handleInput("branch instruction");
		f.ui.handleInput("\r");
		await turn();
		assert.deepEqual(sent, ["branch"]);
	} finally {
		f.ui.dispose();
	}
});
it("late branch completion does not take focus after Escape", async () => {
	const gate = deferred();
	const entered = deferred();
	const rows = [row("one")];
	const f = fixture(80, 24, source(rows), {
		action: async () => {
			entered.resolve();
			await gate.promise;
			rows.push(row("branch"));
			return { text: "Forked", sessionId: "branch" };
		},
	});
	try {
		await turn();
		f.ui.handleInput("a");
		for (let step = 0; step < dashboardActions(row()).findIndex((choice) => choice.name === "fork"); step++) f.ui.handleInput("\x1b[B");
		f.ui.handleInput("\r");
		await entered.promise;
		f.ui.handleInput("\x1b");
		gate.resolve();
		await turn();
		assert.equal(f.state.selected, "one");
		assert.equal(f.ui.navigation.screen, "roster");
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});
it("late new-agent completion respects arrow selection", async () => {
	const gate = deferred();
	const created = deferred();
	const rows = [row("one")];
	const f = fixture(80, 24, source(rows), {
		newAgent: async ({ prompt, onCreated }) => {
			const starting = row("two", { state: "starting", firstMessage: prompt });
			rows.push(starting);
			onCreated(starting);
			created.resolve();
			await gate.promise;
			return { text: "Started", sessionId: "two" };
		},
	});
	try {
		await turn();
		f.ui.handleInput("n");
		f.ui.handleInput("task");
		f.ui.handleInput("\r");
		await created.promise;
		f.ui.handleInput("\x1b[A");
		assert.equal(f.state.selected, "one");
		gate.resolve();
		await turn();
		assert.equal(f.state.selected, "one");
	} finally {
		gate.resolve();
		f.ui.dispose();
	}
});
it("roster publication preserves arrow order during a navigation sequence", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let rows = [row("one", { modifiedAt: 3 }), row("two", { modifiedAt: 2 }), row("three", { modifiedAt: 1 })];
	const observed = source();
	observed.list = async () => page(rows);
	let notify = () => {};
	observed.subscribeRoster = (listener) => {
		notify = listener;
		return () => {};
	};
	const f = fixture(80, 24, observed);
	try {
		await turn();
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "two");
		rows = [row("one", { modifiedAt: 3 }), row("two", { modifiedAt: 0 }), row("three", { modifiedAt: 1 })];
		notify();
		t.mock.timers.tick(250);
		await turn();
		f.ui.handleInput("\x1b[B");
		assert.equal(f.state.selected, "three");
	} finally {
		f.ui.dispose();
	}
});

it("the dashboard opens on the roster and Esc returns without a primary mutation", async () => {
	const f = fixture();
	await turn();
	assert.equal(f.ui.navigation.screen, "roster");
	assert.match(f.ui.render(80).join("\n"), /storage:1/);
	f.ui.handleInput("x");
	assert.match(f.ui.render(80).join("\n"), /Tab to write/);
	f.ui.handleInput("\x1b");
	assert.equal(f.counts().closes, 1);
});
it("find has a separate text destination and Esc clears the committed filter before close", async () => {
	const f = fixture(80, 24, source([row("one"), row("two")]));
	await turn();
	f.ui.handleInput("/");
	f.ui.handleInput("two");
	f.ui.handleInput("\r");
	assert.equal(f.state.filter, "two");
	assert.equal(f.state.selected, "two");
	f.ui.handleInput("\x1b");
	assert.equal(f.state.filter, "");
	assert.equal(f.counts().closes, 0);
	f.ui.handleInput("\x1b");
	assert.equal(f.counts().closes, 1);
});
it("a late send receipt keeps a newer draft and never changes focus", async () => {
	let finish!: () => void;
	const gate = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const sent: string[] = [];
	const f = fixture(80, 24, source([row("one"), row("two")]), {
		submit: async (input) => {
			sent.push(input.id);
			await gate;
			return { text: "admitted" };
		},
	});
	await turn();
	f.ui.handleInput("\t");
	f.ui.handleInput("first");
	f.ui.handleInput("\r");
	f.ui.handleInput("\x1b");
	f.ui.handleInput("\x1b[B");
	assert.equal(f.state.selected, "two");
	agentState(f.state, "one").draft = "newer";
	finish();
	await turn();
	assert.deepEqual(sent, ["one"]);
	assert.equal(f.state.selected, "two");
	assert.equal(f.ui.navigation.screen, "roster");
	assert.equal(agentState(f.state, "one").draft, "newer");
	f.ui.dispose();
});
it("new agent selects its task and starting conversation before host readiness", async () => {
	const rows = [row("one")];
	const observed = source(rows);
	observed.snapshot = async () => ({ entries: [], partial: false, revision: "empty", nextBefore: null });
	const created = deferred();
	const release = deferred();
	const f = fixture(140, 45, observed, {
		newAgent: async ({ prompt, onCreated }) => {
			const starting = row("two", { name: undefined, firstMessage: prompt, state: "starting" });
			rows.push(starting);
			onCreated(starting);
			created.resolve();
			await release.promise;
			return { text: "Started", sessionId: "two" };
		},
	});
	try {
		await turn();
		f.ui.handleInput("n");
		f.ui.handleInput("Write the startup note");
		f.ui.handleInput("\r");
		await created.promise;
		assert.equal(f.state.selected, "two");
		assert.equal(f.ui.navigation.screen, "roster");
		for (const [width, height] of [
			[140, 45],
			[80, 24],
		]) {
			f.resize(width, height);
			const screen = f.ui.render(width).join("\n");
			assert.match(screen, /STARTING/);
			assert.match(screen, /Starting/);
			assert.match(screen, /2 working/);
			assert.match(screen, /Write the startup note/);
			assert.match(screen, /Message to Write the startup note/);
			assert.match(screen, /test\/model high.*starting/);
			assert.doesNotMatch(
				screen,
				/Conversation unavailable|Unavailable|Attention|need attention|Message to two|model \?|reasoning \?/,
			);
		}
		await turn();
		assert.match(f.ui.render(140).join("\n"), /STARTING/);
		assert.doesNotMatch(f.ui.render(140).join("\n"), /Conversation unavailable/);
	} finally {
		release.resolve();
		await turn();
		f.ui.dispose();
	}
});

it("a busy live frame updates the header, roster, and footer together", async () => {
	const observed = source([row("one", { state: "done" })]);
	let changed = () => {};
	observed.subscribe = (listener) => {
		changed = listener;
		return () => {};
	};
	let frame: ConversationFrame | undefined;
	observed.frame = () => frame;
	observed.availability = () => (frame ? { state: "live", at: frame.observedAt } : undefined);
	const f = fixture(140, 45, observed);
	try {
		await turn();
		frame = conversationFrame();
		changed();
		const screen = f.ui.render(140).join("\n");
		assert.match(screen, /1 working/);
		assert.match(screen, /Working/);
		assert.match(screen, /test\/model high.*working/);
		assert.doesNotMatch(screen, /Done|0 working/);
		f.ui.handleInput("/");
		assert.match(f.ui.render(140).join("\n"), /1 working/);
	} finally {
		f.ui.dispose();
	}
});

it("a late cold snapshot error never replaces a live conversation", async () => {
	const observed = source([row("one")]);
	let fail!: (error: Error) => void;
	observed.snapshot = () =>
		new Promise((_resolve, reject) => {
			fail = reject;
		});
	let changed = () => {};
	observed.subscribe = (listener) => {
		changed = listener;
		return () => {};
	};
	let frame: ConversationFrame | undefined;
	observed.frame = () => frame;
	observed.availability = () => (frame ? { state: "live", at: frame.observedAt } : undefined);
	const f = fixture(140, 45, observed);
	try {
		await turn();
		frame = conversationFrame({
			entries: [{ id: "1", kind: "pi.user", model: [{ role: "user", content: "Live task", timestamp: 0 }] }],
		});
		changed();
		fail(new Error("ENOENT: source was absent before the host started"));
		await turn();
		const screen = f.ui.render(140).join("\n");
		assert.match(screen, /LIVE/);
		assert.match(screen, /Live task/);
		assert.doesNotMatch(screen, /Conversation unavailable|ENOENT/);
	} finally {
		f.ui.dispose();
	}
});

it("new agent returns to roster and selects the created identity", async () => {
	const rows = [row("one")];
	const observed = source(rows);
	const f = fixture(80, 24, observed, {
		newAgent: async () => {
			rows.push(row("two"));
			return { text: "Started", sessionId: "two" };
		},
	});
	await turn();
	f.ui.handleInput("n");
	f.ui.handleInput("task");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.state.selected, "two");
	assert.equal(f.ui.navigation.screen, "roster");
	assert.equal(f.state.newTask, "");
	f.ui.dispose();
});

it("a retained conversation reattaches and rereads when a stopped host restarts", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	let current = row("new", { state: "stopped", modifiedAt: 1 });
	const observed = source([current]);
	let rosterChange = () => {};
	const refreshed: string[] = [];
	let reads = 0;
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async () => page([current]);
	observed.refresh = (id) => refreshed.push(id);
	observed.availability = () => ({ state: "unavailable", at: new Date(0).toISOString() });
	observed.snapshot = async () => {
		reads++;
		return {
			entries: [
				{
					id: "1",
					kind: "pi.user",
					model: [{ role: "user", content: reads === 1 ? "Stored task" : "Restarted task", timestamp: 0 }],
				},
			],
			partial: false,
			revision: "2",
			nextBefore: null,
		};
	};
	const f = fixture(80, 24, observed);
	await turn();
	await turn();
	assert.match(f.ui.render(80).join("\n"), /RETAINED/);
	assert.match(f.ui.render(80).join("\n"), /Stored task/);
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	assert.deepEqual(refreshed, []);
	current = row("new", { state: "working", modifiedAt: 2, cost: 0.43 });
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	await turn();
	assert.deepEqual(refreshed, ["new"]);
	assert.equal(reads, 2);
	const screen = f.ui.render(80).join("\n");
	assert.doesNotMatch(screen, /Conversation unavailable/);
	assert.match(screen, /Restarted task/);
	f.ui.dispose();
});

it("Load more is selected before admission and loaded coverage survives reconciliation", async (t) => {
	t.mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"] });
	const observed = source();
	let rosterChange = () => {};
	const calls: Array<string | undefined> = [];
	observed.subscribeRoster = (listener) => {
		rosterChange = listener;
		return () => {};
	};
	observed.list = async (input) => {
		calls.push(input?.cursor);
		return input?.cursor
			? {
					...page([row("c")]),
					coverage: { complete: true, storagesVisited: 1, skipped: 2, omitted: 0, nextCursor: null },
				}
			: {
					...page([row("a"), row("b")]),
					coverage: { complete: false, storagesVisited: 1, skipped: 1, omitted: 0, nextCursor: "more" },
				};
	};
	const f = fixture(80, 24, observed);
	await turn();
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\x1b[B");
	assert.deepEqual(calls, [undefined]);
	assert.match(f.ui.render(80).join("\n"), /› Load more agents/);
	f.ui.handleInput("\r");
	await turn();
	assert.deepEqual(calls, [undefined, "more"]);
	assert.match(f.ui.render(80).join("\n"), /3 agents/);
	rosterChange();
	t.mock.timers.tick(250);
	await turn();
	assert.deepEqual(calls, [undefined, "more", undefined, "more"]);
	assert.match(f.ui.render(80).join("\n"), /3 stores skipped/);
	f.ui.dispose();
});

it("Tasks opens a resolved unloaded conversation, releases its graph, and Esc returns to roster", async () => {
	const observed = source([row("storage")]);
	let active = false;
	let releases = 0;
	const selected: Array<string | undefined> = [];
	observed.select = (id) => selected.push(id);
	observed.releaseTasks = () => {
		if (active) releases++;
		active = false;
	};
	observed.tasks = async () => {
		active = true;
		return {
			scope: "tasks",
			storageId: "storage",
			revision: 1,
			observedAt: new Date(0).toISOString(),
			coverage: { complete: true, live: true },
			labels: [{ conversationId: 2, identity: "storage:2", name: "Child" }],
			tasks: [
				{
					id: 1,
					kind: "turn",
					conversationId: 2,
					background: false,
					abortRequested: false,
					status: "running",
					phase: "model",
					waitsOn: [],
					conversations: [2],
				},
			],
		};
	};
	const f = fixture(80, 24, observed);
	await turn();
	f.ui.handleInput("a");
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\x1b[B");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.ui.navigation.screen, "tasks");
	f.ui.handleInput("\r");
	await turn();
	assert.equal(f.ui.navigation.screen, "console");
	assert.equal(f.state.selected, "storage:2");
	assert.ok(selected.includes("storage:2"));
	assert.equal(active, false);
	assert.equal(releases, 1);
	const screen = f.ui.render(80).join("\n");
	assert.match(screen, /Child/);
	assert.match(screen, /\$\?/);
	f.ui.handleInput("\x1b");
	assert.equal(f.ui.navigation.screen, "roster");
	f.ui.dispose();
});
