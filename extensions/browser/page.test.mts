import assert from "node:assert/strict";
import { it } from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { syntaxError } from "./operations.ts";
import {
	ACTION_TYPES,
	type ActionSpec,
	actionScript,
	type ElementAction,
	evaluationForgetScript,
	evaluationPollScript,
	evaluationStartScript,
	INSPECT_VIEWS,
	inspectScript,
	pollScript,
	REF_LIMIT,
	REF_PATTERN,
} from "./page.ts";
import { type FakePage, fakePage, type FakeElement as PageElement } from "./page-fixture.mts";

const ORIGIN = "https://a.example";

function obj(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface Evaluation {
	started: Record<string, unknown>;
	poll: () => Record<string, unknown>;
	ran: boolean;
}

interface EvaluationOptions {
	maxBytes?: number;
	origin?: string;
}

/** Runs one evaluation start script in a fresh isolated-world stand-in and keeps its run entry readable. */
function startExpression(expression: string, options: EvaluationOptions = {}): Evaluation {
	const markers = { ran: false };
	const sandbox = {
		location: { href: `${ORIGIN}/page`, origin: options.origin ?? ORIGIN },
		document: { title: "Example", readyState: "complete", visibilityState: "visible" },
		performance: { timeOrigin: 1000, now: () => 5 },
		Promise,
		Map,
		TextEncoder,
		TextDecoder,
		markers,
	};
	const context = createContext(sandbox);
	const encoded = runInContext(
		evaluationStartScript(ORIGIN, "run-1", expression, options.maxBytes ?? 32_768),
		context,
	) as string;
	return {
		started: JSON.parse(encoded) as Record<string, unknown>,
		poll: () => JSON.parse(runInContext(evaluationPollScript("run-1"), context) as string) as Record<string, unknown>,
		ran: markers.ran,
	};
}

function outcomeOf(value: unknown): Record<string, unknown> {
	return obj(obj(value).outcome);
}

async function settleMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

/* ------------------------------------------------------- inspection DOM stand-in */

/** Exactly the DOM surface the `html` extraction script calls: attributes, text, cloning, and simple selectors. */
const VOID_TAGS = new Set(["input", "meta", "br", "img", "hr", "link"]);

function escapeText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
	return escapeText(value).replace(/"/g, "&quot;");
}

class FakeText {
	data: string;
	constructor(data: string) {
		this.data = data;
	}
	get textContent(): string {
		return this.data;
	}
	set textContent(value: string) {
		this.data = value;
	}
	get outerHTML(): string {
		return escapeText(this.data);
	}
	cloneNode(_deep = false): FakeText {
		return new FakeText(this.data);
	}
}

type FakeNode = FakeElement | FakeText;

class FakeElement {
	readonly localName: string;
	readonly attributes = new Map<string, string>();
	children: FakeNode[] = [];
	constructor(localName: string) {
		this.localName = localName;
	}
	getAttribute(name: string): string | null {
		return this.attributes.get(name) ?? null;
	}
	hasAttribute(name: string): boolean {
		return this.attributes.has(name);
	}
	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}
	get textContent(): string {
		return this.children.map((child) => child.textContent).join("");
	}
	set textContent(value: string) {
		this.children = value === "" ? [] : [new FakeText(value)];
	}
	cloneNode(deep = false): FakeElement {
		const copy = new FakeElement(this.localName);
		for (const [name, value] of this.attributes) copy.attributes.set(name, value);
		if (deep) copy.children = this.children.map((child) => child.cloneNode(true));
		return copy;
	}
	matches(selector: string): boolean {
		return selectorParts(selector).some((part) => matchesPart(this, part));
	}
	querySelectorAll(selector: string): FakeElement[] {
		const parts = selectorParts(selector);
		const found: FakeElement[] = [];
		const visit = (node: FakeElement): void => {
			for (const child of node.children) {
				if (!(child instanceof FakeElement)) continue;
				if (parts.some((part) => matchesPart(child, part))) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found;
	}
	get outerHTML(): string {
		const attributes = [...this.attributes].map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
		if (VOID_TAGS.has(this.localName)) return `<${this.localName}${attributes}>`;
		return `<${this.localName}${attributes}>${this.children.map((child) => child.outerHTML).join("")}</${this.localName}>`;
	}
}

function selectorParts(selector: string): string[] {
	const parts = selector
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) throw new Error(`empty selector: ${selector}`);
	return parts;
}

function matchesPart(element: FakeElement, part: string): boolean {
	if (part.startsWith("#")) return element.getAttribute("id") === part.slice(1);
	const match = /^([a-z0-9-]+)?(?:\[([a-z-]+)\])?$/.exec(part);
	if (!match) throw new Error(`unsupported selector: ${part}`);
	const tag = match[1];
	const attribute = match[2];
	if (tag !== undefined && element.localName !== tag) return false;
	if (attribute !== undefined && !element.hasAttribute(attribute)) return false;
	return true;
}

class FakeDocument {
	readonly title = "Sensitive page";
	readonly readyState = "complete";
	readonly visibilityState = "visible";
	readonly body: FakeElement;
	readonly documentElement: FakeElement;
	constructor(body: FakeElement) {
		this.body = body;
		this.documentElement = element("html", {}, [body]);
	}
	querySelectorAll(selector: string): FakeElement[] {
		return this.documentElement.querySelectorAll(selector);
	}
}

function element(localName: string, attributes: Record<string, string> = {}, children: FakeNode[] = []): FakeElement {
	const created = new FakeElement(localName);
	for (const [name, value] of Object.entries(attributes)) created.setAttribute(name, value);
	created.children = children;
	return created;
}

function text(data: string): FakeText {
	return new FakeText(data);
}

/** Runs the generated html extraction script against the stand-in and returns the windowed markup. */
function inspectHtml(document: FakeDocument, selector: string | null): { html: string; matched: unknown } {
	const sandbox = { document, location: { href: `${ORIGIN}/page`, origin: ORIGIN } };
	const encoded = runInContext(
		inspectScript(ORIGIN, { view: "html", selector, offset: 0, limit: 60, maxChars: 10_000 }),
		createContext(sandbox),
	) as string;
	const response = JSON.parse(encoded) as Record<string, unknown>;
	assert.equal(response.kind, "ok");
	return { html: String(obj(response.view).text), matched: response.matched };
}

it("masks a selected sensitive root and leaves the source node unchanged", () => {
	const password = element("input", { id: "password", type: "password", value: "sentinel-password" });
	const document = new FakeDocument(element("body", {}, [element("h1", {}, [text("Account settings")]), password]));
	const { html, matched } = inspectHtml(document, "#password");
	assert.equal(matched, 1);
	assert.equal(html.includes("sentinel-password"), false);
	assert.match(html, /^<input /);
	assert.match(html, /value="\[redacted\]"/);
	assert.equal(password.getAttribute("value"), "sentinel-password");
});

it("masks sensitive fields and token meta inside a selected container", () => {
	const recovery = element("textarea", { id: "recovery", autocomplete: "new-password" }, [text("sentinel-textarea")]);
	const card = element("input", { id: "card", autocomplete: "cc-number", value: "sentinel-card" });
	const source = element("form", { id: "account" }, [
		element("h1", {}, [text("Account settings")]),
		element("input", { id: "password", type: "password", value: "sentinel-password" }),
		element("input", { id: "hidden", type: "hidden", value: "sentinel-hidden" }),
		element("input", { id: "otp", autocomplete: "one-time-code", value: "sentinel-otp" }),
		card,
		recovery,
		element("select", { id: "otp-choice", autocomplete: "one-time-code" }, [
			element("option", { value: "sentinel-option", selected: "" }, [text("sentinel-option-label")]),
			element("option", { value: "ordinary-option" }, [text("Ordinary option")]),
		]),
		element("meta", { name: "csrf-token", content: "sentinel-meta" }),
		element("input", { id: "search", value: "ordinary-value" }),
		element("meta", { name: "description", content: "ordinary description" }),
	]);
	const document = new FakeDocument(element("body", {}, [source]));
	const { html, matched } = inspectHtml(document, "#account");
	assert.equal(matched, 1);
	for (const sentinel of [
		"sentinel-password",
		"sentinel-hidden",
		"sentinel-otp",
		"sentinel-card",
		"sentinel-textarea",
		"sentinel-option",
		"sentinel-option-label",
		"sentinel-meta",
	]) {
		assert.equal(html.includes(sentinel), false, `${sentinel} leaked`);
	}
	for (const expected of [
		"Account settings",
		"ordinary-value",
		"ordinary description",
		"Ordinary option",
		"[redacted]",
	]) {
		assert.equal(html.includes(expected), true, `${expected} missing`);
	}
	assert.equal(card.getAttribute("value"), "sentinel-card");
	assert.equal(recovery.textContent, "sentinel-textarea");
	assert.equal(source.querySelectorAll("#password")[0]?.getAttribute("value"), "sentinel-password");
});

it("masks a selected token meta root", () => {
	const meta = element("meta", { id: "token", name: "csrf-token", content: "sentinel-meta" });
	const document = new FakeDocument(element("body", {}, [meta]));
	const { html } = inspectHtml(document, "#token");
	assert.equal(html.includes("sentinel-meta"), false);
	assert.match(html, /content="\[redacted\]"/);
	assert.equal(meta.getAttribute("content"), "sentinel-meta");
});

it("every generated page script parses", () => {
	for (const view of INSPECT_VIEWS) {
		new Script(inspectScript(ORIGIN, { view, selector: null, offset: 0, limit: 60, maxChars: 2000 }));
		new Script(inspectScript(ORIGIN, { view, selector: "#target", offset: 10, limit: 20, maxChars: 200 }));
	}
	const elementActions = ACTION_TYPES.filter((type): type is ElementAction => type !== "navigate");
	for (const type of elementActions) {
		for (const target of [
			{ ref: null, selector: "#target" },
			{ ref: "doc-1:3", selector: null },
		]) {
			new Script(
				actionScript(ORIGIN, {
					id: "action-1",
					type,
					...target,
					index: null,
					value: type === "fill" || type === "select" ? "value" : null,
					key: type === "press" ? "Enter" : null,
				}),
			);
		}
	}
	new Script(pollScript("action-1", { selector: "#done" }, 1000));
	new Script(pollScript(null, null, null));
	new Script(evaluationStartScript(ORIGIN, "run-1", "1 + 1", 32_768));
	new Script(evaluationPollScript("run-1"));
	new Script(evaluationForgetScript("run-1"));
});

it("encodes a settled number", () => {
	const evaluation = startExpression("1 + 1");
	const outcome = outcomeOf(evaluation.started);
	assert.equal(evaluation.started.kind, "settled");
	assert.equal(outcome.state, "fulfilled");
	assert.equal(outcome.awaited, false);
	assert.equal(outcome.valueType, "number");
	assert.equal(outcome.value, 2);
});

it("distinguishes undefined from a missing result", () => {
	const outcome = outcomeOf(startExpression("undefined").started);
	assert.equal(outcome.valueType, "undefined");
	assert.equal("value" in outcome, false);
	assert.equal("unserializable" in outcome, false);
});

it("reports a top-level non-finite number as a special value", () => {
	const outcome = outcomeOf(startExpression("Number.NaN").started);
	assert.equal(outcome.valueType, "number");
	assert.equal(outcome.special, "NaN");
	assert.equal("value" in outcome, false);
});

it("reports a nested non-finite number at its path", () => {
	const outcome = outcomeOf(startExpression("({ n: Number.NaN })").started);
	assert.equal(obj(outcome.unserializable).path, "$.n");
});

it("reports a cycle as unserializable", () => {
	const outcome = outcomeOf(startExpression("(() => { const o = {}; o.self = o; return o; })()").started);
	assert.equal(obj(outcome.unserializable).reason, "Circular reference.");
});

it("reports a Map as unserializable", () => {
	const outcome = outcomeOf(startExpression('new Map([["a", 1]])').started);
	assert.equal(outcome.valueType, "object");
	assert.match(String(obj(outcome.unserializable).reason), /not JSON data/);
});

it("encodes a Date as an ISO string", () => {
	const outcome = outcomeOf(startExpression('new Date("2020-01-02T03:04:05.000Z")').started);
	assert.equal(outcome.value, "2020-01-02T03:04:05.000Z");
});

it("keeps an own __proto__ key from parsed JSON", () => {
	const outcome = outcomeOf(startExpression('JSON.parse(\'{"__proto__":{"note":"value"},"other":1}\')').started);
	assert.equal(outcome.valueType, "object");
	const value = obj(outcome.value);
	assert.equal(Object.getPrototypeOf(value), Object.prototype);
	const descriptor = Object.getOwnPropertyDescriptor(value, "__proto__");
	assert.ok(descriptor, "own __proto__ key is retained");
	assert.equal(descriptor.enumerable, true);
	assert.equal(descriptor.writable, true);
	assert.deepEqual(descriptor.value, { note: "value" });
	assert.equal(value.other, 1);
});

it("counts nested undefined values that JSON drops", () => {
	const outcome = outcomeOf(startExpression("({ a: undefined, b: 1 })").started);
	assert.equal(outcome.undefinedDropped, 1);
	assert.deepEqual(outcome.value, { b: 1 });
});

it("reports a bigint as a special value", () => {
	const outcome = outcomeOf(startExpression("10n").started);
	assert.equal(outcome.valueType, "bigint");
	assert.equal(outcome.special, "10");
	assert.equal(outcome.bytes, 2);
	assert.equal("tooLarge" in outcome, false);
});

it("bounds a bigint whose decimal text exceeds maxBytes", () => {
	const outcome = outcomeOf(startExpression("10n ** 2048n", { maxBytes: 1024 }).started);
	assert.equal(outcome.valueType, "bigint");
	assert.equal(outcome.tooLarge, true);
	assert.equal(outcome.bytes, 2049);
	assert.equal("special" in outcome, false);
	assert.equal("value" in outcome, false);
	const preview = String(outcome.preview);
	assert.equal(preview.length, 1024);
	assert.equal(preview, `1${"0".repeat(1023)}`);
});

it("marks a value larger than maxBytes as too large with a preview", () => {
	const outcome = outcomeOf(startExpression('"x".repeat(20)', { maxBytes: 8 }).started);
	assert.equal(outcome.tooLarge, true);
	assert.equal(outcome.bytes, 22);
	assert.equal(String(outcome.preview).length, 8);
	assert.equal("value" in outcome, false);
});

it("keeps a multibyte preview within maxBytes bytes without a split character", () => {
	const outcome = outcomeOf(startExpression('"é".repeat(20)', { maxBytes: 8 }).started);
	assert.equal(outcome.tooLarge, true);
	const preview = String(outcome.preview);
	assert.ok(Buffer.byteLength(preview) <= 8);
	assert.equal(preview, '"ééé');
});

it("reports a synchronous throw as settled with the error name and message", () => {
	const evaluation = startExpression('(() => { throw new RangeError("bad range"); })()');
	const outcome = outcomeOf(evaluation.started);
	assert.equal(evaluation.started.kind, "settled");
	assert.equal(outcome.state, "threw");
	assert.equal(obj(outcome.error).name, "RangeError");
	assert.equal(obj(outcome.error).message, "bad range");
});

it("reads a rejected promise back through the poll script", async () => {
	const evaluation = startExpression('Promise.reject(new TypeError("no"))');
	assert.equal(evaluation.started.kind, "pending");
	await settleMicrotasks();
	const polled = evaluation.poll();
	assert.equal(polled.kind, "settled");
	const outcome = obj(polled.outcome);
	assert.equal(outcome.state, "rejected");
	assert.equal(obj(outcome.error).name, "TypeError");
	assert.equal(obj(outcome.error).message, "no");
});

it("keeps a non-Error rejection as the thrown value", async () => {
	const evaluation = startExpression('Promise.reject("plain text")');
	assert.equal(evaluation.started.kind, "pending");
	await settleMicrotasks();
	const outcome = obj(evaluation.poll().outcome);
	assert.equal(outcome.state, "rejected");
	assert.equal(obj(outcome.error).name, null);
	assert.equal(obj(obj(outcome.error).thrown).value, "plain text");
});

it("refuses an origin mismatch without evaluating the expression", () => {
	const evaluation = startExpression("(globalThis.markers.ran = true, 1)", { origin: "https://b.example" });
	assert.equal(evaluation.started.kind, "origin-mismatch");
	assert.equal(obj(evaluation.started.page).origin, "https://b.example");
	assert.equal(evaluation.ran, false);
});

it("syntaxError accepts valid expressions and rejects invalid ones", () => {
	assert.equal(syntaxError("1 + 1"), null);
	assert.equal(syntaxError("({ a: 1 })"), null);
	const problem = syntaxError("1 +");
	assert.equal(typeof problem, "string");
	assert.notEqual(problem, null);
});

/* ------------------------------------------------------- element references */

const PAGE_URL = `${ORIGIN}/inbox`;

type Envelope = Record<string, unknown>;

function inspectElements(page: FakePage, options: { offset?: number; limit?: number } = {}): Envelope {
	const script = inspectScript(ORIGIN, {
		view: "elements",
		selector: null,
		offset: options.offset ?? 0,
		limit: options.limit ?? 60,
		maxChars: 2000,
	});
	return JSON.parse(page.run(script)) as Envelope;
}

function elementsOf(envelope: Envelope): Array<Record<string, unknown>> {
	const elements = obj(envelope.view).elements;
	return Array.isArray(elements) ? elements.map(obj) : [];
}

let actionCount = 0;

/** Runs one action script, then the page task it scheduled; returns the reply and the recorded action state. */
function act(page: FakePage, target: Partial<ActionSpec>): { reply: Envelope; record: Envelope | null } {
	const id = `action-${++actionCount}`;
	const spec: ActionSpec = {
		id,
		type: "click",
		ref: null,
		selector: null,
		index: null,
		value: null,
		key: null,
		...target,
	};
	const reply = JSON.parse(page.run(actionScript(ORIGIN, spec))) as Envelope;
	page.runTasks();
	const polled = JSON.parse(page.run(pollScript(id, null, null))) as Envelope;
	return { reply, record: polled.action ? obj(polled.action) : null };
}

/** Three inbox rows, each with a title and an Archive button that has the same accessible name. */
function inbox(page: FakePage): { list: PageElement; rows: PageElement[]; buttons: PageElement[] } {
	const d = page.document;
	const rows = ["Alpha", "Bravo", "Charlie"].map((title) =>
		d.create("li", {}, d.create("span", {}, title), d.create("button", { type: "button" }, "Archive")),
	);
	const list = d.create("ul", {}, ...rows);
	d.body.append(list);
	return { list, rows, buttons: rows.map((row) => row.children[1]) };
}

function clicks(page: FakePage, element: PageElement): number {
	return page.document.count(element, "click");
}

it("issues document-qualified element references and repeats them for an unchanged element", () => {
	const page = fakePage(PAGE_URL);
	inbox(page);
	const first = inspectElements(page);
	const doc = String(obj(first.page).doc);
	const refs = elementsOf(first).map((element) => String(element.ref));
	assert.equal(refs.length, 3);
	assert.equal(new Set(refs).size, 3);
	for (const ref of refs) {
		assert.match(ref, new RegExp(REF_PATTERN));
		assert.equal(ref.startsWith(`${doc}:`), true);
	}
	assert.deepEqual(
		elementsOf(inspectElements(page)).map((element) => element.ref),
		refs,
	);
	assert.equal(elementsOf(first)[1].selector, "body > ul > li:nth-of-type(2) > button");
	assert.deepEqual(
		elementsOf(first).map((element) => element.context),
		["Alpha Archive", "Bravo Archive", "Charlie Archive"],
		"elements that share a name carry the text of their row",
	);
});

it("acts on the inspected element after the list reorders, where the old positional selector reaches another row", () => {
	const page = fakePage(PAGE_URL);
	const { list, rows, buttons } = inbox(page);
	const bravo = elementsOf(inspectElements(page))[1];
	list.prepend(rows[2]);

	const bySelector = act(page, { selector: String(bravo.selector) });
	assert.equal(bySelector.reply.kind, "scheduled");
	assert.equal(clicks(page, buttons[0]), 1, "the old positional selector clicked Alpha's button");
	assert.equal(clicks(page, buttons[1]), 0);

	const byRef = act(page, { ref: String(bravo.ref) });
	assert.equal(byRef.reply.kind, "scheduled");
	assert.equal(obj(byRef.reply.element).ref, bravo.ref);
	assert.equal(obj(byRef.record).state, "dispatched");
	assert.equal(clicks(page, buttons[1]), 1, "the ref clicked Bravo's button");
	assert.equal(clicks(page, buttons[0]), 1);
});

it("refuses a replaced element by ref while the old positional selector clicks the replacement", () => {
	const page = fakePage(PAGE_URL);
	const { buttons } = inbox(page);
	const bravo = elementsOf(inspectElements(page))[1];
	const replacement = page.document.create("button", { type: "button" }, "Archive");
	buttons[1].replaceWith(replacement);

	const byRef = act(page, { ref: String(bravo.ref) });
	assert.equal(byRef.reply.kind, "stale-reference");
	assert.equal(byRef.reply.cause, "detached");
	assert.deepEqual(obj(byRef.reply.inspected), {
		tag: "button",
		role: null,
		type: "button",
		name: "Archive",
		href: null,
	});
	assert.equal(byRef.record, null, "no action was scheduled");
	assert.equal(page.document.events.length, 0, "nothing was dispatched to any element");

	act(page, { selector: String(bravo.selector) });
	assert.equal(clicks(page, replacement), 1, "the old positional selector clicked the replacement");
	assert.equal(clicks(page, buttons[1]), 0);
});

it("refuses a detached element by ref and releases it from the page world", () => {
	const page = fakePage(PAGE_URL);
	const { rows, buttons } = inbox(page);
	const bravo = elementsOf(inspectElements(page))[1];
	rows[1].remove();

	const byRef = act(page, { ref: String(bravo.ref) });
	assert.equal(byRef.reply.kind, "stale-reference");
	assert.equal(byRef.reply.cause, "detached");
	assert.equal(page.document.events.length, 0);
	const n = Number(String(bravo.ref).split(":")[1]);
	assert.equal(page.world(`globalThis.__piBrowser.refs.byRef.get(${n}).el`), null);

	act(page, { selector: String(bravo.selector) });
	assert.equal(clicks(page, buttons[2]), 1, "the old positional selector clicked Charlie's button");
});

it("refuses a repurposed element and gives the same element a new ref on the next inspection", () => {
	const page = fakePage(PAGE_URL);
	const { buttons } = inbox(page);
	const bravo = elementsOf(inspectElements(page))[1];
	buttons[1].textContent = "Delete forever";

	const stale = act(page, { ref: String(bravo.ref) });
	assert.equal(stale.reply.kind, "stale-reference");
	assert.equal(stale.reply.cause, "repurposed");
	assert.equal(obj(stale.reply.inspected).name, "Archive");
	assert.equal(obj(stale.reply.current).name, "Delete forever");
	assert.equal(page.document.events.length, 0);

	const fresh = elementsOf(inspectElements(page))[1];
	assert.equal(fresh.name, "Delete forever");
	assert.notEqual(fresh.ref, bravo.ref);
	assert.equal(act(page, { ref: String(bravo.ref) }).reply.cause, "repurposed", "the old ref keeps the old identity");
	assert.equal(obj(act(page, { ref: String(fresh.ref) }).record).state, "dispatched");
	assert.equal(clicks(page, buttons[1]), 1);
});

it("refuses a ref from the previous document after a same-origin navigation", () => {
	const page = fakePage(PAGE_URL);
	inbox(page);
	const before = elementsOf(inspectElements(page));
	const next = page.navigate(`${ORIGIN}/inbox?page=2`);
	const { buttons } = inbox(page);
	const after = elementsOf(inspectElements(page));
	assert.notEqual(String(after[1].ref).split(":")[0], String(before[1].ref).split(":")[0]);
	assert.equal(
		String(after[1].ref).split(":")[1],
		String(before[1].ref).split(":")[1],
		"the new document numbers its refs anew",
	);

	const stale = act(page, { ref: String(before[1].ref) });
	assert.equal(stale.reply.kind, "stale-reference");
	assert.equal(stale.reply.cause, "other-document");
	assert.equal(next.events.length, 0);
	assert.equal(obj(act(page, { ref: String(after[1].ref) }).record).state, "dispatched");
	assert.equal(clicks(page, buttons[1]), 1);
});

it("records not-dispatched when the referenced element changes between the reply and the dispatch task", () => {
	let change: (() => void) | null = null;
	const page = fakePage(PAGE_URL, {
		beforeTasks: () => {
			change?.();
			change = null;
		},
	});
	const { buttons } = inbox(page);
	const refs = elementsOf(inspectElements(page)).map((element) => String(element.ref));
	const replacement = page.document.create("button", { type: "button" }, "Archive");

	change = () => buttons[1].replaceWith(replacement);
	const detached = act(page, { ref: refs[1] });
	assert.equal(detached.reply.kind, "scheduled");
	assert.equal(obj(detached.record).state, "not-dispatched");
	assert.equal(obj(obj(detached.record).error).name, "StaleReference");
	assert.equal(obj(obj(detached.record).error).cause, "detached");

	change = () => {
		buttons[2].textContent = "Delete";
	};
	const repurposed = act(page, { ref: refs[2] });
	assert.equal(obj(repurposed.record).state, "not-dispatched");
	assert.equal(obj(obj(repurposed.record).error).cause, "repurposed");
	assert.equal(page.document.events.length, 0, "no element received an event");
});

it("keeps a field's ref through fill and press, because its value is not part of its identity", () => {
	const page = fakePage(PAGE_URL);
	const d = page.document;
	const search = d.create("input", { type: "search", placeholder: "Search mail" });
	const composer = d.create("div", { contenteditable: "true", "aria-label": "Message" });
	const plain = d.create("div", { contenteditable: "true" });
	d.body.append(search, composer, plain);
	const fields = elementsOf(inspectElements(page));
	assert.equal(
		fields.some((field) => "context" in field),
		false,
		"elements with distinct names carry no context",
	);
	const [searchRef, composerRef, plainRef] = fields.map((field) => String(field.ref));

	assert.equal(obj(act(page, { ref: searchRef, type: "fill", value: "invoices" }).record).state, "dispatched");
	assert.equal(obj(act(page, { ref: searchRef, type: "press", key: "Enter" }).record).state, "dispatched");
	assert.equal(obj(act(page, { ref: composerRef, type: "fill", value: "Hello" }).record).state, "dispatched");
	assert.equal(obj(act(page, { ref: composerRef, type: "press", key: "Enter" }).record).state, "dispatched");
	assert.equal(obj(act(page, { ref: plainRef, type: "fill", value: "Draft" }).record).state, "dispatched");
	assert.equal(obj(act(page, { ref: plainRef, type: "press", key: "Enter" }).record).state, "dispatched");
	assert.equal((search as PageElement & { value: string }).value, "invoices");
	assert.equal(composer.textContent, "Hello");
	assert.equal(page.document.count(search, "keydown"), 1);
});

it("gives refs to ambiguous-selector candidates and to the element an action reports", () => {
	const page = fakePage(PAGE_URL);
	const { buttons } = inbox(page);
	const ambiguous = act(page, { selector: "button" });
	assert.equal(ambiguous.reply.kind, "ambiguous");
	const candidates = Array.isArray(ambiguous.reply.candidates) ? ambiguous.reply.candidates.map(obj) : [];
	assert.equal(candidates.length, 3);
	assert.equal(candidates[2].context, "Charlie Archive");
	const chosen = act(page, { ref: String(candidates[2].ref) });
	assert.equal(obj(chosen.reply.element).ref, candidates[2].ref);
	assert.equal(clicks(page, buttons[2]), 1);
});

it("refuses an unknown ref and keeps at most the reference limit", () => {
	const page = fakePage(PAGE_URL);
	const d = page.document;
	for (let i = 0; i < REF_LIMIT + 20; i++) d.body.append(d.create("button", { type: "button" }, `Item ${i}`));
	const first = elementsOf(inspectElements(page, { limit: 200 }))[0];
	for (let offset = 200; offset < REF_LIMIT + 20; offset += 200) inspectElements(page, { offset, limit: 200 });
	assert.equal(page.world("globalThis.__piBrowser.refs.byRef.size"), REF_LIMIT);

	const evicted = act(page, { ref: String(first.ref) });
	assert.equal(evicted.reply.kind, "stale-reference");
	assert.equal(evicted.reply.cause, "not-retained");
	const doc = String(first.ref).split(":")[0];
	assert.equal(act(page, { ref: `${doc}:999999` }).reply.cause, "not-retained");
	assert.equal(page.document.events.length, 0);
});

it("checks actionability on the referenced element", () => {
	const page = fakePage(PAGE_URL);
	const { buttons } = inbox(page);
	const refs = elementsOf(inspectElements(page)).map((element) => String(element.ref));
	(buttons[0] as PageElement & { disabled: boolean }).disabled = true;
	buttons[1].hidden = true;
	assert.equal(act(page, { ref: refs[0] }).reply.kind, "not-actionable");
	assert.equal(act(page, { ref: refs[1] }).reply.kind, "not-actionable");
	assert.equal(page.document.events.length, 0);
});
