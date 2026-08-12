import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { completeHerdrTargets, registerHerdrCommand, shapePickerItems } from "./command.ts";
import type { HerdrClient } from "./socket.ts";

const panes = [
	{ pane_id: "w1:p1", agent: "pi", agent_status: "working", focused: true, label: "herdr build" },
	{ pane_id: "w1:p2", agent: "claude", agent_status: "blocked", label: "reviewer" },
	{ pane_id: "w1:p3", agent_status: "idle" },
];

describe("shapePickerItems", () => {
	it("lists every pane with name, id, and status", () => {
		const items = shapePickerItems(panes, "w1:p1");
		assert.equal(items.length, 3);
		assert.match(items[0].label, /herdr build — w1:p1 — working \(this pane\)/);
		assert.match(items[1].label, /reviewer — w1:p2 — blocked/);
		assert.match(items[2].label, /w1:p3 — w1:p3 — idle/);
	});

	it("puts the focused pane first when it is not the session pane", () => {
		const items = shapePickerItems(
			[{ pane_id: "w1:p2", agent: "claude", agent_status: "blocked", focused: true }],
			"w1:p1",
		);
		assert.match(items[0].label, /\(focused\)/);
	});

	it("carries the target pane id on each item", () => {
		const items = shapePickerItems(panes, "w1:p1");
		assert.deepEqual(
			items.map((item) => item.paneId),
			["w1:p1", "w1:p2", "w1:p3"],
		);
	});
});

describe("completeHerdrTargets", () => {
	it("narrows by pane id, agent name, or label", () => {
		assert.deepEqual(
			completeHerdrTargets(panes, "reviewer").map((item) => item.paneId),
			["w1:p2"],
		);
		assert.deepEqual(
			completeHerdrTargets(panes, "p3").map((item) => item.paneId),
			["w1:p3"],
		);
		assert.deepEqual(
			completeHerdrTargets(panes, "herdr build").map((item) => item.paneId),
			["w1:p1"],
		);
	});

	it("is case-insensitive and returns nothing for an unknown prefix", () => {
		assert.equal(completeHerdrTargets(panes, "REVIEWER").length, 1);
		assert.equal(completeHerdrTargets(panes, "zzz").length, 0);
	});
});

interface RegisteredCommand {
	getArgumentCompletions?: (prefix: string) => Promise<unknown>;
	handler: (args: string, ctx: unknown) => Promise<void>;
}

function commandFixture(panes: unknown[], selectChoice?: string) {
	const calls: { method: string; params: Record<string, unknown> }[] = [];
	const client = {
		async request(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
			if (method === "pane.list") return { panes };
			return {};
		},
		async send() {},
		nextSeq: () => 1,
	};
	const notifications: string[] = [];
	const statuses: (string | undefined)[] = [];
	let command: RegisteredCommand | undefined;
	const pi = {
		registerCommand(_name: string, options: RegisteredCommand) {
			command = options;
		},
	} as unknown as ExtensionAPI;
	registerHerdrCommand(pi, { client: client as unknown as HerdrClient, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" });
	const ctx = (mode = "tui"): ExtensionCommandContext =>
		({
			mode,
			ui: {
				select: async () => selectChoice,
				notify: (message: string) => notifications.push(message),
				setStatus: (text: string | undefined) => statuses.push(text),
			},
		}) as unknown as ExtensionCommandContext;
	return { calls, notifications, statuses, command: () => command, ctx };
}

describe("registerHerdrCommand", () => {
	it("focuses the pane the operator picks", async () => {
		const panes = [
			{ pane_id: "w1:p2", agent: "claude", agent_status: "blocked", label: "reviewer" },
			{ pane_id: "w1:p3", agent_status: "idle" },
		];
		const { calls, command, ctx } = commandFixture(panes, "reviewer — w1:p2 — blocked");
		await command()?.handler("", ctx());
		assert.equal(calls.some((c) => c.method === "pane.focus" && c.params.pane_id === "w1:p2"), true);
	});

	it("focuses a named target passed as an argument", async () => {
		const panes = [{ pane_id: "w1:p2", agent: "claude", agent_status: "idle", label: "reviewer" }];
		const { calls, command, ctx } = commandFixture(panes);
		await command()?.handler("reviewer", ctx());
		assert.equal(calls.some((c) => c.method === "pane.focus"), true);
	});

	it("warns when the target is unknown", async () => {
		const { calls, notifications, command, ctx } = commandFixture([{ pane_id: "w1:p2", agent_status: "idle" }]);
		await command()?.handler("ghost", ctx());
		assert.equal(calls.some((c) => c.method === "pane.focus"), false);
		assert.match(notifications.join(""), /no herdr pane or agent named ghost/);
	});

	it("declines outside interactive mode", async () => {
		const { notifications, command, ctx } = commandFixture([{ pane_id: "w1:p2", agent_status: "idle" }]);
		await command()?.handler("", ctx("rpc"));
		assert.match(notifications.join(""), /interactive mode/);
	});

	it("completes pane and agent targets", async () => {
		const panes = [{ pane_id: "w1:p2", agent: "claude", agent_status: "idle", label: "reviewer" }];
		const { command } = commandFixture(panes);
		const completions = (await command()?.getArgumentCompletions?.("rev")) as { value: string }[];
		assert.deepEqual(completions?.map((item) => item.value), ["w1:p2"]);
	});
});
