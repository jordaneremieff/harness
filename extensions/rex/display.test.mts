import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it, type TestContext } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { defineTool, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { obj } from "@earendil-works/pi-schema";
import { type KeyId, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { resultChannels } from "./config.ts";
import type { RexResult } from "./core.ts";
import { toolDisplay } from "./display.ts";

const requirePi = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const nativeTui: typeof import("@earendil-works/pi-tui") = await import(requirePi.resolve("@earendil-works/pi-tui"));
const ui = { requestRender() {} } as unknown as TUI;
const block = "block:33333333-3333-4333-8333-333333333333";
const server = { endpoint: "unix:///test-rex", hostId: "host", instanceId: "instance", selection: "test" };
const target = { server, source: "explicit" as const, blockId: block };
const effectRecord = "full-effect-record-identity";

function keyFixture(t: TestContext, keys: KeyId | KeyId[] = "ctrl+g"): void {
	initTheme("dark", false);
	const previous = nativeTui.getKeybindings();
	nativeTui.setKeybindings(
		new nativeTui.KeybindingsManager({
			...nativeTui.TUI_KEYBINDINGS,
			"app.tools.expand": { defaultKeys: keys, description: "Expand tool output" },
		}),
	);
	t.after(() => nativeTui.setKeybindings(previous));
}
function card(name: string, args: unknown): ToolExecutionComponent {
	const display = toolDisplay().tools.find((entry) => entry.name === name);
	assert.ok(display);
	const definition = defineTool({
		...display,
		label: "Display fixture",
		description: "Display fixture",
		parameters: obj({}, { open: true }),
		async execute() {
			throw new Error("A display fixture must not execute");
		},
	});
	const component = new ToolExecutionComponent(name, "fixture", args, { outputPad: 1 }, definition, ui, ".");
	component.setArgsComplete();
	return component;
}
function rows(component: ToolExecutionComponent, width = 120): string[] {
	return component.render(width).map((row) => {
		assert.ok(visibleWidth(row) <= width);
		return stripVTControlCharacters(row).trimEnd();
	});
}
function screen(component: ToolExecutionComponent, width = 120): string {
	return rows(component, width).join("\n");
}
function receipt(outcome: string, fields: Partial<RexResult> = {}) {
	return resultChannels({ ok: true, outcome, effects: { state: "none" }, coverage: { bounded: true }, ...fields });
}

it("formats requested allowances without confusing them with elapsed time", (t) => {
	keyFixture(t);
	const cases = [
		[
			"rex_owned",
			{ op: "cleanup", recordId: effectRecord, timeoutMs: 15_000 },
			"15s",
			receipt("cleanup_unknown", { ok: false }),
		],
		["rex_wait", { op: "wait", condition: "child_exit", timeoutMs: 4_219 }, "4.2s", receipt("child_completed")],
		[
			"rex_wait",
			{ op: "wait", condition: "text", text: "PRIVATE-PREDICATE", timeoutMs: 90_007 },
			"1m 30s",
			receipt("not_observed", { ok: false }),
		],
	] as const;
	for (const [name, args, allowance, result] of cases) {
		const component = card(name, args);
		const verifyFacts = () => {
			const text = screen(component);
			assert.ok(text.includes(`requested allowance ${allowance}`));
			assert.doesNotMatch(text, /\bms\b|timeoutMs|Elapsed|Took|PRIVATE-PREDICATE/);
			assert.equal(text.match(/to expand/g)?.length, 1);
		};
		verifyFacts();
		const before = JSON.stringify(result);
		component.updateResult({ ...result, durationMs: 321 });
		verifyFacts();
		component.setExpanded(true);
		const expanded = screen(component);
		assert.ok(expanded.includes(`timeoutMs: ${args.timeoutMs}`));
		assert.doesNotMatch(expanded, /PRIVATE-PREDICATE|to expand/);
		assert.equal(JSON.stringify(result), before);
	}
});

it("moves one disclosure hint from the Lua call to the partial and final result", (t) => {
	keyFixture(t);
	const component = card("rex_native", { op: "native", kind: "lua", code: `return "${"界".repeat(150)}END-LUA"` });
	const before = screen(component, 40);
	assert.match(before, /rex_native lua/);
	assert.match(before, /\(\d+ more lines, ctrl\+g to expand\)/);
	assert.doesNotMatch(before, /END-LUA|acknowledged/);
	assert.equal(rows(component, 40).filter((row) => /界/.test(row)).length, 5);
	component.markExecutionStarted();
	component.updateResult({ content: [], details: undefined, isError: false }, true);
	assert.match(screen(component, 40), /Waiting for the Rex CLI…\n +\.\.\. \(\d+ more lines, ctrl\+g to expand\)/);
	assert.doesNotMatch(screen(component), /to expand/);
	const result = receipt("acknowledged", {
		data: { value: { ok: false, message: "Inner action refused" }, meaning: "Raw model guidance" },
	});
	const beforeResult = JSON.stringify(result);
	component.updateResult(result);
	const settled = screen(component);
	assert.match(settled, /CLI acknowledged.*application success is not established/);
	assert.match(settled, /Inner action refused/);
	assert.doesNotMatch(settled, /Raw model guidance/);
	assert.equal(settled.match(/to expand/g)?.length, 1);
	assert.match(settled, /Inner action refused[\s\S]*\.\.\. \(ctrl\+g to expand\)\s*$/);
	component.setExpanded(true);
	assert.match(screen(component), /END-LUA/);
	assert.match(screen(component), /Raw model guidance/);
	assert.doesNotMatch(screen(component), /to expand|to collapse/);
	assert.equal(JSON.stringify(result), beforeResult);
});

it("shows exact requested and returned IDs until the available width clips them", (t) => {
	keyFixture(t);
	const recordId = `record-${"id".repeat(66)}-last`;
	const component = card("rex_owned", { op: "observe", recordId, target: { block, server: server.endpoint } });
	const narrow = rows(component, 32);
	assert.match(narrow[2], /^ rex_owned record-id.*…$/);
	assert.equal(rows(component, 230)[2], ` rex_owned ${recordId}`);
	assert.match(screen(component, 230), new RegExp(block));
	assert.doesNotMatch(screen(component, 230), /one record|to expand/);
	component.updateResult(
		receipt("observed", {
			target,
			effects: { state: "none", recordId: effectRecord },
			data: {
				reports: [
					{
						recordId,
						phase: "confirmed",
						complete: true,
						observations: [
							{
								resource: { blockId: block },
								presence: "present",
								childState: "exited",
								process: { last_exit: { exit_code: 7 } },
							},
						],
					},
				],
			},
		}),
	);
	const wide = screen(component, 230);
	assert.match(wide, new RegExp(`Record ${recordId} · stored confirmed`));
	assert.match(wide, new RegExp(`${block} · present · child exited · exit 7`));
	assert.match(wide, new RegExp(`effect record ${effectRecord}`));
	assert.match(screen(component, 32), /target block:33333333-.*…/);
	component.setExpanded(true);
	assert.ok(screen(component, 32).replaceAll(/\n +/gu, "").includes(recordId));
});

it("does not disclose literal input, key values, echoed payloads or optional capture content", (t) => {
	keyFixture(t);
	const component = card("rex_terminal", {
		op: "input",
		target: { block },
		text: "SECRET-CONTENT",
		keys: ["ctrl+x"],
		observe: true,
	});
	component.updateResult(
		receipt("input_delivered", {
			target,
			effects: { state: "confirmed", recordId: effectRecord },
			data: {
				delivery: { delivered: ["SECRET-CONTENT", { key: "ctrl+x" }] },
				observation: { ok: true, data: { content: "SECRET-CONTENT" } },
			},
		}),
	);
	assert.match(screen(component), /Input delivered; application execution is not established/);
	assert.match(screen(component), /separate snapshot was returned/);
	component.setExpanded(true);
	assert.match(screen(component), /text: 14 characters/);
	assert.match(screen(component), /keys: 1 key/);
	assert.doesNotMatch(screen(component), /SECRET-CONTENT|ctrl\+x/);
	component.updateResult(
		receipt("cli_failure", {
			ok: false,
			error: "Connection ended: SECRET-CONTENT",
			effects: { state: "unknown", recordId: effectRecord },
		}),
	);
	assert.match(screen(component), /Native effects are not established/);
	assert.doesNotMatch(screen(component), /SECRET-CONTENT/);
});

it("fails closed on echoed private data in bare and structured failures with malformed requests", (t) => {
	keyFixture(t);
	const secret = "DONOTDISCLOSE\\a\nλ";
	const prepared = [
		["rex_terminal", secret],
		["rex_native", [secret]],
		["rex_terminal", { text: secret, keys: [secret] }],
		["rex_terminal", { kind: "split", text: secret }],
		["rex_native", { args: { nested: [secret] } }],
		["rex_native", { kind: "lua", code: secret }],
		["rex_native", { op: "native", kind: "lua", code: secret, target: { extra: secret } }],
		["rex_native", { op: "native", kind: "api", method: "pane.list", args: { nested: [secret] } }],
	] as const;
	for (const [name, args] of prepared) {
		const component = card(name, args);
		assert.doesNotMatch(screen(component), /DONOTDISCLOSE/);
		for (const result of [
			{ content: [{ type: "text", text: `Argument error: ${JSON.stringify(args)}` }], isError: true },
			receipt("invalid_request", {
				ok: false,
				error: secret,
				effects: { state: "unknown", recordId: effectRecord, note: secret },
				data: { captureError: secret, content: secret, value: secret },
				coverage: { bounded: true, note: secret },
			}),
		]) {
			const before = JSON.stringify(result);
			component.updateResult(result);
			for (const expanded of [false, true]) {
				component.setExpanded(expanded);
				const display = screen(component);
				assert.match(display, /The diagnostic is withheld/);
				if ("details" in result) assert.match(display, /Native effects are not established/);
				assert.doesNotMatch(display, /DONOTDISCLOSE/);
			}
			assert.equal(JSON.stringify(result), before);
		}
	}
});

it("separates a child exit, a missed condition, a refusal and a thrown cancellation", (t) => {
	keyFixture(t);
	const child = card("rex_wait", { op: "wait", condition: "child_exit", target: { block } });
	const tail = `before retained preview\n${"x".repeat(370)}TAIL`;
	child.updateResult(
		receipt("child_failed", {
			ok: false,
			target,
			data: { process: { last_exit: { exit_code: 7 } }, capture: { content: tail, start: 18, end: 413, total: 413 } },
		}),
	);
	assert.match(screen(child, 72), /The direct child exited with code 7/);
	assert.match(screen(child, 72), /TAIL\n +\[Terminal capture retained bytes/);
	assert.doesNotMatch(screen(child, 72), /before retained preview/);
	child.setExpanded(true);
	assert.match(screen(child, 72), /before retained preview/);
	const wait = card("rex_wait", { op: "wait", condition: "text", text: "never-shown" });
	const missed = receipt("not_observed", {
		ok: false,
		data: { ending: "snapshot_limit", snapshot: { content: "still working\nnever-shown" } },
	});
	assert.equal(missed.isError, false);
	wait.updateResult(missed);
	assert.match(screen(wait), /snapshot limit ended the wait without an observed condition/);
	assert.match(screen(wait), /does not stop terminal work/);
	assert.doesNotMatch(screen(wait), /child exited|never-shown/);
	wait.setExpanded(true);
	assert.doesNotMatch(screen(wait), /never-shown/);
	wait.setExpanded(false);
	wait.updateResult(receipt("condition_observed", { data: { condition: "text" } }));
	assert.match(screen(wait), /The requested condition was observed/);
	child.updateResult(
		receipt("child_completed", {
			data: { process: { last_exit: { exit_code: 0 } }, captureError: "Tail read timed out: deadline" },
		}),
	);
	assert.match(screen(child), /The direct child exited with code 0/);
	assert.match(screen(child), /Tail read timed out: deadline/);
	assert.doesNotMatch(screen(child), /Capture:/);
	const inspect = card("rex_terminal", { op: "inspect", view: "process" });
	inspect.updateResult(receipt("invalid_or_unavailable", { ok: false, error: "Select an exact block." }));
	assert.match(screen(inspect), /Select an exact block\./);
	inspect.updateResult(receipt("cancelled", { ok: false, error: "Transport cancelled." }));
	assert.match(screen(inspect), /^ Cancelled$/m);
	inspect.updateResult({
		content: [{ type: "text", text: "Request cancelled by caller.\nPreserve this diagnostic." }],
		details: undefined,
		isError: true,
	});
	assert.match(screen(inspect), /Request cancelled by caller/);
	assert.doesNotMatch(screen(inspect), /^ Cancelled$/m);
});

it("marks bounded omissions and gives the exact continuation for an owned page, including zero", (t) => {
	keyFixture(t);
	const component = card("rex_owned", { op: "owned", phase: "confirmed", limit: 4 });
	component.updateResult(
		receipt("owned", {
			coverage: {
				bounded: true,
				truncated: true,
				totalRecords: 4,
				returnedRecords: 2,
				emittedRecordRefs: 0,
				omittedRecordRefs: 2,
				omittedRecordIds: [effectRecord],
				nextOffset: 0,
			},
		}),
	);
	assert.match(screen(component), /Selected 2 of 4 records; a continuation is available/);
	assert.doesNotMatch(screen(component), /0 record IDs retained/);
	assert.match(screen(component), /\[2 record IDs omitted by the Rex result byte limit\]/);
	assert.match(screen(component), /\(ctrl\+g to expand\)/);
	component.setExpanded(true);
	assert.match(screen(component), /Next call: rex_owned \{"op":"owned","phase":"confirmed","limit":1,"offset":0\}/);
	assert.match(screen(component), new RegExp(effectRecord));
	const catalog = card("rex_native", { op: "native", kind: "catalog", query: "pane", limit: 1 });
	catalog.updateResult(
		receipt("catalog", {
			data: { methods: ["pane.list"], matchedMethods: 5, returnedMethods: 1, nextOffset: 1 },
			coverage: { bounded: true, truncated: true },
		}),
	);
	assert.match(screen(catalog), /Returned 1 of 5 matching methods; a continuation is available/);
	assert.doesNotMatch(screen(catalog), /\[.*(limit|partial)/);
	catalog.setExpanded(true);
	assert.match(
		screen(catalog),
		/Next call: rex_native \{"op":"native","kind":"catalog","query":"pane","limit":1,"offset":1\}/,
	);
	catalog.setExpanded(false);
	catalog.updateResult(receipt("catalog", { data: { methods: [], matchedMethods: 0, returnedMethods: 0 } }));
	assert.match(screen(catalog), /No matching methods/);
	assert.doesNotMatch(screen(catalog), /0 of 0/);
});

it("reads status facts, omits absent values and sanitises operator text without cutting IDs early", (t) => {
	keyFixture(t);
	const component = card("rex_status", { op: "snapshot" });
	component.updateResult(
		receipt("host_status", {
			data: {
				hostActivity: { host: "ordinary", omittedTasks: 4 },
				reportedStatus: { blocks: [{ status: { state: "working" } }] },
				binding: { target, ownerId: "owner", verifiedAt: "2026-11-04T00:00:00.000Z" },
			},
		}),
	);
	const status = screen(component);
	assert.match(status, /Host ordinary/);
	assert.match(status, /program reported working/);
	assert.match(status, /bound to block:33333333/);
	assert.match(status, /4 tasks outside the host snapshot/);
	assert.doesNotMatch(status, /unknown|Binding:|Reported program state:|verifiedAt/);
	const create = card("rex_terminal", {
		kind: "split",
		label: "build\n\u001b[31mred\u202e\ud800path",
		direction: "right",
	});
	assert.match(screen(create), /^ rex_terminal build red path$/m);
	assert.match(screen(create), /^ create · split$/m);
	assert.doesNotMatch(screen(create), /\u001b|\u202e|\ud800/);
});

it("does not claim a clickable call before the result or an expandable one-line answer", (t) => {
	keyFixture(t, []);
	const component = card("rex_environment", { op: "resolve", kind: "block", query: "long-".repeat(40) });
	assert.doesNotMatch(screen(component), /click to expand|to expand/);
	component.updateResult(receipt("resolved", { target }));
	assert.match(screen(component), /\(click to expand\)/);
	const simple = card("rex_status", { op: "unbind" });
	simple.updateResult(receipt("status_unbound"));
	assert.match(screen(simple), /Removed the Rex binding/);
	assert.doesNotMatch(screen(simple), /to expand/);
});
