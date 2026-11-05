import assert from "node:assert/strict";
import { it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings, KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Form, type FormOptions, type FormResult } from "./form.ts";

initTheme("dark");
setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS));

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as Theme;

const cursor = /\u001b_pi:[a-z/]*\u0007/g;
const plain = (line: string) => stripVTControlCharacters(line.replace(cursor, ""));

interface HostEvents {
	readonly events: string[];
	host: FormOptions["host"];
}

function hostFixture(): HostEvents {
	const events: string[] = [];
	return {
		events,
		host: {
			theme,
			signal: new AbortController().signal,
			requestRender: () => events.push("render"),
			notify: (text, kind) => events.push(`notify:${kind}:${text}`),
			back: () => events.push("back"),
		},
	};
}

function deferredResult() {
	let release!: (result: FormResult | undefined) => void;
	const promise = new Promise<FormResult | undefined>((resolve) => {
		release = resolve;
	});
	return { promise, release };
}

const screen = (form: Form) => form.render(60, 24).map(plain).join("\n");

it("every field is visible with its staged value", () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Edit",
		heading: "Rename the session",
		intro: "Apply only renames.",
		fields: [
			{ kind: "text", id: "name", label: "Name", value: "Grace" },
			{ kind: "area", id: "notes", label: "Notes", value: "keeps context", rows: 2 },
			{
				kind: "choice",
				id: "mode",
				label: "Mode",
				value: "b",
				choices: [
					{ value: "a", label: "Alpha" },
					{ value: "b", label: "Beta" },
				],
			},
			{ kind: "info", id: "target", label: "Target", value: "This session · harness" },
		],
		action: { label: "Apply" },
		host: owner.host,
		submit: async () => undefined,
	});
	form.focused = true;
	const text = screen(form);
	assert.ok(text.includes("Rename the session"));
	assert.ok(text.includes("Apply only renames."));
	assert.ok(text.includes("Grace"));
	assert.ok(text.includes("keeps context"));
	assert.ok(text.includes("Beta"));
	assert.ok(text.includes("This session · harness"));
	assert.ok(!text.includes("Alpha"));
	assert.deepEqual(form.values(), { name: "Grace", notes: "keeps context", mode: "b", target: "This session · harness" });
});

it("submit calls the owner once even when Enter repeats while the request is pending", async () => {
	const owner = hostFixture();
	const pending = deferredResult();
	const submitted: Array<Record<string, string>> = [];
	const form = new Form({
		title: "Send",
		heading: "Send the message",
		fields: [{ kind: "text", id: "text", label: "Text", value: "hello" }],
		action: { label: "Send" },
		host: owner.host,
		submit: async (values) => {
			submitted.push(values);
			return pending.promise;
		},
	});
	const first = form.submit();
	assert.equal(form.busy, true);
	const disabled = form.actions().find((action) => action.id === "submit")?.disabled;
	assert.equal(disabled, "The request is still running");
	const second = form.submit();
	pending.release(undefined);
	await Promise.all([first, second]);
	assert.equal(submitted.length, 1);
	assert.equal(form.busy, false);
});

it("a validate message keeps the form open and calls nothing", async () => {
	const owner = hostFixture();
	let ownerCalls = 0;
	const form = new Form({
		title: "Send",
		heading: "Send the message",
		fields: [{ kind: "text", id: "name", label: "Name" }],
		action: { label: "Send" },
		host: owner.host,
		validate: () => "A name is required",
		submit: async () => {
			ownerCalls++;
			return undefined;
		},
	});
	await form.submit();
	assert.equal(ownerCalls, 0);
	assert.ok(!owner.events.includes("back"));
	assert.ok(screen(form).includes("A name is required"));
});

it("a rejected submit keeps every staged field and shows the reason", async () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Send",
		heading: "Send the message",
		fields: [
			{ kind: "text", id: "name", label: "Name" },
			{ kind: "area", id: "body", label: "Body" },
		],
		action: { label: "Send" },
		host: owner.host,
		submit: async () => {
			throw new Error("the owner refused");
		},
	});
	form.handleInput("J");
	// Enter in the single-line name field moves to the body.
	form.handleInput("\r");
	form.handleInput("o");
	await form.submit();
	assert.equal(form.values().name, "J");
	assert.equal(form.values().body, "o");
	assert.ok(!owner.events.includes("back"));
	assert.ok(screen(form).includes("the owner refused"));
});

it("a result with close leaves the form and a notice reaches the host", async () => {
	const owner = hostFixture();
	const pending = deferredResult();
	const form = new Form({
		title: "Apply",
		heading: "Apply the change",
		fields: [{ kind: "text", id: "name", label: "Name", value: "New" }],
		action: { label: "Apply" },
		host: owner.host,
		submit: () => pending.promise,
	});
	const sent = form.submit();
	pending.release({ close: true, notice: { text: "Applied", kind: "success" } });
	await sent;
	assert.equal(owner.events.filter((event) => event === "back").length, 1);
	assert.ok(owner.events.includes("notify:success:Applied"));
});

it("a result without close keeps the form open", async () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Apply",
		heading: "Apply the change",
		fields: [{ kind: "text", id: "name", label: "Name" }],
		action: { label: "Apply" },
		host: owner.host,
		submit: async () => ({ notice: { text: "Kept open", kind: "info" } }),
	});
	await form.submit();
	assert.ok(!owner.events.includes("back"));
	assert.ok(owner.events.includes("notify:info:Kept open"));
});

it("cancel calls the owner and leaves, and sends nothing", async () => {
	const owner = hostFixture();
	const order: string[] = [];
	let ownerCalls = 0;
	const form = new Form({
		title: "Apply",
		heading: "Apply the change",
		fields: [{ kind: "text", id: "name", label: "Name", value: "draft" }],
		action: { label: "Apply" },
		cancelLabel: "Discard",
		host: owner.host,
		cancel: () => order.push("cancel"),
		submit: async () => {
			ownerCalls++;
			return undefined;
		},
	});
	const actions = form.actions();
	assert.deepEqual(actions.map((action) => action.id), ["submit", "cancel"]);
	assert.equal(actions[0]?.key, "enter", "a single-field form submits on Enter");
	assert.equal(actions[1]?.key, "escape");
	assert.equal(actions[1]?.label, "Discard");
	form.cancel();
	assert.deepEqual(order, ["cancel"]);
	assert.ok(owner.events.includes("back"));
	assert.equal(ownerCalls, 0);
});

it("Enter moves to the next field and submits on the last one", async () => {
	const owner = hostFixture();
	const submitted: string[] = [];
	const form = new Form({
		title: "Edit",
		heading: "Edit two fields",
		fields: [
			{ kind: "text", id: "first", label: "First" },
			{ kind: "text", id: "second", label: "Second" },
		],
		action: { label: "Apply" },
		host: owner.host,
		submit: async (values) => {
			submitted.push(values.second ?? "");
			return undefined;
		},
	});
	assert.deepEqual(form.keys().map((hint) => hint.label), ["next", "field"]);
	assert.equal(form.actions()[0]?.key, undefined, "Submit is in More until the last field");
	assert.equal(form.handleInput("\r"), true);
	assert.ok(!owner.events.includes("back"));
	assert.deepEqual(form.keys().map((hint) => hint.label), ["apply", "field"]);
	assert.equal(form.actions()[0]?.key, "enter");
	assert.equal(form.handleInput("\r"), true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(submitted, [""], "Enter on the last field submits once");
});

it("the newline keys insert a line break in a multi-line field instead of submitting", async () => {
	const owner = hostFixture();
	let calls = 0;
	const form = new Form({
		title: "Send",
		heading: "Send the message",
		fields: [{ kind: "area", id: "body", label: "Body", rows: 3 }],
		action: { label: "Send" },
		host: owner.host,
		submit: async () => {
			calls++;
			return undefined;
		},
	});
	const newline = form.keys().find((hint) => hint.label === "newline");
	assert.ok(newline, "the footer names the newline keys");
	assert.ok(newline.keys.includes("ctrl+j"));
	assert.equal(form.handleInput("\n"), true);
	assert.ok(form.values().body.includes("\n"), "the key inserted a line break");
	assert.equal(calls, 0, "the newline key does not submit");
	assert.equal(form.handleInput("\r"), true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls, 1, "Enter still submits on the last field");
});

it("a text field reports editing so the frame keeps letters as text", () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Edit",
		heading: "Rename",
		fields: [{ kind: "text", id: "name", label: "Name" }],
		action: { label: "Apply" },
		host: owner.host,
		submit: async () => undefined,
	});
	assert.equal(form.editing(), true);
	form.handleInput("x");
	assert.equal(form.values().name, "x");
});

it("a choice reports its own keys and leaves letters to the frame", () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Pick",
		heading: "Pick a level",
		fields: [{ kind: "choice", id: "level", label: "Level", value: "a", choices: [{ value: "a", label: "Alpha" }] }],
		action: { label: "Apply" },
		host: owner.host,
		submit: async () => undefined,
	});
	assert.equal(form.editing(), false);
	assert.deepEqual(form.keys().map((hint) => hint.label), ["choose"]);
});

it("Escape runs the Cancel control's function and sends nothing", () => {
	const owner = hostFixture();
	const order: string[] = [];
	let calls = 0;
	const form = new Form({
		title: "Apply",
		heading: "Apply the change",
		fields: [{ kind: "text", id: "name", label: "Name", value: "draft" }],
		action: { label: "Apply" },
		cancelLabel: "Discard",
		host: owner.host,
		cancel: () => order.push("cancel"),
		submit: async () => {
			calls++;
			return undefined;
		},
	});
	const cancel = form.actions().find((action) => action.id === "cancel");
	assert.equal(cancel?.key, "escape");
	assert.equal(form.escape(), false, "the frame runs the action, not the view");
	cancel?.run();
	assert.deepEqual(order, ["cancel"]);
	assert.ok(owner.events.includes("back"));
	assert.equal(calls, 0);
});

it("a choice takes the first available choice when its staged value disappears", () => {
	const owner = hostFixture();
	const levels = (mode: string) =>
		mode === "fast"
			? [
					{ value: "turbo", label: "Turbo" },
					{ value: "warp", label: "Warp" },
				]
			: [
					{ value: "slow", label: "Slow" },
					{ value: "steady", label: "Steady" },
				];
	const form = new Form({
		title: "Tune",
		heading: "Tune the run",
		fields: [
			{ kind: "text", id: "mode", label: "Mode", value: "slow" },
			{ kind: "choice", id: "level", label: "Level", value: "steady", choices: (values) => levels(values.mode ?? "slow") },
		],
		action: { label: "Apply" },
		host: owner.host,
		submit: async () => undefined,
	});
	assert.equal(form.values().level, "steady");
	// The prefilled value takes the cursor at its end, so typing continues it.
	form.handleInput("x");
	assert.equal(form.values().mode, "slowx");
	for (let count = 0; count < 5; count++) form.handleInput("\x7f");
	for (const key of "fast") form.handleInput(key);
	assert.equal(form.values().mode, "fast");
	assert.equal(form.values().level, "turbo");
});

it("a filter field narrows the choices as the operator types", () => {
	const owner = hostFixture();
	const choices = [
		{ value: "alice", label: "Alice" },
		{ value: "bob", label: "Bob" },
		{ value: "carol", label: "Carol" },
	];
	const form = new Form({
		title: "Pick",
		heading: "Pick a person",
		fields: [{ kind: "choice", id: "who", label: "Who", value: "alice", choices, filter: true, rows: 3 }],
		action: { label: "Pick" },
		host: owner.host,
		submit: async () => undefined,
	});
	form.focused = true;
	const full = screen(form);
	assert.ok(full.includes("Alice"));
	assert.ok(full.includes("Carol"));
	form.handleInput("b");
	form.handleInput("o");
	const narrowed = screen(form);
	assert.ok(narrowed.includes("Bob"));
	assert.ok(!narrowed.includes("Alice"));
	assert.ok(!narrowed.includes("Carol"));
	assert.equal(form.values().who, "bob");
});

it("a filter with no match keeps the form open on no match", () => {
	const owner = hostFixture();
	const form = new Form({
		title: "Pick",
		heading: "Pick a person",
		fields: [
			{
				kind: "choice",
				id: "who",
				label: "Who",
				value: "alice",
				filter: true,
				choices: [{ value: "alice", label: "Alice" }],
			},
		],
		action: { label: "Pick" },
		host: owner.host,
		submit: async () => undefined,
	});
	form.focused = true;
	form.handleInput("z");
	assert.ok(screen(form).includes("No match"));
	assert.equal(form.handleInput("\r"), true);
	assert.ok(!owner.events.includes("back"));
});
