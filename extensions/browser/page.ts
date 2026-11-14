/**
 * Page-side scripts. Chromium runs `execute javascript` in an isolated JavaScript
 * world of the tab's main frame: the script shares the DOM, storage, cookies, and
 * network identity with the page but not its JavaScript globals. State that a
 * later call reads (pending evaluations, scheduled actions, element references,
 * the document token) lives in that world and disappears when the document is
 * replaced.
 *
 * Every script is one expression that returns a JSON string, so Apple Events
 * carries text and the extension parses one envelope.
 */

export const INSPECT_VIEWS = ["summary", "text", "elements", "html", "network"] as const;
export type InspectView = (typeof INSPECT_VIEWS)[number];

export const ACTION_TYPES = [
	"click",
	"fill",
	"select",
	"check",
	"uncheck",
	"press",
	"submit",
	"focus",
	"scroll",
	"navigate",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type ElementAction = Exclude<ActionType, "navigate">;

export interface Condition {
	selector?: string;
	text?: string;
	gone?: string;
	urlIncludes?: string;
}

const literal = (value: unknown) => JSON.stringify(value ?? null);

/** Opens every page script: the world state, page identity, and the optional origin precondition. */
function prelude(expectOrigin: string | null): string {
	return `"use strict";
const S = globalThis.__piBrowser || (globalThis.__piBrowser = { doc: Date.now().toString(36) + "-" + Math.random().toString(36).slice(2), runs: new Map(), actions: new Map() });
const page = () => ({ doc: S.doc, url: location.href, origin: location.origin, title: document.title, readyState: document.readyState, visibility: document.visibilityState });
const expectOrigin = ${literal(expectOrigin)};
if (expectOrigin !== null && location.origin !== expectOrigin) return JSON.stringify({ kind: "origin-mismatch", page: page() });`;
}

/**
 * Element references retained per document. A reference holds the element itself
 * and the identity that inspection reported, so an action reaches the inspected
 * element or refuses; it never resolves a selector again. The newest
 * `REF_LIMIT` references are kept, a reference that inspection reports again
 * becomes the newest, and a detached element is released at the next script that
 * reads the references, leaving its identity for the refusal.
 */
export const REF_LIMIT = 500;

/** `<document token>:<number>`; the token comes from the document's page world. */
export const REF_PATTERN = "^[0-9a-z-]{1,40}:[1-9][0-9]{0,8}$";

const HELPERS = `
const clip = (value, limit) => { const s = String(value == null ? "" : value); return s.length > limit ? s.slice(0, limit) : s; };
const squash = (value) => String(value == null ? "" : value).replace(/\\s+/g, " ").trim();
const isVisible = (el) => {
  if (!el.isConnected) return false;
  if (typeof el.checkVisibility === "function" && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
};
const sensitive = (el) => {
  const type = (el.getAttribute("type") || "").toLowerCase();
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  return type === "password" || type === "hidden" || /(^|\\s)(cc-[a-z-]+|one-time-code|current-password|new-password)(\\s|$)/.test(autocomplete);
};
const labelName = (el) => {
  const aria = el.getAttribute("aria-label");
  if (aria && squash(aria)) return squash(aria);
  const by = el.getAttribute("aria-labelledby");
  if (by) { const t = squash(by.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.innerText : ""; }).join(" ")); if (t) return t; }
  if (el.labels && el.labels.length) { const t = squash(Array.from(el.labels).map((l) => l.innerText).join(" ")); if (t) return t; }
  for (const attr of ["placeholder", "title", "alt"]) { const v = el.getAttribute(attr); if (v && squash(v)) return squash(v); }
  if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) return squash(el.value);
  return null;
};
const accName = (el) => {
  const label = labelName(el);
  return label !== null ? label : squash(el.innerText != null ? el.innerText : el.textContent);
};
const editable = (el) => el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement || el.isContentEditable === true;
// What inspection reported about the element's purpose. Values, checked state, and
// the content of an editable field change through ordinary use, so they are not part of it.
const identity = (el) => ({
  tag: el.localName,
  role: el.getAttribute("role"),
  type: (el instanceof HTMLInputElement || el instanceof HTMLButtonElement) && el.type ? el.type : null,
  name: clip(editable(el) ? labelName(el) || "" : accName(el), 120),
  href: el instanceof HTMLAnchorElement && el.href ? clip(el.href, 300) : null,
});
const identityKey = (value) => JSON.stringify([value.tag, value.role, value.type, value.name, value.href]);
const attached = (el) => Boolean(el) && el.isConnected === true && el.ownerDocument === document;
const R = S.refs || (S.refs = { seq: 0, byRef: new Map(), byEl: new WeakMap() });
for (const record of R.byRef.values()) if (record.el !== null && !attached(record.el)) record.el = null;
const refFor = (el) => {
  const now = identity(el);
  const key = identityKey(now);
  const known = R.byEl.get(el);
  const record = known === undefined ? undefined : R.byRef.get(known);
  if (record && record.el === el && record.key === key) {
    R.byRef.delete(known);
    R.byRef.set(known, record);
    return S.doc + ":" + known;
  }
  const n = ++R.seq;
  while (R.byRef.size >= ${REF_LIMIT}) R.byRef.delete(R.byRef.keys().next().value);
  R.byRef.set(n, { el, key, identity: now });
  R.byEl.set(el, n);
  return S.doc + ":" + n;
};
// Resolves a reference to its retained element, or names why the reference no longer reaches it.
const resolveRef = (ref) => {
  const at = ref.lastIndexOf(":");
  if (at < 1 || ref.slice(0, at) !== S.doc) return { cause: "other-document" };
  const record = R.byRef.get(Number(ref.slice(at + 1)));
  if (!record) return { cause: "not-retained" };
  if (!attached(record.el)) { record.el = null; return { cause: "detached", inspected: record.identity }; }
  const now = identity(record.el);
  if (identityKey(now) !== record.key) return { cause: "repurposed", inspected: record.identity, current: now };
  return { el: record.el, record };
};
const unique = (selector) => { try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; } };
const cssPath = (el) => {
  if (el.id && unique("#" + CSS.escape(el.id))) return "#" + CSS.escape(el.id);
  const name = el.getAttribute("name");
  if (name) { const s = el.localName + "[name=" + CSS.escape(name) + "]"; if (unique(s)) return s; }
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    if (node.id && unique("#" + CSS.escape(node.id))) { parts.unshift("#" + CSS.escape(node.id)); break; }
    let part = node.localName;
    const parent = node.parentElement;
    if (parent) {
      const same = Array.from(parent.children).filter((c) => c.localName === node.localName);
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    node = parent;
  }
  return parts.join(" > ");
};
const describe = (el) => {
  const out = { ref: refFor(el), selector: cssPath(el), tag: el.localName, role: el.getAttribute("role"), name: clip(accName(el), 120), visible: isVisible(el) };
  if ((el instanceof HTMLInputElement || el instanceof HTMLButtonElement) && el.type) out.type = el.type;
  if ("disabled" in el) out.disabled = Boolean(el.disabled);
  if (el instanceof HTMLAnchorElement && el.href) out.href = clip(el.href, 300);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    out.value = sensitive(el) ? "[redacted]" : clip(el.value, 200);
  }
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) out.checked = el.checked;
  return out;
};
// Text of the nearest ancestor that says more than the element's own name, such as the row of a per-row button.
const contextOf = (el, name) => {
  for (let node = el.parentElement, depth = 0; node && node !== document.body && node !== document.documentElement && depth < 8; node = node.parentElement, depth++) {
    const text = squash(node.innerText);
    if (text && text !== name) return clip(text, 100);
  }
  return null;
};
// Describes elements; one whose name another of them shares also carries its context to tell them apart.
const describeAll = (elements) => {
  const described = elements.map(describe);
  const counts = new Map();
  for (const item of described) counts.set(item.name, (counts.get(item.name) || 0) + 1);
  described.forEach((item, i) => { if (counts.get(item.name) > 1) { const context = contextOf(elements[i], item.name); if (context !== null) item.context = context; } });
  return described;
};
const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=link], [role=checkbox], [role=radio], [role=tab], [role=menuitem], [role=switch], [role=option], [role=combobox], [contenteditable=''], [contenteditable=true], [tabindex]:not([tabindex='-1'])";
const select = (selector) => { try { return { nodes: Array.from(document.querySelectorAll(selector)) }; } catch (e) { return { error: clip(e && e.message, 300) }; } };
`;

function script(expectOrigin: string | null, body: string, helpers = true): string {
	return `(() => {\n${prelude(expectOrigin)}\n${helpers ? HELPERS : ""}\n${body}\n})()`;
}

export interface InspectOptions {
	view: InspectView;
	selector: string | null;
	offset: number;
	limit: number;
	maxChars: number;
}

/** Bounded read-only extraction. Password, hidden, and similar field values are redacted. */
export function inspectScript(expectOrigin: string | null, options: InspectOptions): string {
	return script(
		expectOrigin,
		`const O = ${literal(options)};
let root = document.body || document.documentElement;
let matched = null;
if (O.selector !== null) {
  const found = select(O.selector);
  if (found.error) return JSON.stringify({ kind: "bad-selector", message: found.error, page: page() });
  matched = found.nodes.length;
  if (matched === 0) return JSON.stringify({ kind: "not-found", matched: 0, page: page() });
  root = found.nodes[0];
}
const window_ = (text) => ({ text: text.slice(O.offset, O.offset + O.maxChars), offset: O.offset, total: text.length, nextOffset: O.offset + O.maxChars < text.length ? O.offset + O.maxChars : null });
let view;
if (O.view === "summary") {
  const text = squash(root.innerText);
  view = {
    headings: Array.from(document.querySelectorAll("h1, h2, h3")).filter(isVisible).slice(0, 20).map((h) => ({ level: Number(h.localName[1]), text: clip(squash(h.innerText), 160) })),
    counts: { links: document.links.length, forms: document.forms.length, interactive: document.querySelectorAll(INTERACTIVE).length, iframes: document.querySelectorAll("iframe").length },
    focused: document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement ? describe(document.activeElement) : null,
    dialogs: Array.from(document.querySelectorAll("dialog[open], [role=dialog], [role=alertdialog]")).filter(isVisible).slice(0, 3).map(describe),
    text: window_(text),
  };
} else if (O.view === "text") {
  view = window_(String(root.innerText || "").replace(/\\n{3,}/g, "\\n\\n"));
} else if (O.view === "elements") {
  const all = Array.from(root.querySelectorAll(INTERACTIVE)).filter(isVisible);
  view = { total: all.length, offset: O.offset, elements: describeAll(all.slice(O.offset, O.offset + O.limit)), nextOffset: O.offset + O.limit < all.length ? O.offset + O.limit : null };
} else if (O.view === "html") {
  const copy = root.cloneNode(true);
  const under = (selector) => (copy.querySelectorAll ? Array.from(copy.querySelectorAll(selector)) : []);
  const itself = (selector) => (typeof copy.matches === "function" && copy.matches(selector) ? [copy] : []);
  const fields = [...itself("input, textarea, select"), ...under("input, textarea, select")];
  for (const field of fields) {
    if (!sensitive(field)) continue;
    if (field.localName === "input") { if (field.hasAttribute("value")) field.setAttribute("value", "[redacted]"); }
    else if (field.localName === "textarea") { field.textContent = "[redacted]"; }
    else {
      const options = Array.from(field.querySelectorAll("option"));
      const chosen = options.filter((option) => option.hasAttribute("selected"));
      for (const option of options) if (option.hasAttribute("value")) option.setAttribute("value", "[redacted]");
      for (const option of chosen.length > 0 ? chosen : options.slice(0, 1)) option.textContent = "[redacted]";
    }
  }
  const metas = [...itself("meta[name]"), ...under("meta[name]")];
  for (const meta of metas) if (/csrf|token|nonce/i.test(meta.getAttribute("name") || "")) meta.setAttribute("content", "[redacted]");
  view = window_(copy.outerHTML || "");
} else {
  const nav = performance.getEntriesByType("navigation")[0];
  const entries = performance.getEntriesByType("resource");
  const recent = entries.slice(Math.max(0, entries.length - O.limit));
  view = {
    navigation: nav ? { url: clip(nav.name, 300), type: nav.type, status: typeof nav.responseStatus === "number" ? nav.responseStatus : null } : null,
    resources: recent.map((e) => ({ url: clip(e.name, 300), initiator: e.initiatorType, status: typeof e.responseStatus === "number" ? e.responseStatus : null, durationMs: Math.round(e.duration), at: Math.round(performance.timeOrigin + e.startTime) })),
    total: entries.length,
  };
}
return JSON.stringify({ kind: "ok", page: page(), matched, view });`,
	);
}

/** An element action names its target by `ref` from inspection, or by `selector` (with `index`) for low-level use. */
export interface ActionSpec {
	id: string;
	type: ElementAction;
	ref: string | null;
	selector: string | null;
	index: number | null;
	value: string | null;
	key: string | null;
}

/**
 * Resolves one element and schedules the action in a new task, then returns at once.
 * A JavaScript dialog opened by a page handler therefore blocks later reads, not
 * this reply. A later `pollScript` reports whether the action ran.
 *
 * A reference reaches only its retained element, after the document, attachment,
 * and identity checks; the scheduled task repeats the attachment and identity
 * checks immediately before it dispatches, and records `not-dispatched` when they
 * fail. A selector is resolved again in the current document.
 */
export function actionScript(expectOrigin: string, spec: ActionSpec): string {
	return script(
		expectOrigin,
		`const A = ${literal(spec)};
let el;
let held = null;
if (A.ref !== null) {
  const resolved = resolveRef(A.ref);
  if (!resolved.el) return JSON.stringify({ kind: "stale-reference", ref: A.ref, cause: resolved.cause, inspected: resolved.inspected || null, current: resolved.current || null, page: page() });
  el = resolved.el;
  held = resolved.record;
} else {
  const found = select(A.selector);
  if (found.error) return JSON.stringify({ kind: "bad-selector", message: found.error, page: page() });
  const nodes = found.nodes;
  if (nodes.length === 0) return JSON.stringify({ kind: "not-found", matched: 0, page: page() });
  if (nodes.length > 1 && A.index === null) return JSON.stringify({ kind: "ambiguous", matched: nodes.length, candidates: describeAll(nodes.slice(0, 5)), page: page() });
  el = nodes[A.index === null ? 0 : A.index];
  if (!el) return JSON.stringify({ kind: "not-found", matched: nodes.length, page: page() });
}
// The reference check, repeated in the dispatch task because page code can run between this reply and that task.
const changed = () => {
  if (held === null) return null;
  if (!attached(el)) return { cause: "detached", message: "The referenced element left the page before the action ran." };
  const now = identity(el);
  if (identityKey(now) !== held.key) return { cause: "repurposed", message: "The referenced element changed its role, name, type, or link target before the action ran.", current: now };
  return null;
};
const refuse = (reason) => JSON.stringify({ kind: "not-actionable", reason, element: describe(el), page: page() });
const isInput = el instanceof HTMLInputElement;
if ("disabled" in el && el.disabled) return refuse("The element is disabled.");
if (!["submit", "scroll", "focus"].includes(A.type) && !isVisible(el)) return refuse("The element is not visible.");
let perform;
if (A.type === "click") {
  perform = () => {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", isPrimary: true, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...at, buttons: 1 }));
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", isPrimary: true }));
    el.dispatchEvent(new MouseEvent("mouseup", at));
    el.click();
  };
} else if (A.type === "fill") {
  if (isInput && el.type === "password") return refuse("The tool does not type into password fields; sign in through the browser.");
  if (isInput && ["checkbox", "radio", "file", "submit", "button", "reset", "image", "range", "color"].includes(el.type)) return refuse("fill needs a text field; use check, uncheck, or click.");
  const textual = isInput || el instanceof HTMLTextAreaElement;
  if (!textual && !el.isContentEditable) return refuse("fill needs an input, textarea, or editable element.");
  perform = () => {
    el.focus({ preventScroll: true });
    if (textual) {
      const proto = isInput ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value").set.call(el, A.value);
    } else {
      el.textContent = A.value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertReplacementText", data: A.value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
} else if (A.type === "select") {
  if (!(el instanceof HTMLSelectElement)) return refuse("select needs a select element.");
  const option = Array.from(el.options).find((o) => o.value === A.value) || Array.from(el.options).find((o) => squash(o.label || o.text) === squash(A.value));
  if (!option) return refuse("No option has this value or label.");
  perform = () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(el, option.value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  };
} else if (A.type === "check" || A.type === "uncheck") {
  const desired = A.type === "check";
  const checkable = isInput && (el.type === "checkbox" || el.type === "radio");
  const ariaCheckable = ["checkbox", "switch", "radio"].includes(el.getAttribute("role"));
  if (!checkable && !ariaCheckable) return refuse(A.type + " needs a checkbox, radio, or switch.");
  if (checkable && !desired && el.type === "radio") return refuse("A radio button is cleared by checking another option.");
  const current = checkable ? el.checked : el.getAttribute("aria-checked") === "true";
  if (current === desired) return JSON.stringify({ kind: "unchanged", element: describe(el), page: page() });
  perform = () => el.click();
} else if (A.type === "press") {
  perform = () => {
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const init = { key: A.key, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  };
} else if (A.type === "submit") {
  const form = el instanceof HTMLFormElement ? el : el.form || el.closest("form");
  if (!form) return refuse("The element is not a form and is not inside one.");
  const submitter = (el instanceof HTMLButtonElement || isInput) && el.type === "submit" && el.form === form ? el : null;
  perform = () => (submitter ? form.requestSubmit(submitter) : form.requestSubmit());
} else if (A.type === "focus") {
  perform = () => el.focus();
} else {
  perform = () => el.scrollIntoView({ block: "center", inline: "nearest" });
}
for (const [key, value] of S.actions) if (value.state !== "scheduled" && S.actions.size > 32) S.actions.delete(key);
const entry = { state: "scheduled", error: null, at: null };
S.actions.set(A.id, entry);
const mark = performance.timeOrigin + performance.now();
const channel = new MessageChannel();
channel.port1.onmessage = () => {
  channel.port1.close();
  const change = changed();
  if (change) { entry.state = "not-dispatched"; entry.error = { name: "StaleReference", ...change }; entry.at = performance.timeOrigin + performance.now(); return; }
  entry.state = "running";
  try { perform(); entry.state = "dispatched"; }
  catch (e) { entry.state = "failed"; entry.error = { name: e && e.name ? String(e.name) : null, message: clip(e && e.message ? e.message : e, 500) }; }
  entry.at = performance.timeOrigin + performance.now();
};
channel.port2.postMessage(0);
return JSON.stringify({ kind: "scheduled", element: describe(el), mark, page: page() });`,
	);
}

/**
 * Reads the outcome of a scheduled action, a postcondition, and resource responses
 * observed since `since` (epoch milliseconds). Applies no origin precondition, so
 * it also reports the page that replaced the original document.
 */
export function pollScript(actionId: string | null, condition: Condition | null, since: number | null): string {
	return script(
		null,
		`const P = ${literal({ actionId, condition, since })};
const entry = P.actionId === null ? null : S.actions.get(P.actionId) || null;
let condition = null;
if (P.condition) {
  const c = P.condition;
  const checks = [];
  const visibleMatch = (selector) => { const found = select(selector); if (found.error) return { error: found.error }; return { count: found.nodes.length, visible: found.nodes.some(isVisible) }; };
  if (c.selector != null) { const m = visibleMatch(c.selector); checks.push({ check: "selector", met: !m.error && m.visible, observed: m }); }
  if (c.gone != null) { const m = visibleMatch(c.gone); checks.push({ check: "gone", met: !m.error && !m.visible, observed: m }); }
  if (c.text != null) {
    const scope = c.selector != null ? (select(c.selector).nodes || [])[0] : document.body;
    const text = scope ? String(scope.innerText || "") : "";
    checks.push({ check: "text", met: text.includes(c.text), observed: { length: text.length, start: clip(squash(text), 300) } });
  }
  if (c.urlIncludes != null) checks.push({ check: "urlIncludes", met: location.href.includes(c.urlIncludes), observed: { url: clip(location.href, 300) } });
  condition = { met: checks.length > 0 && checks.every((x) => x.met), checks };
}
let responses = [];
let navigation = null;
if (P.since !== null) {
  responses = performance.getEntriesByType("resource").filter((e) => performance.timeOrigin + e.startTime >= P.since - 2).slice(-20)
    .map((e) => ({ url: clip(e.name, 300), initiator: e.initiatorType, status: typeof e.responseStatus === "number" ? e.responseStatus : null, durationMs: Math.round(e.duration) }));
  const nav = performance.getEntriesByType("navigation")[0];
  if (nav && performance.timeOrigin >= P.since - 2) navigation = { url: clip(nav.name, 300), type: nav.type, status: typeof nav.responseStatus === "number" ? nav.responseStatus : null };
}
return JSON.stringify({ kind: "ok", page: page(), action: entry ? { state: entry.state, error: entry.error } : null, condition, responses, navigation });`,
	);
}

const ENCODER = `
const clipText = (value, limit) => { const s = String(value); return s.length > limit ? s.slice(0, limit) : s; };
const encodeValue = (value, maxBytes) => {
  const type = typeof value;
  if (value === undefined) return { valueType: "undefined" };
  if (value === null) return { valueType: "null", value: null };
  if (type === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return { valueType: "number", value };
    return { valueType: "number", special: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (type === "bigint") {
    const text = String(value);
    const encoded = new TextEncoder().encode(text);
    const base = { valueType: "bigint", bytes: encoded.length };
    if (encoded.length > maxBytes) {
      const preview = new TextDecoder().decode(encoded.slice(0, maxBytes)).replace(/\uFFFD$/, "");
      return { ...base, tooLarge: true, preview };
    }
    return { ...base, special: text };
  }
  if (type === "symbol" || type === "function") return { valueType: type, unserializable: { path: "$", reason: type + " values have no JSON form." } };
  let problem = null;
  let undefinedDropped = 0;
  const stack = new Set();
  const walk = (item, path, depth) => {
    if (problem) return null;
    const t = typeof item;
    if (item === null || t === "string" || t === "boolean") return item;
    if (t === "number") { if (Number.isFinite(item)) return item; problem = { path, reason: "Non-finite number " + String(item) + "." }; return null; }
    if (t === "undefined") { undefinedDropped += 1; return undefined; }
    if (t !== "object") { problem = { path, reason: t + " values have no JSON form." }; return null; }
    if (stack.has(item)) { problem = { path, reason: "Circular reference." }; return null; }
    if (depth > 64) { problem = { path, reason: "Nesting deeper than 64 levels." }; return null; }
    stack.add(item);
    try {
      if (Array.isArray(item)) return item.map((child, i) => { const v = walk(child, path + "[" + i + "]", depth + 1); return v === undefined ? null : v; });
      if (item instanceof Date) { if (Number.isNaN(item.getTime())) { problem = { path, reason: "Invalid Date." }; return null; } return item.toISOString(); }
      const proto = Object.getPrototypeOf(item);
      if (proto === Object.prototype || proto === null) {
        const out = Object.create(null); // Null prototype keeps an own __proto__ key as data.
        for (const key of Object.keys(item)) { const v = walk(item[key], path + "." + key, depth + 1); if (v !== undefined) out[key] = v; }
        return out;
      }
      if (typeof item.toJSON === "function") return walk(item.toJSON(), path, depth + 1);
      problem = { path, reason: Object.prototype.toString.call(item) + " is not JSON data; return plain values or properties instead." };
      return null;
    } finally {
      stack.delete(item);
    }
  };
  let copy;
  try { copy = walk(value, "$", 0); } catch (e) { problem = { path: "$", reason: "Reading the value threw: " + clipText(e && e.message ? e.message : e, 300) }; }
  if (problem) return { valueType: Array.isArray(value) ? "array" : type, unserializable: problem };
  const json = JSON.stringify(copy);
  const bytes = new TextEncoder().encode(json).length;
  const base = { valueType: Array.isArray(value) ? "array" : type, bytes };
  if (undefinedDropped) base.undefinedDropped = undefinedDropped;
  if (bytes > maxBytes) {
    const preview = new TextDecoder().decode(new TextEncoder().encode(json).slice(0, maxBytes)).replace(/\uFFFD$/, "");
    return { ...base, tooLarge: true, preview };
  }
  return { ...base, value: copy };
};
const encodeError = (error, maxBytes) => {
  if (error && typeof error === "object" && "message" in error) {
    return { name: error.name == null ? null : clipText(error.name, 200), message: clipText(error.message, 2000), stack: error.stack ? clipText(error.stack, 4000) : null };
  }
  return { name: null, message: null, thrown: encodeValue(error, Math.min(maxBytes, 4096)) };
};
`;

/**
 * Evaluation records kept in the page world. A record holds a pending run or its
 * settled outcome until the tool removes it with `evaluationForgetScript`, so a
 * start or poll reply lost in transport leaves the outcome readable by a poll. A
 * record is needed only within the one tool call that created it, whose wait
 * limit is at most two minutes, so a record older than `RUN_TTL_MS` is abandoned.
 * At most `RUN_LIMIT` records are kept; the oldest goes first. One settled record
 * holds at most `maxBytes` of encoded value (262144 at most) plus a bounded error.
 */
export const RUN_LIMIT = 8;
export const RUN_TTL_MS = 300_000;

/**
 * Starts an evaluation. The expression is spliced into the script after a syntax
 * check by the caller. A synchronous outcome is returned and also recorded, so a
 * lost start reply can be recovered by `evaluationPollScript`; a thenable is
 * awaited in the page and its settlement is recorded for the poll.
 */
export function evaluationStartScript(
	expectOrigin: string,
	runId: string,
	expression: string,
	maxBytes: number,
): string {
	return `(() => {
${prelude(expectOrigin)}
${ENCODER}
const __pbRun = ${literal(runId)};
const __pbMax = ${literal(maxBytes)};
const __pbNow = Date.now();
for (const [key, value] of S.runs) if (!(__pbNow - (value.settledAt ?? value.at ?? 0) <= ${RUN_TTL_MS})) S.runs.delete(key);
while (S.runs.size >= ${RUN_LIMIT}) S.runs.delete(S.runs.keys().next().value);
const __pbEntry = { state: "pending", at: __pbNow };
S.runs.set(__pbRun, __pbEntry);
const __pbSettle = (patch) => { if (S.runs.get(__pbRun) === __pbEntry) Object.assign(__pbEntry, patch, { settledAt: Date.now() }); };
const __pbDone = (outcome) => { __pbSettle(outcome); return JSON.stringify({ kind: "settled", page: page(), outcome }); };
let __pbValue;
try {
  __pbValue = (
${expression}
);
} catch (error) {
  return __pbDone({ state: "threw", error: encodeError(error, __pbMax) });
}
let __pbThen = null;
try { __pbThen = __pbValue !== null && (typeof __pbValue === "object" || typeof __pbValue === "function") ? __pbValue.then : null; }
catch (error) { return __pbDone({ state: "threw", error: encodeError(error, __pbMax) }); }
if (typeof __pbThen === "function") {
  Promise.resolve(__pbValue).then(
    (value) => __pbSettle({ state: "fulfilled", awaited: true, ...encodeValue(value, __pbMax) }),
    (error) => __pbSettle({ state: "rejected", error: encodeError(error, __pbMax) }),
  );
  return JSON.stringify({ kind: "pending", page: page() });
}
return __pbDone({ state: "fulfilled", awaited: false, ...encodeValue(__pbValue, __pbMax) });
})()`;
}

export function evaluationPollScript(runId: string): string {
	return script(
		null,
		`const id = ${literal(runId)};
const entry = S.runs.get(id);
if (!entry) return JSON.stringify({ kind: "missing", page: page() });
if (entry.state === "pending") return JSON.stringify({ kind: "pending", page: page() });
const { at, settledAt, ...outcome } = entry;
return JSON.stringify({ kind: "settled", page: page(), outcome });`,
		false,
	);
}

/** Acknowledges or abandons a run: removes its record, so a late settlement stores nothing. */
export function evaluationForgetScript(runId: string): string {
	return script(null, `S.runs.delete(${literal(runId)});\nreturn JSON.stringify({ kind: "ok", page: page() });`, false);
}
