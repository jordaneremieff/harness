import assert from "node:assert/strict";
import { it } from "node:test";
import { createContext, runInContext, Script } from "node:vm";
import { syntaxError } from "./operations.ts";
import {
	ACTION_TYPES,
	actionScript,
	type ElementAction,
	evaluationForgetScript,
	evaluationPollScript,
	evaluationStartScript,
	INSPECT_VIEWS,
	inspectScript,
	pollScript,
} from "./page.ts";

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
		new Script(
			actionScript(ORIGIN, {
				id: "action-1",
				type,
				selector: "#target",
				index: null,
				value: type === "fill" || type === "select" ? "value" : null,
				key: type === "press" ? "Enter" : null,
			}),
		);
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
