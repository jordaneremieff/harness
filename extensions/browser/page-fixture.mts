/**
 * A page stand-in for running the generated page scripts in Node: a small DOM with
 * the element classes, CSS selectors, and events those scripts use, one isolated
 * world per document, and the task queue that delays a scheduled action. It models
 * the behaviour the scripts depend on, not a browser.
 */

import { type Context, createContext, runInContext } from "node:vm";

/* ---------------------------------------------------------------- selectors */

interface Compound {
	tag: string | null;
	id: string | null;
	attributes: Array<{ name: string; value: string | null }>;
	nthOfType: number | null;
	not: Compound[];
}

interface Step {
	compound: Compound;
	/** How this step relates to the step before it; null for the first step. */
	combinator: "child" | "descendant" | null;
}

const unescapeCss = (value: string): string => value.replace(/\\(.)/g, "$1");

/** Splits a selector list at commas outside brackets and parentheses. */
function splitList(text: string): string[] {
	return (text.match(/(?:\[[^\]]*\]|\([^)]*\)|\\.|[^,])+/g) ?? []).map((part) => part.trim());
}

const SIMPLE: Array<[RegExp, (compound: Compound, match: RegExpExecArray) => void]> = [
	[
		/^#((?:\\.|[A-Za-z0-9_-])+)/,
		(compound, match) => {
			compound.id = unescapeCss(match[1]);
		},
	],
	[
		/^\[([a-z-]+)(?:=(?:'([^']*)'|"([^"]*)"|((?:\\.|[^\]])+)))?\]/,
		(compound, match) => {
			const value = match[2] ?? match[3] ?? (match[4] === undefined ? null : unescapeCss(match[4]));
			compound.attributes.push({ name: match[1], value });
		},
	],
	[
		/^:nth-of-type\((\d+)\)/,
		(compound, match) => {
			compound.nthOfType = Number(match[1]);
		},
	],
	[
		/^:not\(([^)]*)\)/,
		(compound, match) => {
			compound.not.push(parseCompound(match[1]));
		},
	],
];

function parseCompound(text: string): Compound {
	const compound: Compound = { tag: null, id: null, attributes: [], nthOfType: null, not: [] };
	const tag = /^([a-z][a-z0-9-]*|\*)/.exec(text);
	if (tag && tag[1] !== "*") compound.tag = tag[1];
	let rest = tag ? text.slice(tag[0].length) : text;
	while (rest.length > 0) {
		const found = SIMPLE.map(([pattern, apply]) => ({ match: pattern.exec(rest), apply })).find((item) => item.match);
		if (!found?.match) throw new SyntaxError(`'${text}' is not a valid selector`);
		found.apply(compound, found.match);
		rest = rest.slice(found.match[0].length);
	}
	return compound;
}

function parseComplex(text: string): Step[] {
	const steps: Step[] = [];
	let combinator: Step["combinator"] = null;
	for (const token of text.replace(/\s*>\s*/g, " > ").split(/\s+/)) {
		if (token === ">") {
			combinator = "child";
			continue;
		}
		steps.push({
			compound: parseCompound(token),
			combinator: steps.length === 0 ? null : (combinator ?? "descendant"),
		});
		combinator = null;
	}
	if (steps.length === 0) throw new SyntaxError(`'${text}' is not a valid selector`);
	return steps;
}

function parseSelector(selector: string): Step[][] {
	return splitList(selector).map(parseComplex);
}

function matchesCompound(element: FakeElement, compound: Compound): boolean {
	if (compound.tag !== null && element.localName !== compound.tag) return false;
	if (compound.id !== null && element.getAttribute("id") !== compound.id) return false;
	for (const { name, value } of compound.attributes) {
		const actual = element.getAttribute(name);
		if (actual === null || (value !== null && actual !== value)) return false;
	}
	if (compound.nthOfType !== null) {
		const siblings = element.parentElement?.children.filter((child) => child.localName === element.localName) ?? [
			element,
		];
		if (siblings.indexOf(element) + 1 !== compound.nthOfType) return false;
	}
	return compound.not.every((inner) => !matchesCompound(element, inner));
}

function matchesSteps(element: FakeElement, steps: Step[], index: number): boolean {
	if (!matchesCompound(element, steps[index].compound)) return false;
	if (index === 0) return true;
	if (steps[index].combinator === "child")
		return element.parentElement !== null && matchesSteps(element.parentElement, steps, index - 1);
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (matchesSteps(node, steps, index - 1)) return true;
	}
	return false;
}

function matches(element: FakeElement, selector: string): boolean {
	return parseSelector(selector).some((steps) => matchesSteps(element, steps, steps.length - 1));
}

/** CSS.escape for the identifiers the fixtures use: backslash-escapes every character outside [A-Za-z0-9_-]. */
export function cssEscape(value: string): string {
	return String(value).replace(/[^A-Za-z0-9_-]/g, (char) => `\\${char}`);
}

/* ---------------------------------------------------------------- events */

export class FakeEvent {
	readonly type: string;
	target: FakeElement | null = null;
	constructor(type: string, init: Record<string, unknown> = {}) {
		this.type = type;
		Object.assign(this, init);
	}
}
export class FakeMouseEvent extends FakeEvent {}
export class FakePointerEvent extends FakeMouseEvent {}
export class FakeKeyboardEvent extends FakeEvent {}
export class FakeInputEvent extends FakeEvent {}

/* ---------------------------------------------------------------- elements */

type Child = FakeElement | string;

export class FakeElement {
	readonly localName: string;
	readonly ownerDocument: FakeDocument;
	readonly nodeType = 1;
	readonly attributes = new Map<string, string>();
	children: FakeElement[] = [];
	parentElement: FakeElement | null = null;
	/** Own text, rendered before the children. */
	text = "";
	/** Hides the element and its subtree from layout. */
	hidden = false;
	readonly listeners = new Map<string, Array<(event: FakeEvent) => void>>();
	constructor(document: FakeDocument, localName: string) {
		this.ownerDocument = document;
		this.localName = localName;
	}
	get id(): string {
		return this.getAttribute("id") ?? "";
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
	removeAttribute(name: string): void {
		this.attributes.delete(name);
	}
	get isConnected(): boolean {
		let node: FakeElement = this;
		while (node.parentElement) node = node.parentElement;
		return node === this.ownerDocument.documentElement;
	}
	get isContentEditable(): boolean {
		const value = this.getAttribute("contenteditable");
		return value === "" || value === "true";
	}
	get textContent(): string {
		return [this.text, ...this.children.map((child) => child.textContent)].join("");
	}
	set textContent(value: string) {
		for (const child of [...this.children]) child.remove();
		this.text = value;
	}
	/** Rendered text; an element that is not rendered reports its text content, as in a browser. */
	get innerText(): string {
		return this.renderedHidden() ? this.textContent : this.renderedText();
	}
	renderedText(): string {
		if (this.hidden) return "";
		return [this.text, ...this.children.map((child) => child.renderedText())].filter((part) => part !== "").join(" ");
	}
	renderedHidden(): boolean {
		for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.hidden) return true;
		return false;
	}
	checkVisibility(): boolean {
		return this.isConnected && !this.renderedHidden();
	}
	getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
		return this.checkVisibility()
			? { left: 10, top: 10, width: 100, height: 20 }
			: { left: 0, top: 0, width: 0, height: 0 };
	}
	matches(selector: string): boolean {
		return matches(this, selector);
	}
	closest(selector: string): FakeElement | null {
		for (let node: FakeElement | null = this; node; node = node.parentElement) if (node.matches(selector)) return node;
		return null;
	}
	querySelectorAll(selector: string): FakeElement[] {
		const steps = parseSelector(selector);
		const found: FakeElement[] = [];
		const visit = (node: FakeElement): void => {
			for (const child of node.children) {
				if (steps.some((complex) => matchesSteps(child, complex, complex.length - 1))) found.push(child);
				visit(child);
			}
		};
		visit(this);
		return found;
	}
	addEventListener(type: string, listener: (event: FakeEvent) => void): void {
		this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
	}
	dispatchEvent(event: FakeEvent): boolean {
		event.target = this;
		this.ownerDocument.events.push({ target: this, type: event.type });
		for (let node: FakeElement | null = this; node; node = node.parentElement) {
			for (const listener of node.listeners.get(event.type) ?? []) listener(event);
		}
		return true;
	}
	click(): void {
		this.dispatchEvent(new FakeMouseEvent("click", { bubbles: true }));
	}
	focus(): void {
		this.ownerDocument.activeElement = this;
	}
	scrollIntoView(): void {}
	remove(): void {
		if (!this.parentElement) return;
		this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
		this.parentElement = null;
	}
	append(...nodes: FakeElement[]): void {
		for (const node of nodes) {
			node.remove();
			node.parentElement = this;
			this.children.push(node);
		}
	}
	prepend(...nodes: FakeElement[]): void {
		for (const node of [...nodes].reverse()) {
			node.remove();
			node.parentElement = this;
			this.children.unshift(node);
		}
	}
	replaceWith(node: FakeElement): void {
		const parent = this.parentElement;
		if (!parent) return;
		node.remove();
		parent.children = parent.children.map((child) => (child === this ? node : child));
		node.parentElement = parent;
		this.parentElement = null;
	}
}

class FakeFormControl extends FakeElement {
	disabled = false;
	get form(): FakeElement | null {
		return this.closest("form");
	}
	get labels(): FakeElement[] {
		return [];
	}
}

export class FakeInputElement extends FakeFormControl {
	private current = "";
	checked = false;
	get type(): string {
		return (this.getAttribute("type") ?? "text").toLowerCase();
	}
	get value(): string {
		return this.current;
	}
	set value(next: string) {
		this.current = String(next);
	}
	renderedText(): string {
		return "";
	}
	click(): void {
		if (this.type === "checkbox") this.checked = !this.checked;
		if (this.type === "radio") this.checked = true;
		super.click();
	}
}

export class FakeButtonElement extends FakeFormControl {
	get type(): string {
		return (this.getAttribute("type") ?? "submit").toLowerCase();
	}
}

export class FakeTextAreaElement extends FakeFormControl {
	private current = "";
	get value(): string {
		return this.current;
	}
	set value(next: string) {
		this.current = String(next);
	}
}

export class FakeSelectElement extends FakeFormControl {
	private current = "";
	get options(): FakeElement[] {
		return this.querySelectorAll("option");
	}
	get value(): string {
		return this.current;
	}
	set value(next: string) {
		this.current = String(next);
	}
}

export class FakeAnchorElement extends FakeElement {
	get href(): string {
		const value = this.getAttribute("href");
		return value === null ? "" : new URL(value, this.ownerDocument.url).href;
	}
}

export class FakeFormElement extends FakeElement {
	submitted = 0;
	requestSubmit(): void {
		this.submitted += 1;
	}
}

const ELEMENT_CLASSES: Record<string, new (document: FakeDocument, localName: string) => FakeElement> = {
	input: FakeInputElement,
	button: FakeButtonElement,
	textarea: FakeTextAreaElement,
	select: FakeSelectElement,
	a: FakeAnchorElement,
	form: FakeFormElement,
};

/* ---------------------------------------------------------------- document */

export class FakeDocument {
	readonly url: string;
	title = "Fixture";
	readonly readyState = "complete";
	readonly visibilityState = "visible";
	readonly documentElement: FakeElement;
	readonly body: FakeElement;
	activeElement: FakeElement | null = null;
	/** Every dispatched event in this document, oldest first. */
	readonly events: Array<{ target: FakeElement; type: string }> = [];
	constructor(url: string) {
		this.url = url;
		this.documentElement = this.create("html");
		this.body = this.create("body");
		this.documentElement.append(this.body);
		this.activeElement = this.body;
	}
	create(tag: string, attributes: Record<string, string> = {}, ...children: Child[]): FakeElement {
		const Kind = ELEMENT_CLASSES[tag] ?? FakeElement;
		const element = new Kind(this, tag);
		for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
		for (const child of children) {
			if (typeof child === "string") element.text += child;
			else element.append(child);
		}
		return element;
	}
	querySelectorAll(selector: string): FakeElement[] {
		return [
			...(this.documentElement.matches(selector) ? [this.documentElement] : []),
			...this.documentElement.querySelectorAll(selector),
		];
	}
	getElementById(id: string): FakeElement | null {
		return this.querySelectorAll(`#${cssEscape(id)}`)[0] ?? null;
	}
	get links(): FakeElement[] {
		return this.querySelectorAll("a[href]");
	}
	get forms(): FakeElement[] {
		return this.querySelectorAll("form");
	}
	/** Dispatched events of one type at one element. */
	count(element: FakeElement, type = "click"): number {
		return this.events.filter((event) => event.target === element && event.type === type).length;
	}
}

/* ---------------------------------------------------------------- page */

export interface FakePage {
	/** The current document; replaced by `navigate`. */
	readonly document: FakeDocument;
	/** Runs one page script in the current document's isolated world and returns its result. */
	run(script: string): string;
	/** Runs the page tasks that scripts scheduled, as the browser does after a script returns. */
	runTasks(): void;
	/** Loads a new document at `url`: a new isolated world with no state from the previous document. */
	navigate(url: string): FakeDocument;
	/** Reads a value from the current isolated world. */
	world(expression: string): unknown;
}

/**
 * Creates a page whose first document is at `url`. `beforeTasks` runs immediately
 * before the scheduled page tasks, so a test can change the page between a script's
 * reply and the task it scheduled.
 */
export function fakePage(url: string, options: { beforeTasks?: () => void } = {}): FakePage {
	let document = new FakeDocument(url);
	const tasks: Array<() => void> = [];
	let clock = 5;
	class FakeMessageChannel {
		readonly port1 = { onmessage: null as null | ((event: { data: unknown }) => void), close: () => undefined };
		readonly port2 = {
			postMessage: (data: unknown) => {
				tasks.push(() => this.port1.onmessage?.({ data }));
			},
		};
	}
	const world = (): Context =>
		createContext({
			location: {
				get href() {
					return document.url;
				},
				get origin() {
					return new URL(document.url).origin;
				},
			},
			document,
			performance: { timeOrigin: 1000, now: () => ++clock, getEntriesByType: () => [] },
			CSS: { escape: cssEscape },
			HTMLInputElement: FakeInputElement,
			HTMLButtonElement: FakeButtonElement,
			HTMLTextAreaElement: FakeTextAreaElement,
			HTMLSelectElement: FakeSelectElement,
			HTMLAnchorElement: FakeAnchorElement,
			HTMLFormElement: FakeFormElement,
			Event: FakeEvent,
			MouseEvent: FakeMouseEvent,
			PointerEvent: FakePointerEvent,
			KeyboardEvent: FakeKeyboardEvent,
			InputEvent: FakeInputEvent,
			MessageChannel: FakeMessageChannel,
		});
	let context = world();
	const runTasks = (): void => {
		if (tasks.length === 0) return;
		options.beforeTasks?.();
		for (const task of tasks.splice(0)) task();
	};
	return {
		get document() {
			return document;
		},
		run: (script) => {
			runTasks();
			return runInContext(script, context) as string;
		},
		runTasks,
		navigate: (next) => {
			tasks.length = 0;
			document = new FakeDocument(next);
			context = world();
			return document;
		},
		world: (expression) => runInContext(expression, context),
	};
}
