import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HerdrError } from "./socket.ts";
import { callHerdr, createHerdrTools, FORBIDDEN_METHODS, type ToolDeps } from "./tools.ts";

interface Recorded {
	method: string;
	params: Record<string, unknown>;
}

const PANES = {
	panes: [
		{ pane_id: "w1:p1", tab_id: "w1:t1", agent: "pi", agent_status: "working", focused: true },
		{ pane_id: "w1:p2", tab_id: "w1:t1", agent_status: "idle" },
	],
};

/** A herdr client stand-in serving canned results and recording every request. */
function fakeDeps(responses: Record<string, unknown | (() => unknown)> = {}): { deps: ToolDeps; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const client = {
		async request(method: string, params: Record<string, unknown>) {
			calls.push({ method, params });
			const canned = responses[method];
			if (canned === undefined) throw new HerdrError("not_found", `no canned response for ${method}`);
			return typeof canned === "function" ? (canned as () => unknown)() : canned;
		},
		async send() {},
		nextSeq: () => 1,
	};
	return {
		deps: { client: client as never, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1" },
		calls,
	};
}

/** One tool set per deps, as in a real session, so the per-pane queue is shared. */
const toolSets = new WeakMap<ToolDeps, ReturnType<typeof createHerdrTools>>();

function toolsFor(deps: ToolDeps) {
	let set = toolSets.get(deps);
	if (!set) {
		set = createHerdrTools(deps);
		toolSets.set(deps, set);
	}
	return set;
}

function tool(deps: ToolDeps, name: string) {
	const found = toolsFor(deps).find((candidate) => candidate.name === name);
	assert.ok(found, `tool ${name} exists`);
	return found;
}

async function run(deps: ToolDeps, name: string, params: unknown): Promise<string> {
	const result = await tool(deps, name).execute("call-1", params as never, undefined, undefined, {} as ExtensionContext);
	const first = result.content[0];
	return first.type === "text" ? first.text : "";
}

describe("herdr tool surface", () => {
	it("registers only inspection and coordination tools", () => {
		const { deps } = fakeDeps();
		const names = createHerdrTools(deps).map((definition) => definition.name);
		assert.deepEqual(
			names.filter((name) => !name.startsWith("herdr_")),
			[],
		);
		assert.ok(names.includes("herdr_snapshot"));
		assert.ok(names.includes("herdr_agent_prompt"));
	});

	it("keeps every destructive method out of the tool layer", async () => {
		const { deps, calls } = fakeDeps();
		for (const method of ["server.stop", "pane.close", "tab.close", "workspace.close", "worktree.remove", "plugin.link"]) {
			assert.ok(FORBIDDEN_METHODS.has(method), `${method} is refused`);
			await assert.rejects(callHerdr(deps, method, {}), /not available to tools/);
		}
		assert.deepEqual(calls, [], "a refused method never reaches the socket");
	});

	it("reports a herdr error with its code", async () => {
		const { deps } = fakeDeps();
		await assert.rejects(callHerdr(deps, "agent.list", {}), /herdr agent.list failed \(not_found\)/);
	});
});

describe("herdr inspection tools", () => {
	it("summarizes the session snapshot by workspace and tab", async () => {
		const { deps } = fakeDeps({
			"session.snapshot": {
				snapshot: {
					workspaces: [{ workspace_id: "w1", label: "herdr" }],
					tabs: [{ tab_id: "w1:t1", workspace_id: "w1", label: "1" }],
					panes: PANES.panes,
				},
			},
		});
		const text = await run(deps, "herdr_snapshot", {});
		assert.match(text, /workspace w1 herdr/);
		assert.match(text, /tab w1:t1 1/);
		assert.match(text, /w1:p1 \(this pane\)/);
		assert.match(text, /agent=pi status=working/);
	});

	it("lists the panes of its own workspace", async () => {
		const { deps, calls } = fakeDeps({ "pane.list": PANES });
		const text = await run(deps, "herdr_panes", {});
		assert.match(text, /w1:p2/);
		assert.deepEqual(calls[0], { method: "pane.list", params: { workspace_id: "w1" } });
	});

	it("describes agents with their status", async () => {
		const { deps } = fakeDeps({
			"agent.list": {
				agents: [{ pane_id: "w1:p2", name: "reviewer", agent: "claude", agent_status: "blocked", interactive_ready: false }],
			},
		});
		const text = await run(deps, "herdr_agents", {});
		assert.match(text, /reviewer pane=w1:p2 kind=claude status=blocked starting/);
	});

	it("asks for the current pane with its own pane as caller", async () => {
		const { deps, calls } = fakeDeps({ "pane.current": { pane: PANES.panes[0] } });
		await run(deps, "herdr_current", {});
		assert.deepEqual(calls[0].params, { caller_pane_id: "w1:p1" });
	});

	it("reads a pane and marks a herdr-side truncation", async () => {
		const { deps, calls } = fakeDeps({
			"pane.list": PANES,
			"pane.read": { read: { text: "build ok", truncated: true } },
		});
		const text = await run(deps, "herdr_read", { pane_id: "w1:p2" });
		assert.match(text, /build ok/);
		assert.match(text, /herdr truncated this read/);
		assert.equal(calls[1].method, "pane.read");
		assert.equal(calls[1].params.source, "recent");
	});

	it("caps a very long read", async () => {
		const { deps } = fakeDeps({
			"pane.list": PANES,
			"pane.read": { read: { text: "x".repeat(20000) } },
		});
		const text = await run(deps, "herdr_read", { pane_id: "w1:p2" });
		assert.ok(text.length < 20000);
		assert.match(text, /output truncated/);
	});
});

describe("herdr target resolution", () => {
	it("refuses a pane that no longer exists", async () => {
		const { deps } = fakeDeps({ "pane.list": PANES });
		await assert.rejects(run(deps, "herdr_send_text", { pane_id: "w1:p9", text: "x" }), /no pane w1:p9/);
	});

	it("re-reads the pane list before every write", async () => {
		const { deps, calls } = fakeDeps({ "pane.list": PANES, "pane.send_text": {} });
		await run(deps, "herdr_send_text", { pane_id: "w1:p2", text: "one" });
		await run(deps, "herdr_send_text", { pane_id: "w1:p2", text: "two" });
		assert.deepEqual(
			calls.map((call) => call.method),
			["pane.list", "pane.send_text", "pane.list", "pane.send_text"],
		);
	});

	it("serializes writes to one pane", async () => {
		const order: string[] = [];
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let first = true;
		const { deps } = fakeDeps({
			"pane.list": PANES,
			"pane.send_text": async () => {
				if (first) {
					first = false;
					order.push("first-start");
					await gate;
					order.push("first-end");
					return {};
				}
				order.push("second");
				return {};
			},
		});
		const a = run(deps, "herdr_send_text", { pane_id: "w1:p2", text: "one" });
		await new Promise((resolve) => setImmediate(resolve));
		const b = run(deps, "herdr_send_text", { pane_id: "w1:p2", text: "two" });
		await new Promise((resolve) => setImmediate(resolve));
		release?.();
		await Promise.all([a, b]);
		assert.deepEqual(order, ["first-start", "first-end", "second"]);
	});
});

describe("herdr control tools", () => {
	it("splits from its own pane without taking focus", async () => {
		const { deps, calls } = fakeDeps({ "pane.split": { pane: { pane_id: "w1:p3", tab_id: "w1:t1" } } });
		const text = await run(deps, "herdr_split", { direction: "down" });
		assert.match(text, /w1:p3/);
		assert.deepEqual(calls[0].params, { direction: "down", target_pane_id: "w1:p1", cwd: null, focus: false });
	});

	it("runs a command in a new pane and waits for the requested output", async () => {
		const { deps, calls } = fakeDeps({
			"pane.split": { pane: { pane_id: "w1:p3" } },
			"pane.send_input": {},
			"pane.wait_for_output": { read: { text: "tests passed" } },
		});
		const text = await run(deps, "herdr_run", { command: "npm test", wait_for: "passed", timeout_ms: 5000 });
		assert.match(text, /tests passed/);
		assert.deepEqual(
			calls.map((call) => call.method),
			["pane.split", "pane.send_input", "pane.wait_for_output"],
		);
		assert.deepEqual(calls[1].params, { pane_id: "w1:p3", text: "npm test", keys: ["enter"] });
		assert.deepEqual(calls[2].params.match, { type: "substring", value: "passed" });
	});

	it("returns without waiting when no match is requested", async () => {
		const { deps, calls } = fakeDeps({ "pane.split": { pane: { pane_id: "w1:p3" } }, "pane.send_input": {} });
		const text = await run(deps, "herdr_run", { command: "npm test" });
		assert.match(text, /started in w1:p3/);
		assert.equal(calls.some((call) => call.method === "pane.wait_for_output"), false);
	});

	it("bounds a caller wait to the allowed range", async () => {
		const { deps, calls } = fakeDeps({ "agent.wait": { agent: { pane_id: "w1:p2", agent_status: "idle" } } });
		await run(deps, "herdr_agent_wait", { target: "reviewer", until: ["idle"], timeout_ms: 99999999 });
		assert.equal(calls[0].params.timeout_ms, 600000);
	});

	it("starts an agent in a resolved pane", async () => {
		const { deps, calls } = fakeDeps({
			"pane.list": PANES,
			"agent.start": { agent: { pane_id: "w1:p2", name: "reviewer", agent: "claude", agent_status: "idle" } },
		});
		const text = await run(deps, "herdr_agent_start", { name: "reviewer", kind: "claude", pane_id: "w1:p2" });
		assert.match(text, /reviewer pane=w1:p2 kind=claude/);
		assert.deepEqual(calls[1].params, { name: "reviewer", kind: "claude", pane_id: "w1:p2", timeout_ms: 30000 });
	});

	it("prompts an agent and passes the wait options through", async () => {
		const { deps, calls } = fakeDeps({ "agent.prompt": { agent: { pane_id: "w1:p2", agent_status: "working" } } });
		await run(deps, "herdr_agent_prompt", { target: "reviewer", text: "check the diff", wait_until: ["idle", "blocked"] });
		assert.deepEqual(calls[0].params.wait, { until: ["idle", "blocked"], timeout_ms: 60000 });
	});

	it("prompts without waiting when no state is requested", async () => {
		const { deps, calls } = fakeDeps({ "agent.prompt": {} });
		await run(deps, "herdr_agent_prompt", { target: "reviewer", text: "check the diff" });
		assert.equal(calls[0].params.wait, null);
	});

	it("shows a notification without a sound by default", async () => {
		const { deps, calls } = fakeDeps({ "notification.show": {} });
		await run(deps, "herdr_notify", { title: "review ready" });
		assert.deepEqual(calls[0].params, { title: "review ready", body: null, sound: "none" });
	});
});
