import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { resultChannels } from "./config.ts";
import type { RexResult } from "./core.ts";
import { createRexToolDisplay } from "./presentation.ts";

const block = "block:33333333-3333-4333-8333-333333333333";
const server = { endpoint: "unix:///test-rex", hostId: "host", instanceId: "instance", selection: "test" };
const theme = { fg: (_colour: ThemeColor, text: string) => text };
/** The host injects keyText with the configured bindings; tests set the configured expansion key here. */
let expandKey = "ctrl+o";
const keyText = () => expandKey;
beforeEach(() => { expandKey = "ctrl+o"; });
function fixture(changes: Partial<RexResult> = {}): RexResult {
	return { ok: true, outcome: "input_delivered", target: { server, source: "explicit", blockId: block }, effects: { state: "confirmed", recordId: "complete-operation-identity" }, coverage: { bounded: true }, ...changes };
}
function render(name: string, value: RexResult, args: unknown, expanded = false, width = 120): string[] {
	return createRexToolDisplay(name).renderResult(resultChannels(value), { expanded, isPartial: false }, theme, { args, isError: !value.ok, keyText }).render(width);
}

test("cards retain meaningful uncertainty, delivery and observer qualifications at narrow and normal widths", () => {
	for (const width of [24, 72, 120]) {
		const unknown = render("rex_terminal", fixture({ ok: false, outcome: "cli_failure", effects: { state: "unknown", recordId: "complete-operation-identity" }, error: "Connection ended after input." }), { op: "input" }, false, width);
		assert.match(unknown.join(" "), /UNKNOWN\s+EFFECTS/);
		assert.match(unknown.join(" "), /Input delivery is not application\s+execution/);
		assert.ok(!unknown.join("").includes("complete-operation-identity"), "the effect record waits in Details");
		assert.ok(render("rex_terminal", fixture({ ok: false, outcome: "cli_failure", effects: { state: "unknown", recordId: "complete-operation-identity" } }), { op: "input" }, true, width).join("").includes("complete-operation-identity"));
		const delivered = render("rex_terminal", fixture(), { op: "input" }, false, width);
		assert.match(delivered.join(" "), /block\s+\u00b7\s+input\s+delivered/, "the lead names the plain subject and the outcome");
		assert.match(delivered.join(" "), /not application\s+execution/);
		const deadline = render("rex_wait", fixture({ ok: false, outcome: "timeout", effects: { state: "none" } }), { op: "wait", condition: "child_exit" }, false, width);
		assert.match(deadline.join(" "), /Observer deadline/);
		assert.match(deadline.join(" "), /terminal work remains\s+independent/);
		for (const row of [...unknown, ...delivered, ...deadline]) assert.ok(visibleWidth(row) <= width, JSON.stringify(row));
	}
	const collapsed = render("rex_terminal", fixture(), { op: "input" }).join("\n");
	assert.ok(!collapsed.includes(block) && !collapsed.includes(server.endpoint), "collapsed cards keep exact identities and endpoints out of the lead");
	assert.doesNotMatch(collapsed, /effects confirmed|no effects/, "a routine effect state is not a collapsed fact");
	const expanded = render("rex_terminal", fixture(), { op: "input" }, true).join("\n");
	assert.ok(expanded.includes(block) && expanded.includes(server.endpoint), "full identifiers fit without shortening");
	assert.match(expanded, /Details\n.*target block:.*explicit target.*unix:/s);
	assert.match(expanded, /record complete-operation-identity/);
	assert.match(expanded, /effects confirmed/);
});

test("cards expose omissions and complete bounded JSON without changing canonical channels", () => {
	const value = fixture({ data: { content: `visible capture\n${"x".repeat(2048)}END-OF-BOUNDED-CAPTURE` }, effects: { state: "none" }, coverage: { bounded: true, truncated: true, dataOmitted: true, truncatedFields: ["error"], totalRecords: 4, returnedRecords: 4, omittedRecords: 0, omittedRecordRefs: 2, nextOffset: 0 } });
	const channels = resultChannels(value);
	const before = JSON.stringify(channels);
	const display = createRexToolDisplay("rex_terminal");
	const context = { args: { op: "inspect", view: "capture" }, isError: false, keyText };
	const collapsed = display.renderResult(channels, { expanded: false, isPartial: false }, theme, context).render(72).join("\n");
	assert.match(collapsed, /Bounded capture, not a complete transcript/);
	assert.match(collapsed, /bulk data omitted/);
	assert.match(collapsed, /diagnostics shortened/);
	assert.match(collapsed, /2 record references omitted/);
	assert.match(collapsed, /next offset 0/);
	assert.match(collapsed, /to expand/);
	assert.ok(!collapsed.includes("END-OF-BOUNDED-CAPTURE"));
	const expanded = display.renderResult(channels, { expanded: true, isPartial: false }, theme, context).render(72).join("");
	assert.match(expanded, /END-OF-BOUNDED-CAPTURE/);
	assert.match(expanded, /"bounded": true/);
	assert.match(expanded, /to collapse/);
	assert.equal(JSON.stringify(channels), before);
	assert.deepEqual(channels.details, { outcome: value.outcome, effects: "none" });
});

test("call and result text escape terminal controls and preserve safe row colours", () => {
	const hostile = "label\u001b]52;c;clipboard\u0007\r\u009b2J\u202e\ud800";
	const args = { op: "create", kind: "session", label: hostile, text: hostile, target: { server: server.endpoint, block }, command: ["application", hostile] };
	const display = createRexToolDisplay("rex_terminal");
	const value = fixture({ ok: false, outcome: "cli_failure", error: hostile, data: { content: hostile }, effects: { state: "unknown", note: hostile }, coverage: { bounded: true, note: hostile } });
	for (const expanded of [false, true]) {
		const call = display.renderCall(args, theme, { expanded, isPartial: true });
		const result = display.renderResult(resultChannels(value), { expanded, isPartial: false }, theme, { args, isError: true });
		for (const width of [24, 72, 120]) {
			const rows = [...call.render(width), ...result.render(width)];
			for (const row of rows) {
				assert.ok(visibleWidth(row) <= width);
				assert.equal(/[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]|\p{Cs}/u.test(row), false, JSON.stringify(row));
			}
		}
		assert.match(result.render(120).join("\n"), /\\u001b/);
	}
	const preview = display.renderCall({ op: "input", text: "界🙂".repeat(100) }, theme, { expanded: false, isPartial: false });
	assert.ok(preview.render(24).some((row) => row.endsWith("…")));
	assert.equal(preview.render(24).some((row) => row.includes("\u001b[0m")), false, "plain clipping must not cancel the host's row background");
	assert.deepEqual(preview.render(0), []);
});

test("result summaries preserve native, stored-phase and status meaning without absent-fact placeholders", () => {
	const native = render("rex_native", fixture({ outcome: "acknowledged" }), { op: "native", kind: "lua" }).join("\n");
	assert.match(native, /CLI success is not inner application success/);
	const owned = render("rex_owned", fixture({ target: undefined, outcome: "owned", effects: { state: "none" }, coverage: { bounded: true, totalRecords: 0, returnedRecords: 0 } }), { op: "owned" }).join("\n");
	assert.match(owned, /Stored phase is not live presence or cleanup permission/);
	assert.match(owned, /0 of 0 records/);
	assert.doesNotMatch(owned, /unknown|unavailable/i);
	const status = render("rex_status", fixture({ outcome: "host_status" }), { op: "snapshot" }).join("\n");
	assert.match(status, /Reported status is not permission or task acceptance/);
	const partial = createRexToolDisplay("rex_wait").renderResult({ content: [{ type: "text", text: "pending\u001b[2J" }], details: undefined }, { expanded: false, isPartial: true }, theme, { args: {}, isError: false }).render(72).join("\n");
	assert.match(partial, /partial result/);
	assert.doesNotMatch(partial, /no effects|UNKNOWN EFFECTS|\u001b/);
});

test("owned observation cards separate stored phase, current child evidence and partial errors", () => {
	const value = fixture({ outcome: "observation_incomplete", ok: false, effects: { state: "none" }, data: { reports: [
		{ recordId: "retained-call", phase: "confirmed", observations: [{ presence: "present", childState: "exited", process: { last_exit: { exit_code: 7 } }, capture: { content: "early output\nFINAL-MARKER" }, statusError: "Status unavailable." }] },
		{ recordId: "pending-call", phase: "pending", observations: [], error: "No acknowledged resource IDs." },
	] } });
	const rows = render("rex_owned", value, { op: "observe" }).join("\n");
	assert.match(rows, /retained-call · stored confirmed · present · child exited · exit 7/);
	assert.match(rows, /pending-call · stored pending · unresolved/);
	assert.match(rows, /FINAL-MARKER/);
	assert.match(rows, /Status unavailable/);
	assert.match(rows, /Observation does not stop work or establish task success/);
	assert.match(rows, /Stored phase is not live presence/);
});

test("collapsed cards lead with observed facts: status host activity, reported states, binding, subject label, and wait deadline", () => {
	const binding = { ownerId: "owner", verifiedAt: "2026-11-04T00:00:00.000Z", target: { server, source: "explicit" as const, sessionId: "session:33333333-3333-4333-8333-333333333333", blockId: block } };
	const status = render("rex_status", fixture({
		outcome: "snapshot",
		data: {
			hostActivity: { host: "durable", state: "idle", observedAt: "2026-11-04T00:00:00.000Z", source: "Harness.inspect() current conversation tasks", omittedTasks: 70, note: "No live task does not prove completion." },
			reportedStatus: { blocks: [{ block_id: block, status: { state: "working", app: "pi" } }] },
			binding,
			terminalProjection: "projection limit",
		},
	}), { op: "snapshot" }).join("\n");
	assert.match(status, /Host durable · idle/);
	assert.match(status, /tasks outside snapshot/);
	assert.match(status, /Reported: working/);
	assert.ok(status.includes(`Binding: ${block} · verified 2026-11-04`));
	assert.match(status, /Reported status is not permission or task acceptance/);
	const unbound = render("rex_status", fixture({ outcome: "host_status", data: { hostActivity: { host: "ordinary", state: "active", observedAt: "2026-11-04T00:00:00.000Z", source: "ExtensionContext.isIdle()", note: "" } } }), { op: "snapshot" }).join("\n");
	assert.match(unbound, /Host ordinary · active/);
	assert.match(unbound, /Binding: none/);
	const wait = render("rex_wait", fixture({ outcome: "observed" }), { op: "wait", condition: "text", timeoutMs: 25000 }).join("\n");
	assert.match(wait, /deadline 25000 ms/);
	const created = render("rex_terminal", fixture({ outcome: "created", data: { label: "build pane" } }), { op: "create", kind: "session", label: "build pane" }).join("\n");
	assert.match(created, /^build pane \u00b7 created/m, "the label leads, then the outcome");
	assert.match(render("rex_terminal", fixture({ outcome: "created" }), { op: "create", kind: "window" }).join("\n"), /^new window \u00b7 created/m, "without a label the plain resource kind leads");
	assert.match(render("rex_wait", fixture({ ok: false, outcome: "timeout", effects: { state: "none" } }), { op: "wait", condition: "child_exit" }).join("\n"), /^wait for child exit \u00b7 timeout/m);
	assert.doesNotMatch(render("rex_terminal", fixture(), { op: "input" }).join("\n"), /explicit target/);
	assert.match(render("rex_terminal", fixture(), { op: "input" }, true).join("\n"), /explicit target/);
	for (const width of [24, 72]) {
		const rows = createRexToolDisplay("rex_status").renderResult(resultChannels(fixture({ outcome: "snapshot", data: { hostActivity: { host: "durable", state: "idle", observedAt: "x", source: "y", note: "z" }, reportedStatus: { blocks: [{ status: { state: "working" } }] }, binding, terminalProjection: "" } })), { expanded: false, isPartial: false }, theme, { args: { op: "snapshot" }, isError: false }).render(width);
		for (const row of rows) assert.ok(visibleWidth(row) <= width, JSON.stringify(row));
	}
});

test("cards use the host-injected expansion key and invent no mouse fallback when it is unbound or absent", () => {
	expandKey = "ctrl+g";
	assert.match(render("rex_terminal", fixture(), { op: "input" }).join("\n"), /ctrl\+g to expand/);
	expandKey = "";
	const unbound = render("rex_terminal", fixture(), { op: "input" }).join("\n");
	assert.doesNotMatch(unbound, /click|to expand/);
	assert.match(unbound, /input delivered/);
	const withoutHints = createRexToolDisplay("rex_terminal").renderResult(resultChannels(fixture()), { expanded: false, isPartial: false }, theme, { args: { op: "input" }, isError: false }).render(120).join("\n");
	assert.doesNotMatch(withoutHints, /to expand/);
});
