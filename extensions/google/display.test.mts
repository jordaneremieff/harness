import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import {
	createEventBus,
	initTheme,
	Theme,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	getKeybindings,
	KeybindingsManager,
	type KeyId,
	setKeybindings,
	stripTerminalSequences,
	TUI_KEYBINDINGS,
	type TUI,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { displayDate, displayInstant } from "./display-dates.ts";
import { toolDisplay } from "./display.ts";
import registerGoogle from "./index.ts";
import { failure, GoogleError, ok, partial, toolResult, type Result } from "./result.ts";

initTheme("dark", false);

function expansionKey(t: TestContext, keys: KeyId[]): void {
	const previous = getKeybindings();
	setKeybindings(
		new KeybindingsManager(
			{ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tool output" } },
			{ "app.tools.expand": keys },
		),
	);
	t.after(() => setKeybindings(previous));
}

function card(name = "google_status", args: Record<string, unknown> = {}): ToolExecutionComponent {
	const record = toolDisplay().tools.find((record) => record.name === name);
	assert.ok(record);
	return new ToolExecutionComponent(
		record.name,
		"google-test-call",
		args,
		{ outputPad: 1 },
		record,
		{ requestRender() {} } as TUI,
		"/synthetic",
	);
}

function rows(component: ToolExecutionComponent, width = 100): string[] {
	const rendered = component.render(width);
	assert.ok(
		rendered.every((line) => visibleWidth(line) <= width),
		"every row fits the Pi shell",
	);
	return rendered.map((line) => stripTerminalSequences(line).trimEnd().slice(1));
}

function settle(component: ToolExecutionComponent, result: Result<unknown>): void {
	const returned = toolResult(result);
	component.updateResult({ ...returned, isError: returned.isError === true });
}

test("Pi renders an argument-free call, progress, and a ready status with one disclosure hint", (t) => {
	expansionKey(t, ["ctrl+g"]);
	const colours = t.mock.method(Theme.prototype, "fg");
	const component = card();
	assert.deepEqual(rows(component), ["", "", "google_status Google Workspace access", ""]);
	assert.ok(
		colours.mock.calls.some(({ arguments: [role, value] }) => role === "accent" && value === "Google Workspace access"),
	);
	assert.ok(
		colours.mock.calls.some(({ arguments: [role, value] }) => role === "toolTitle" && value.includes("google_status")),
	);
	component.markExecutionStarted();
	assert.doesNotMatch(rows(component).join("\n"), /expand|ready|pending/);
	component.updateResult({ content: [], isError: false }, true);
	assert.match(rows(component).join("\n"), /Checking Google Workspace access\./);
	assert.doesNotMatch(rows(component).join("\n"), /expand/);

	settle(
		component,
		ok({
			ready: true,
			observedAccount: "reader@example.invalid",
			expectedAccount: "reader@example.invalid",
			backend: { name: "gws", requiredVersion: "1.2.3" },
			grantedScopes: ["scope-read"],
			capabilities: { gmailRead: true, gmailSend: false },
		}),
	);
	const collapsed = rows(component).join("\n");
	assert.match(collapsed, /google_status Google Workspace access\n\nAccess is ready\./);
	assert.match(collapsed, /Signed in as reader@example\.invalid\nRequires gws 1\.2\.3/);
	assert.deepEqual(
		collapsed.split("\n").filter((line) => line.includes("to expand")),
		["... (ctrl+g to expand)"],
	);
	assert.doesNotMatch(collapsed, /scope-read|Expected account|schemaVersion|unknown|none/);
	component.setExpanded(true);
	const expanded = rows(component).join("\n");
	assert.match(expanded, /scope-read/);
	assert.match(expanded, /gmailSend: not available/);
	assert.doesNotMatch(expanded, /to expand|to collapse/);
});

test("a successful observation of not-ready is distinct from an error that prevents the check", (t) => {
	expansionKey(t, []);
	const colours = t.mock.method(Theme.prototype, "fg");
	const component = card();
	settle(
		component,
		ok({
			ready: false,
			expectedAccount: null,
			error: { code: "SETUP_REQUIRED", message: "Set up access first.", retryable: false },
		}),
	);
	const notReady = rows(component).join("\n");
	assert.match(notReady, /Access is not ready\.\nSet up access first\./);
	assert.doesNotMatch(notReady, /Expected account|SETUP_REQUIRED/);
	assert.match(notReady, /\.\.\. \(click to expand\)/);
	assert.equal(rows(component, 22).filter(Boolean)[1], "Access is not ready.");
	assert.ok(
		colours.mock.calls.some(
			({ arguments: [role, value] }) => role === "toolOutput" && value.trimEnd() === "Set up access first.",
		),
	);
	assert.ok(!colours.mock.calls.some(({ arguments: [role] }) => role === "error"));

	settle(component, failure(new GoogleError("ADAPTER_ERROR", "Status snapshot could not be read.")));
	const error = rows(component).join("\n");
	assert.match(error, /Status snapshot could not be read\./);
	assert.doesNotMatch(error, /is not ready|is ready/);
	assert.ok(
		colours.mock.calls.some(
			({ arguments: [role, value] }) => role === "error" && value === "Status snapshot could not be read.",
		),
	);
	settle(component, failure(new GoogleError("ABORTED", "The operation was cancelled.")));
	assert.equal(rows(component).filter(Boolean)[1], "Cancelled");
	settle(
		component,
		ok({
			ready: false,
			error: { code: "ABORTED", message: "The operation was cancelled.", retryable: true },
		}),
	);
	assert.equal(rows(component).filter(Boolean)[1], "Cancelled");
});

test("a long diagnostic uses five visual body lines and counts only the hidden body lines", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card();
	const width = 42;
	const token = "x".repeat(width - 2);
	settle(
		component,
		ok({
			ready: false,
			error: { code: "SETUP_REQUIRED", message: `\u001b[31m${token.repeat(7)}END\u001b[0m`, retryable: false },
		}),
	);
	const collapsed = rows(component, width).filter(Boolean);
	assert.equal(collapsed[1], "Access is not ready.");
	assert.deepEqual(collapsed.slice(2, 7), Array(5).fill(token));
	assert.equal(collapsed[7], "... (3 more lines, ctrl+o to expand)");
	assert.equal(collapsed.length, 8);
	assert.doesNotMatch(collapsed.join("\n"), /END/);
	component.setExpanded(true);
	const expanded = rows(component, width).join("\n");
	assert.match(expanded, /END/);
	assert.doesNotMatch(expanded, /to expand/);
	component.setExpanded(false);
	assert.ok(rows(component, 22).some((line) => line.endsWith("…")));
});

test("a bare Pi diagnostic stays intact without a hint that adds nothing", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card();
	component.updateResult({ content: [{ type: "text", text: "Could not start status check." }], isError: true });
	assert.deepEqual(rows(component).filter(Boolean), [
		"google_status Google Workspace access",
		"Could not start status check.",
	]);
	const narrow = rows(component, 24).filter(Boolean);
	assert.ok(narrow[1].endsWith("…"));
	component.setExpanded(true);
	assert.match(rows(component, 24).join("\n"), /Could not start status\ncheck\./);
});

test("Calendar names the share grantee before and after the receipt", () => {
	const component = card("calendar_share", {
		calendarId: "primary",
		role: "reader",
		scopeType: "user",
		scopeValue: "reader@example.invalid",
		sendNotifications: false,
	});
	const call = /calendar_share reader@example\.invalid\nreader · user · primary/;
	assert.match(rows(component, 60).join("\n"), call);
	component.setExpanded(true);
	assert.match(rows(component, 60).join("\n"), call);
	settle(component, ok({ ruleId: "user:reader@example.invalid", calendarId: "primary", notificationsSent: false }));
	const expanded = rows(component).join("\n");
	assert.match(expanded, call);
	assert.match(expanded, /Calendar access rule created\./);
});

test("Calendar default scope and revoke use the supplied scope or rule as the subject", () => {
	const defaultShare = card("calendar_share", { role: "freeBusyReader", scopeType: "default" });
	assert.match(
		rows(defaultShare).join("\n"),
		/calendar_share Default access\nfreeBusyReader · default scope · primary calendar/,
	);
	const revoke = card("calendar_unshare", { calendarId: "team-calendar", ruleId: "group:team@example.invalid" });
	assert.match(rows(revoke).join("\n"), /calendar_unshare group:team@example\.invalid\nteam-calendar/);
});

test("Drive names the share grantee and keeps the notification message private", () => {
	const component = card("drive_share", {
		fileId: "file-1",
		type: "user",
		role: "reader",
		emailAddress: "reader@example.invalid",
		emailMessage: "PRIVATE_NOTIFICATION_MESSAGE",
	});
	const call = /drive_share reader@example\.invalid\nreader · user · file file-1/;
	assert.match(rows(component).join("\n"), call);
	settle(component, ok({ permissionId: "p-1", fileId: "file-1", notificationSent: false }));
	component.setExpanded(true);
	const expanded = rows(component).join("\n");
	assert.match(expanded, call);
	assert.match(expanded, /emailMessage: \d+ characters/);
	assert.doesNotMatch(expanded, /PRIVATE_NOTIFICATION_MESSAGE/);
});

test("Google display dates distinguish local clock time and unshifted calendar days", () => {
	const now = new Date(2026, 10, 23, 11);
	const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
	assert.equal(displayInstant(at(23, 14, 32), now), "2:32 PM");
	assert.equal(displayInstant(at(23, 12), now), "12:00 PM");
	assert.equal(displayInstant(at(23, 0), now), "12:00 AM");
	assert.equal(displayInstant(at(22, 0), now), "22 Nov 12:00 AM");
	assert.equal(displayInstant(new Date(2025, 10, 23, 14, 32).toISOString(), now), "23 Nov 2:32 PM");
	assert.equal(displayDate("2026-11-23"), "23 Nov");
	assert.equal(displayDate("2026-11-23T00:00:00.000Z"), "23 Nov");
	assert.equal(displayInstant("2026-11-23T14:32:00", now), "2026-11-23T14:32:00");
});

test("Calendar event cards show local instants and preserve unshifted all-day dates", () => {
	const eventId = "evt";
	const start = new Date(2020, 10, 23, 14, 32).toISOString();
	const end = new Date(2020, 10, 23, 15).toISOString();
	const event = card("calendar_event_get", { eventId });
	settle(event, ok({ eventId, start: { dateTime: start }, end: { dateTime: end } }));
	assert.match(rows(event).join("\n"), /Starts 23 Nov 2:32 PM\nEnds 23 Nov 3:00 PM/);
	settle(event, ok({ eventId, start: { date: "2020-11-23" }, end: { date: "2020-11-24" } }));
	assert.match(rows(event).join("\n"), /Starts 23 Nov\nEnds 24 Nov/);
	settle(
		event,
		ok({
			eventId,
			start: { dateTime: "2026-11-01T01:30:00", timeZone: "America/New_York" },
			end: { dateTime: "2026-11-01T12:00:00" },
		}),
	);
	assert.match(
		rows(event).join("\n"),
		/Starts 1 Nov 1:30 AM \(America\/New_York\)\nEnds 1 Nov 12:00 PM \(zone not supplied\)/,
	);
});

test("Tasks cards show a due calendar date without shifting its midnight UTC value", () => {
	const due = "2026-11-23T00:00:00.000Z";
	const dueMin = new Date(2020, 10, 23, 0).toISOString();
	const component = card("tasks_list", { taskListId: "team", dueMin });
	assert.match(rows(component).join("\n"), /due from 23 Nov 12:00 AM/);
	settle(component, ok({ tasks: [{ taskId: "task-1", due, externalData: { title: "Review agenda" } }] }));
	const collapsed = rows(component).join("\n");
	assert.match(collapsed, /Review agenda · due 23 Nov\n/);
	assert.doesNotMatch(collapsed, /22 Nov|T00:00:00/);
	component.setExpanded(true);
	assert.ok(rows(component).join("\n").includes(`dueMin: ${dueMin}`));
});

test("calendar page owns the only settled hint and preserves the exact next call", (t) => {
	expansionKey(t, ["ctrl+g"]);
	const timeMin = new Date(2020, 10, 23, 14, 32, 19).toISOString().replace("Z", "+00:00");
	const timeMax = new Date(2020, 10, 24, 9, 0, 45).toISOString();
	const args = {
		calendarId: "cal@example.invalid",
		timeMin,
		timeMax,
		limit: 1,
		orderBy: "updated",
		cursor: "old-token",
	};
	const component = card("calendar_events_list", args);
	assert.match(rows(component).join("\n"), /23 Nov 2:32 PM · 24 Nov 9:00 AM/);
	assert.match(rows(component).filter(Boolean).at(-1) ?? "", /ctrl\+g to expand/);
	settle(
		component,
		ok({
			events: [{ eventId: "evt", start: { dateTime: timeMin }, externalData: { summary: "Planning" } }],
			nextCursor: "x+/_=  %",
		}),
	);
	const collapsed = rows(component).filter(Boolean);
	assert.match(collapsed.join("\n"), /This page contains 1 event\. Another page is available\./);
	assert.deepEqual(
		collapsed.filter((line) => line.includes("to expand")),
		[collapsed.at(-1)],
	);
	assert.match(collapsed.join("\n"), /23 Nov 2:32 PM · Planning · evt/);
	assert.doesNotMatch(collapsed.join("\n"), /old-token|x\+\/|schemaVersion|T\d{2}:/);
	component.setExpanded(true);
	const expanded = rows(component, 220).join("\n");
	assert.ok(expanded.includes(`timeMin: ${timeMin}`));
	assert.ok(expanded.includes(`timeMax: ${timeMax}`));
	assert.ok(expanded.includes(`Continue with calendar_events_list ${JSON.stringify({ ...args, cursor: "x+/_=  %" })}`));
	assert.doesNotMatch(expanded, /to expand|to collapse/);
});

test("private mutation arguments and echoed diagnostics stay out of both views", (t) => {
	expansionKey(t, []);
	const component = card("calendar_event_update", {
		eventId: "evt",
		event: { summary: "PRIVATE_PAYLOAD", description: "OTHER_PRIVATE_TEXT" },
	});
	const before = rows(component).join("\n");
	assert.doesNotMatch(before, /click to expand|PRIVATE/);
	settle(component, failure(new GoogleError("API_ERROR", "Bad request: PRIVATE_PAYLOAD")));
	const after = rows(component).filter(Boolean);
	assert.ok(after.includes("The Google API rejected the request."));
	assert.ok(after.includes("[Upstream diagnostic withheld]"));
	assert.equal(after.at(-1), "... (click to expand)");
	component.setExpanded(true);
	const expanded = rows(component).join("\n");
	assert.match(expanded, /event: 2 fields/);
	assert.match(expanded, /Error code API_ERROR/);
	assert.doesNotMatch(expanded, /PRIVATE|to expand|to collapse/);
});

test("a bare Pi failure with private mutation arguments withholds the entire diagnostic", () => {
	const args = { eventId: "evt", event: { description: "PRIVATE_EVENT_TEXT" } };
	const component = card("calendar_event_update", args);
	const diagnostic = `Invalid value PRIVATE_FIRST_LINE\n\nReceived arguments:\n${JSON.stringify(args, null, 2)}`;
	component.updateResult({ content: [{ type: "text", text: diagnostic }], isError: true });
	for (const expanded of [false, true]) {
		component.setExpanded(expanded);
		const rendered = rows(component).join("\n");
		assert.match(rendered, /The tool call failed\.\n\[Unstructured diagnostic withheld\]/);
		assert.doesNotMatch(rendered, /PRIVATE_|Received arguments|Invalid value/);
	}
});

test("safe multiline read diagnostics retain error colour on every row", (t) => {
	const colours = t.mock.method(Theme.prototype, "fg");
	const component = card("calendar_events_list");
	const lines = ["Calendar read failed.", "The read endpoint did not respond.", "No page was returned."];
	const diagnostic = lines.join("\n");
	const fixtures = [
		{ content: [{ type: "text" as const, text: diagnostic }] },
		toolResult(failure(new GoogleError("BACKEND_ERROR", diagnostic))),
	];
	for (const result of fixtures) {
		component.updateResult({ ...result, isError: true });
		for (const expanded of [false, true]) {
			component.setExpanded(expanded);
			colours.mock.resetCalls();
			assert.ok(rows(component).join("\n").includes(diagnostic));
			for (const line of lines) {
				const roles = colours.mock.calls.flatMap(({ arguments: [role, value] }) =>
					value.trimEnd() === line ? [role] : [],
				);
				assert.ok(roles.length > 0);
				assert.ok(
					roles.every((role) => role === "error"),
					`${line} uses error colour`,
				);
			}
		}
	}
});

test("partial read coverage does not turn a safe read diagnostic into a mutation refusal", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card("calendar_events_list", { calendarId: "team" });
	settle(component, partial({ events: [] }, ["PRIVATE_WARNING"]));
	const coverage = rows(component).join("\n");
	assert.match(coverage, /This page contains 0 events\./);
	assert.match(coverage, /\[Partial result\]/);
	assert.doesNotMatch(coverage, /PRIVATE_WARNING/);
	settle(component, failure(new GoogleError("BACKEND_ERROR", "Calendar API returned a safe read diagnostic.")));
	const failed = rows(component).join("\n");
	assert.match(failed, /Calendar API returned a safe read diagnostic\./);
	assert.doesNotMatch(failed, /contains 0|Partial|withheld/);
});

test("Gmail separates acceptance, refusal, and an unknown effect with the causal operation", (t) => {
	expansionKey(t, ["ctrl+o"]);
	const component = card("gmail_send", {
		operationId: "requested-op",
		mail: { to: ["reader@example.invalid"], text: "PRIVATE_BODY" },
	});
	settle(component, ok({ outcome: "accepted", operationId: "accepted-op", gmailMessageId: "m1" }));
	assert.match(rows(component).join("\n"), /Gmail accepted the send\./);
	settle(component, {
		...failure(new GoogleError("API_ERROR", "PRIVATE_DIAGNOSTIC", false, undefined, "rejected-op")),
		data: { outcome: "rejected", operationId: "rejected-op", rfcMessageId: "<m@example.invalid>" },
	});
	assert.match(rows(component).join("\n"), /Gmail rejected the send\./);
	settle(
		component,
		failure(new GoogleError("SEND_OUTCOME_UNKNOWN", "PRIVATE_DIAGNOSTIC", true, undefined, "causal-op")),
	);
	assert.match(rows(component).join("\n"), /outcome is unknown/);
	component.setExpanded(true);
	const expanded = rows(component, 125).join("\n");
	assert.match(expanded, /Continue with gmail_operation_status \{"operationId":"causal-op","reconcile":true\}/);
	assert.doesNotMatch(expanded, /PRIVATE|accepted the send|rejected the send|to expand/);
});

test("ordinary registration, the display event bus and the Durable descriptor use the pure display records", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "google-display-"));
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	t.after(async () => {
		if (agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = agentDir;
		await rm(dir, { recursive: true, force: true });
	});
	const bus = createEventBus();
	const publications: unknown[] = [];
	const tools = new Map<string, ToolDefinition>();
	const shutdown: Array<() => void> = [];
	let descriptor: { entry: string; export: string; version: number } | undefined;
	bus.on("harness:tool-display:publish", (value) => publications.push(value));
	bus.on("durable:contribution", (value) => {
		descriptor = (value as { display: typeof descriptor }).display;
	});
	registerGoogle({
		events: bus,
		on: (event: string, listener: () => void) => {
			if (event === "session_shutdown") shutdown.push(listener);
		},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: () => {},
	} as unknown as ExtensionAPI);

	const display = toolDisplay();
	assert.deepEqual(publications, [display]);
	assert.deepEqual(descriptor, { version: 1, entry: "./display.ts", export: "toolDisplay" });
	assert.deepEqual(Object.keys(await import("./display.ts")), ["toolDisplay"]);
	assert.deepEqual(display.tools.map((record) => record.name).sort(), [...tools.keys()].sort());
	for (const record of display.tools) {
		assert.deepEqual(Object.keys(record).sort(), ["name", "renderCall", "renderResult", "renderShell"].sort());
		const registered = tools.get(record.name);
		assert.ok(registered);
		assert.equal(registered.renderCall, record.renderCall);
		assert.equal(registered.renderResult, record.renderResult);
		assert.equal(registered.renderShell, record.renderShell);
	}
	bus.emit("harness:tool-display:request", { version: 42 });
	assert.equal(publications.length, 1);
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.deepEqual(publications, [display, display]);
	for (const stop of shutdown) stop();
	bus.emit("harness:tool-display:request", { version: 1 });
	assert.equal(publications.length, 2);
});
