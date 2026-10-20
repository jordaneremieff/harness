import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {TONES} from './highlight.ts';

// CONTRAST_CSS selects an isolated stylesheet; colocated style.css is the normal source.
const cssPath = process.env.CONTRAST_CSS
	? resolve(process.env.CONTRAST_CSS)
	: fileURLToPath(new URL("./style.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const syntaxTokens = TONES.map(tone=>tone.startsWith('md-') ? tone : `syntax-${tone}`);
const foregrounds = ["fg", "muted", "dim", "success", "error", "warning", "link", "accent", "info", ...syntaxTokens];
// Every painted surface, including tool-status tints and diff rows, carries any foreground.
const surfaces = ["canvas", "side", "raised", "code", "run-bg", "ok-bg", "err-bg", "add-bg", "del-bg"];
// An inverted fill carries the canvas color as its text. The list stays explicit so a new one needs a deliberate model.
// The action that will act is filled with the primary ink, and its hover with the secondary ink.
const inverseFills: string[] = ['fg', 'muted'];
// The edge token marks controls, status rules and neutral selections; the accent marks focus.
const graphics = ["edge", "accent"];
const required = [...foregrounds, ...surfaces, ...graphics, "rule"];
// Rule hairlines decorate content already identified by text or position.
// Any new use of the low-contrast rule needs a deliberate classification.
const decorativeHairlines = new Set([
  ".project-bar|border-bottom", ".connection-banner|border-bottom", ".pane-heading|border-bottom",
  ".workbench-status|border-top", ".workbench-status .composer-detail-body|border",
  ".transcript-group-header|border-top", ".message-source|border",
  ".communication-source-section + .communication-source-section|border-top",
  ".context-menu-separator|border-top",
  ".nav-top|border-bottom", ".nav-filter|border", ".composer-input|border",
  ".context-menu|border", "dialog[data-variant=find] #modal-body > input|border",
	".source-header|border-bottom",
	".sidebar|border-right",
	".sidebar-footer|border-top",
	".tab-bar|border-bottom",
	".conversation-tab|border-right",
	".statusbar|border-top",
	".extension-status-list|border",
	".agent-message-panel|border-top",
	".markdown-content th, .markdown-content td|border-bottom",
	".markdown-content:is(hr)|border-top",
	".code-block > .copy|border",
	".thinking > .stream-text|border-left",
	".thinking-content|border-left",
	".markdown-content:is(blockquote)|border-left",
	".tool-shell|border",
  ".attachment-preview|border",
	".composer-detail-body|border-top",
	".tool-copy|border",
	".output-pages button|border",
	".receipt-details pre|border",
	".send:disabled|border-color",
	".send[data-kind=recovery]|border-color",
	".composer-state|border-left",
	".command-menu|border",
	"dialog|border",
  "dialog[open][data-variant=find]|border-top",
	".notification|border-bottom",
	".palette-input-row|border-bottom",
]);
// A tinted edge names its exact mix. The control it frames is identified by its text and icon, so the tint is decoration.
const decorativeTintedEdges = new Set([".stop|border-color|color-mix(in srgb, var(--error) 55%, transparent)"]);
// Non-content paint: the backdrop dims the page; the resting divider separates positioned panes.
const decorativeBackgrounds = new Set(["dialog::backdrop|var(--backdrop)", ".pane-split > .pane-divider::after|var(--rule)"]);
// Graphic paint carries no text; meaningful hover/focus and selected marks still meet 3:1.
const graphicForegrounds = new Map([
  ['.tab-dot', 'muted'],
  ...['info','success','warning','error','secondary'].map((tone):[string,string]=>[`:is(.tab-dot, .conversation-state, .row-state)[data-tone=${tone}]`, tone==='secondary'?'muted':tone]),
]);
const graphicBackgrounds = new Map([
  [".pane-split > .pane-divider:hover::after", "edge"],
  [".pane-split > .pane-divider:focus-visible::after", "accent"],
  [".composer-state[data-tone=warning]::before", "warning"],
  [".composer-state[data-tone=error]::before", "error"],

]);
const graphicShadows = new Map([
  ['.conversation-tab[aria-selected=true]', 'edge'],
  ['.pane-leaf[data-focused=true] > .tab-bar .conversation-tab[aria-selected=true]', 'accent'],
]);
type RGB = [number, number, number];
type Rule = { selector: string; contexts: string[]; declarations: { property: string; value: string }[] };
type Measurement = {
	theme: string;
	kind: string;
	source: string;
	foreground: string;
	background: string;
	ratio: number;
	threshold: number;
};
type Audit = {
	measurements: Measurement[];
	issues: string[];
	exclusions: string[];
	rules: number;
	declarations: number;
	themes: Record<string, Record<string, string>>;
};

// Strings and parenthesized values hide CSS delimiters from the rule parser.
function stringEnd(input: string, start: number): number {
	const quote = input[start];
	for (let i = start + 1; i < input.length; i++) {
		if (input[i] === "\\") {
			i++;
			continue;
		}
		if (input[i] === quote) return i;
	}
	assert.fail("Unclosed CSS string");
}
function* syntax(input: string): Generator<{ index: number; char: string }> {
	let depth = 0;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === '"' || char === "'") {
			index = stringEnd(input, index);
			continue;
		}
		if (char === "(" || char === "[") depth++;
		else if (char === ")" || char === "]") depth--;
		else if (depth === 0) yield { index, char };
		assert.ok(depth >= 0, "Unbalanced CSS value");
	}
	assert.equal(depth, 0, "Unbalanced CSS value");
}
function split(input: string, delimiter: string): string[] {
	let start = 0;
	const parts: string[] = [];
	for (const { index, char } of syntax(input)) {
		if (char !== delimiter) continue;
		parts.push(input.slice(start, index).trim());
		start = index + 1;
	}
	parts.push(input.slice(start).trim());
	return parts.filter(Boolean);
}
function blockEnd(input: string, start: number): number {
	let depth = 1;
	for (const { index, char } of syntax(input.slice(start + 1))) {
		if (char === "{") depth++;
		if (char === "}") depth--;
		if (depth === 0) return start + index + 2;
	}
	assert.fail("Unclosed CSS rule");
}
function declarations(input: string): Rule["declarations"] {
	return split(input, ";").map((declaration) => {
		const colon = declaration.indexOf(":");
		assert.ok(colon > 0, `Invalid declaration: ${declaration}`);
		return { property: declaration.slice(0, colon).trim().toLowerCase(), value: declaration.slice(colon + 1).trim() };
	});
}
function parse(input: string): Rule[] {
	const rules: Rule[] = [];
	function walk(body: string, contexts: string[]) {
		let start = 0;
		for (const { index, char } of syntax(body)) {
			if (index < start || char !== "{") continue;
			const selector = body.slice(start, index).trim();
			assert.ok(selector && !selector.includes(";"), `Unsupported CSS statement: ${selector}`);
			const end = blockEnd(body, index);
			const inner = body.slice(index + 1, end - 1);
			if (selector.startsWith("@")) {
				assert.match(selector, /^(?:@(?:media|container)\b|@keyframes work-pulse$)/, `Unsupported at-rule: ${selector}`);
				walk(inner, [...contexts, selector]);
			} else rules.push({ selector, contexts, declarations: declarations(inner) });
			start = end;
		}
		assert.equal(body.slice(start).trim(), "", "Unparsed CSS content");
	}
	walk(input.replace(/\/\*[\s\S]*?\*\//g, ""), []);
	return rules;
}
function rgb(value: string): RGB {
	assert.match(value, /^#(?:[\da-f]{3}|[\da-f]{6})$/i, `Expected an opaque hex color, got ${value}`);
	let hex = value.slice(1);
	if (hex.length === 3) hex = [...hex].map((c) => c + c).join("");
	return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as RGB;
}
function luminance(color: RGB): number {
	const linear = color.map((channel) => {
		const s = channel / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function ratio(a: string, b: string): number {
	const values = [luminance(rgb(a)), luminance(rgb(b))].sort((x, y) => x - y);
	return (values[1] + 0.05) / (values[0] + 0.05);
}
function token(value: string): string | undefined {
	return /^var\(--([\w-]+)\)$/.exec(value)?.[1];
}
type Palette = Record<string, string>;
type Measure = (kind: string, source: string, foreground: string, background: string, threshold: number) => void;
type Context = {
	theme: string;
	palette: Palette;
	source: string;
	rule: Rule;
	decl: Palette;
	issues: string[];
	exclusions: string[];
	measure: Measure;
};
const textProperties = new Set([
	"color",
	"-webkit-text-fill-color",
	"-webkit-text-stroke-color",
	"-webkit-text-stroke",
	"text-decoration-color",
	"text-emphasis-color",
	"text-emphasis",
	"fill",
	"stroke",
]);
const contrastEffects = new Set([
	"background-image",
	"border-image",
	"filter",
	"backdrop-filter",
	"mix-blend-mode",
	"text-shadow",
]);
const edgePattern =
	/^(?:border(?:-(?:top|right|bottom|left|inline|block)(?:-(?:start|end))?)?(?:-color)?|outline(?:-color)?)$/;
// Token rules carry zero specificity so a later user stylesheet wins by order alone.
const zeroSpecificity = (selector: string) => {
	if (!selector.startsWith(":where(")) return false;
	let depth = 0;
	for (let i = 0; i < selector.length; i++) {
		if (selector[i] === "(") depth++;
		else if (selector[i] === ")" && --depth === 0) return i === selector.length - 1;
	}
	return false;
};
function themeValues(rules: Rule[]): Record<string, Palette> {
	const base = rules.filter((r) => r.selector === ":where(:root)" && r.contexts.length === 0);
	const light = rules.filter(
		(r) => /^:where\(:root\[data-appearance=(?:light|"light"|'light')\]\)$/.test(r.selector) && r.contexts.length === 0,
	);
	const system = rules.filter((r) => /^:where\(:root\[data-appearance=(?:system|"system"|'system')\]\)$/.test(r.selector));
	assert.ok(base.length > 0, "Missing default dark theme");
	assert.ok(light.length > 0, "Missing explicit light theme");
	assert.ok(system.length > 0, "Missing system theme under light preference");
	for (const rule of system)
		assert.deepEqual(
			rule.contexts,
			["@media (prefers-color-scheme: light)"],
			"System override must use the light preference",
		);
	const knownRoots = new Set([...base, ...light, ...system]);
	for (const rule of rules.filter((r) => r.selector.includes(":root") && r.declarations.some((d) => d.property === "--canvas")))
		assert.ok(knownRoots.has(rule), `Unmodeled theme selector: ${rule.selector}`);
	for (const rule of knownRoots) assert.ok(zeroSpecificity(rule.selector), `Theme selector has specificity: ${rule.selector}`);
	const values = (selected: Rule[]) =>
		Object.fromEntries(selected.flatMap((r) => r.declarations.map((d) => [d.property, d.value])));
	const darkValues = values(base);
	const lightOverrides = values(light);
	assert.deepEqual(
		values(system),
		lightOverrides,
		"System light override differs from explicit light, including extra/missing declarations",
	);
	assert.equal(darkValues["color-scheme"], "dark");
	assert.equal(lightOverrides["color-scheme"], "light");
	const order = rules.map((r) => r.selector);
	const lightAt = order.indexOf(light[0]?.selector ?? ""), systemAt = order.indexOf(system[0]?.selector ?? "");
	assert.ok(order.indexOf(":where(:root)") < lightAt && lightAt < systemAt, "Light and system blocks follow the dark base so order alone decides");
	return { dark: darkValues, light: { ...darkValues, ...lightOverrides } };
}
function matrix(palette: Palette, theme: string, measure: Measure) {
	for (const name of required) {
		assert.ok(palette[`--${name}`], `${theme} lacks --${name}`);
		rgb(palette[`--${name}`]);
	}
	for (const fg of foregrounds) for (const bg of surfaces) measure("text-matrix", `--${fg} / --${bg}`, fg, bg, 4.5);
	for (const fill of inverseFills) measure("inverse-text", `--canvas / --${fill}`, "canvas", fill, 4.5);
	for (const bg of surfaces) measure("border-matrix", `--edge / --${bg}`, "edge", bg, 3);
	for (const bg of surfaces) measure("focus-matrix", `--accent / --${bg}`, "accent", bg, 3);
}
// A quiet placeholder mixes one text token into the surface it sits on; the blend is measured against that surface.
const placeholderMix = /^color-mix\(in srgb, var\(--(muted)\) (\d+)%, var\(--(raised)\)\)$/;
function blend(foreground: string, background: string, weight: number): string {
	const mixed = rgb(foreground).map((channel, index) => Math.round(channel * weight + (rgb(background)[index] as number) * (1 - weight)));
	return `#${mixed.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}
// Text whose exact paint is modeled elsewhere: the quiet placeholder blend and the canvas text of an inverted fill.
function modeledText(context: Context, property: string, value: string): boolean {
	const { theme, source, exclusions, measure, decl, palette } = context;
	if (property !== "color") return false;
	const mix = placeholderMix.exec(value);
	if (mix && context.rule.selector === ".composer textarea::placeholder") {
		measure("placeholder", `${source} ${value} / --${mix[3]}`, blend(palette["--muted"] as string, palette["--raised"] as string, Number(mix[2]) / 100), mix[3] as string, 3);
		return true;
	}
	const filled = token(decl["background-color"] ?? decl.background ?? "");
	if (value !== "var(--canvas)" || !filled || !inverseFills.includes(filled)) return false;
	exclusions.push(`${theme}: inverted fill text ${source} ${property}: ${value}`);
	return true;
}
function textDeclaration(context: Context, property: string, value: string) {
	const { theme, source, exclusions, issues, measure, decl } = context;
	if (modeledText(context, property, value)) return;
	if (["inherit", "currentColor"].includes(value)) {
		exclusions.push(`${theme}: inherited foreground ${source} ${property}: ${value}`);
		return;
	}
  if (property === 'color' && value === 'transparent' && ['.composer textarea[data-decorated=true]', '.file-editor[data-decorated=true]'].includes(context.rule.selector) && !context.rule.contexts.length) {
    exclusions.push(`${theme}: exact syntax source replaces native glyph paint ${source}`); return;
  }
	const name = token(value);
	if (!name || !foregrounds.includes(name)) {
		issues.push(`${theme}: non-token text color ${source} ${property}: ${value}`);
		return;
	}
	for (const bg of surfaces)
		measure("text-declaration", `${source} ${property}: ${value} / --${bg}`, name, bg, 4.5);
  if (property === 'color' && graphicForegrounds.get(context.rule.selector) === name)
    for (const bg of surfaces) measure('graphic-paint', `${source} ${property}: ${value} / --${bg}`, name, bg, 3);
	const localBg = token(decl["background-color"] ?? decl.background ?? "");
	if (localBg) measure("local-pair", `${source} ${property} on --${localBg}`, name, localBg, 4.5);
}
function caretDeclaration(context: Context, value: string) {
  const {theme, source, issues, measure, decl} = context;
  const name = token(value);
  if (!name || !['accent', ...foregrounds].includes(name)) { issues.push(`${theme}: unmodeled caret color ${source}: ${value}`); return; }
  for (const bg of surfaces) measure('caret-declaration', `${source} caret-color: ${value} / --${bg}`, name, bg, 3);
  const localBg = token(decl['background-color'] ?? decl.background ?? '');
  if (localBg) measure('caret-local-pair', `${source} caret-color on --${localBg}`, name, localBg, 3);
}
function inverseBackground(context: Context, fill: string) {
	const { theme, source, decl, measure, issues } = context;
	const fg = token(decl.color ?? "");
	if (fg) measure("background-declaration", `${source} explicit --${fg} on --${fill}`, fg, fill, 4.5);
	else issues.push(`${theme}: ink fill lacks an explicit foreground: ${source}`);
}
function backgroundDeclaration(context: Context, value: string) {
	const { theme, source, exclusions, issues, rule, palette, measure } = context;
	if (["transparent", "none", "inherit"].includes(value)) {
		exclusions.push(`${theme}: inherited/transparent background ${source}`);
		return;
	}
	if (decorativeBackgrounds.has(`${rule.selector}|${value}`)) {
		exclusions.push(`${theme}: non-content paint ${source}: ${value}`);
		return;
	}
	const name = token(value);
	if (!name || !palette[`--${name}`]) {
		issues.push(`${theme}: unmodeled background ${source}: ${value}`);
		return;
	}
	const graphic = graphicBackgrounds.get(rule.selector);
	if (graphic === name) {
		for (const bg of surfaces) measure("graphic-paint", `${source} --${name} / --${bg}`, name, bg, 3);
		return;
	}
	if (inverseFills.includes(name)) inverseBackground(context, name);
	else if (!surfaces.includes(name)) issues.push(`${theme}: non-surface background ${source}: ${value}`);
	else for (const fg of foregrounds) measure("background-declaration", `${source} --${fg} / --${name}`, fg, name, 4.5);
}
function selectionShadow(context: Context, value: string) {
  const name = graphicShadows.get(context.rule.selector); if (!name) return;
  if (value !== `inset 0 -2px var(--${name})`) context.issues.push(`${context.theme}: unmodeled selection shadow ${context.source}: ${value}`);
  else for (const bg of surfaces) context.measure('graphic-paint', `${context.source} selected underline / --${bg}`, name, bg, 3);
}
function decorativeEdge(context: Context, property: string, edge: string, name: string | undefined): boolean {
	if (edge !== "transparent" && name !== "rule") return false;
	const { theme, rule, source, issues, exclusions } = context;
	if (name === "rule" && !decorativeHairlines.has(`${rule.selector}|${property}`))
		issues.push(`${theme}: unclassified low-contrast hairline ${source} ${property}`);
	exclusions.push(`${theme}: decorative edge ${source} ${property}: ${edge}`);
	return true;
}
function edgeDeclaration(context: Context, property: string, value: string): boolean {
	const { theme, source, exclusions, issues, rule, measure } = context;
	if (["0", "none", "transparent", "inherit"].includes(value)) {
		exclusions.push(`${theme}: absent/inherited edge ${source} ${property}`);
		return false;
	}
	if (decorativeTintedEdges.has(`${rule.selector}|${property}|${value}`)) {
		exclusions.push(`${theme}: tinted decorative edge ${source} ${property}: ${value}`);
		return false;
	}
	const edge = /(?:var\(--[\w-]+\)|currentColor|transparent)$/.exec(value)?.[0];
	if (!edge) {
		issues.push(`${theme}: unmodeled edge ${source} ${property}: ${value}`);
		return false;
	}
	const name = token(edge);
	if (decorativeEdge(context, property, edge, name)) return false;
	const isFocus = rule.selector.includes(":focus") || property.startsWith("outline");
	const names = edge === "currentColor" ? foregrounds : [name ?? edge];
	for (const fg of names)
		for (const bg of surfaces)
			measure(
				isFocus ? "focus-declaration" : "border-declaration",
				`${source} ${property}: ${value} / --${bg}`,
				fg,
				bg,
				3,
			);
	return isFocus;
}
function forcedDeclaration(context: Context, property: string, value: string) {
	const { source, theme, issues, exclusions } = context;
	if (!/^(?:[\d.]+px\s+(?:solid|dotted)\s+)?(?:ButtonText|CanvasText|Highlight|Canvas|ButtonFace)$/.test(value))
		issues.push(`Unexpected forced-colors declaration: ${source} ${property}: ${value}`);
	else exclusions.push(`${theme}: OS palette owns ${source} ${property}: ${value}`);
}
function auditDeclaration(context: Context, property: string, raw: string): boolean {
	const { rule, source, theme, issues } = context;
	const value = raw.replace(/\s*!important$/, "");
	if (property.startsWith("--")) {
		// Component-local lengths adjust layout; any other local value could change a modeled color.
		if (!/^:where\(:root(?:\[data-appearance=(?:light|system)\])?\)$/.test(rule.selector) && !/^-?[\d.]+(?:px|rem|em)$/.test(value))
			issues.push(`Component-local variable requires explicit analysis: ${source} ${property}`);
		return false;
	}
	const text = textProperties.has(property);
  const caret = property === 'caret-color';
	const background = ["background", "background-color"].includes(property);
	const edge = edgePattern.test(property);
	if (rule.contexts.includes("@media (forced-colors:active)") && (text || caret || background || edge)) {
		forcedDeclaration(context, property, value);
		return false;
	}
	if (text) textDeclaration(context, property, value);
  if (caret) caretDeclaration(context, value);
	if (background) backgroundDeclaration(context, value);
  if (property === 'box-shadow') selectionShadow(context, value);
	if (edge) return edgeDeclaration(context, property, value);
	if (contrastEffects.has(property))
		issues.push(`${theme}: contrast-altering property requires analysis: ${source} ${property}: ${value}`);
	if (property === "opacity" && !["0", "1"].includes(value))
		issues.push(`${theme}: partial opacity requires compositing analysis: ${source}: ${value}`);
	return false;
}
function audit(input: string): Audit {
	const rules = parse(input);
	const issues: string[] = [],
		exclusions: string[] = [],
		measurements: Measurement[] = [];
	const themes = themeValues(rules);
	for (const [theme, palette] of Object.entries(themes)) {
		const measure: Measure = (kind, source, fg, bg, threshold) => {
			const foreground = palette[`--${fg}`] ?? fg;
			const background = palette[`--${bg}`] ?? bg;
			measurements.push({
				theme,
				kind,
				source,
				foreground,
				background,
				ratio: ratio(foreground, background),
				threshold,
			});
		};
		matrix(palette, theme, measure);
		let focusFound = false;
		for (const rule of rules) {
			const source = [...rule.contexts, rule.selector].join(" > ");
			const decl = Object.fromEntries(rule.declarations.map((d) => [d.property, d.value]));
			const context: Context = { theme, palette, source, rule, decl, issues, exclusions, measure };
			for (const declaration of rule.declarations)
				if (auditDeclaration(context, declaration.property, declaration.value)) focusFound = true;
		}
		assert.ok(focusFound, `${theme}: missing actual focus color declaration`);
	}
	return {
		measurements,
		issues: [...new Set(issues)],
		exclusions: [...new Set(exclusions)],
		rules: rules.length,
		declarations: rules.reduce((sum, r) => sum + r.declarations.length, 0),
		themes,
	};
}
const result = audit(css);
const failures = result.measurements.filter((m) => m.ratio < m.threshold);
const minimum = (rows: Measurement[]) => Math.min(...rows.map((r) => r.ratio));

test("WCAG sRGB reference ratios", () => {
	assert.equal(ratio("#000000", "#ffffff"), 21);
	assert.equal(ratio("#123456", "#123456"), 1);
	assert.ok(Math.abs(ratio("#777777", "#ffffff") - 4.478089453577214) < 1e-12);
});
test("CSS parser preserves nested media, strings, and functions", () => {
	const parsed = parse('@media (max-width: 99px) { .x { content: "a;b:{c}"; color: var(--text); } }');
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].declarations.length, 2);
	assert.equal(parsed[0].contexts[0], "@media (max-width: 99px)");
	assert.equal(parse("@container t (min-width: 9rem) { .x { color: var(--text); } }")[0].contexts[0], "@container t (min-width: 9rem)");
	assert.throws(() => parse("@import 'external.css';"), /Unparsed/);
  const frames = parse('@keyframes work-pulse { to { transform: rotate(360deg); } }');
  assert.equal(frames[0]?.selector, 'to');
  assert.deepEqual(frames[0]?.contexts, ['@keyframes work-pulse']);
  assert.deepEqual(frames[0]?.declarations, [{property: 'transform', value: 'rotate(360deg)'}]);
});
test("every required matrix pair is measured in both themes", () => {
	assert.equal(
		result.measurements.filter((m) => m.kind === "text-matrix").length,
		foregrounds.length * surfaces.length * 2,
	);
	assert.equal(result.measurements.filter((m) => m.kind === "inverse-text").length, inverseFills.length * 2);
	assert.equal(result.measurements.filter((m) => m.kind === "border-matrix").length, surfaces.length * 2);
	assert.equal(result.measurements.filter((m) => m.kind === "focus-matrix").length, surfaces.length * 2);
});
test("normal text meets 4.5:1; meaningful borders and focus meet 3:1", (context) => {
	for (const theme of ["dark", "light"]) {
		const rows = result.measurements.filter((m) => m.theme === theme);
		context.diagnostic(
			`${theme}: text minimum ${minimum(rows.filter((m) => m.threshold === 4.5)).toFixed(6)}; border minimum ${minimum(rows.filter((m) => m.kind.startsWith("border"))).toFixed(6)}; focus minimum ${minimum(rows.filter((m) => m.kind.startsWith("focus"))).toFixed(6)}.`,
		);
	}
	assert.deepEqual(failures, [], failures.map((m) => `${m.theme} ${m.source}: ${m.ratio}`).join("\n"));
});
test("regular user prose retains normal-text contrast and the left rule retains graphical contrast in every theme", () => {
	const user = parse(css).find((rule) => rule.selector === ".message.user > .message-body");
	assert.ok(user);
	const declarations = Object.fromEntries(user.declarations.map(({ property, value }) => [property, value]));
	assert.equal(declarations["font-weight"], "400");
	assert.equal(declarations.background, "var(--side)");
	assert.equal(declarations.color, undefined, "User prose inherits the primary foreground");
	for (const [theme, palette] of Object.entries(result.themes)) {
    for (const bg of ['canvas', 'side']) {
      assert.ok(ratio(palette['--fg'], palette[`--${bg}`]) >= 4.5, `${theme}: regular prose on ${bg} requires normal-text AA`);
    }
		const borders = result.measurements.filter((row) => row.theme === theme && row.kind === "border-declaration" && row.source.startsWith(".message.user > .message-body::before "));
		assert.equal(borders.length, surfaces.length, `${theme}: left rule needs every modeled surface`);
		assert.ok(borders.every((row) => row.threshold === 3 && row.ratio >= 3));
	}
});
test('decorated editor transparency does not admit hidden text on other surfaces', () => {
  assert.ok(audit(`${css}\n.probe { color: transparent; }`).issues.some(issue => issue.includes('non-token text color')));
  assert.ok(audit(`${css}\n.composer textarea { color: transparent; }`).issues.some(issue => issue.includes('non-token text color')));
});
test('native insertion caret is measured as graphics without weakening text or ignoring unknown colors', context => {
  const rows = result.measurements.filter(row => row.kind === 'caret-declaration' && row.source.startsWith('.composer textarea '));
  assert.equal(rows.length, surfaces.length * 2);
  assert.ok(rows.every(row => row.threshold === 3 && row.ratio >= 3));
  for (const theme of ['dark', 'light']) {
    const palette = result.themes[theme]; const measured = ratio(palette['--accent'], palette['--canvas']);
    context.diagnostic(`${theme} native caret: ${palette['--accent']} on ${palette['--canvas']} = ${measured}:1`);
    assert.ok(measured >= 4.5);
  }
  for (const value of ['#fff', 'transparent', 'auto', 'var(--unexpected)', 'var(--rule)', 'var(--accent, #fff)']) assert.ok(audit(`${css}\n.probe { caret-color: ${value}; }`).issues.some(issue => issue.includes('unmodeled caret color')), value);
  const weakened = audit(css.replace('--accent: #a3bbf1', '--accent: #303446'));
  assert.ok(weakened.measurements.some(row => row.kind === 'caret-declaration' && row.ratio < row.threshold));
  const accentText = audit(`${css}\n.probe { color: var(--accent); }`); assert.deepEqual(accentText.issues, []); assert.ok(accentText.measurements.some(row=>row.source.startsWith('.probe ')&&row.kind==='text-declaration'&&row.threshold===4.5));
});
test('source highlights and rendered spans use identical complete foreground tokens',()=> {
  const rules=parse(css);
  for(const tone of TONES) {
    const span=rules.find(rule=>rule.selector===`.syn-${tone}`), mark=rules.find(rule=>rule.selector===`.composer-colors::highlight(composer-${tone})`);
    assert.ok(span&&mark,tone);assert.deepEqual(span.declarations,mark.declarations,tone);
    assert.equal(span.declarations.length,1);assert.equal(span.declarations[0]?.property,'color');assert.equal(span.declarations[0]?.value,`var(--${tone.startsWith('md-')?tone:`syntax-${tone}`})`);
  }
  for(const selector of ['.markdown-content:is(h1, h2, h3, h4, h5, h6)','.markdown-content .markdown-inline-code','.markdown-content:is(blockquote)','.markdown-content:is(table)'])assert.ok(rules.some(rule=>rule.selector===selector),selector);
  assert.throws(()=>audit(css.replace(/--syntax-property:\s*#[a-f0-9]{6};/i,'')),/lacks --syntax-property/);
});
test("all color declarations use modeled semantic tokens", () => assert.deepEqual(result.issues, []));
test("graphic paint measures selected marks and divider hover/focus without opening a surface exception", () => {
  const rows = result.measurements.filter(row => row.kind === "graphic-paint");
  assert.equal(rows.length, (graphicBackgrounds.size + graphicForegrounds.size + graphicShadows.size) * surfaces.length * 2);
  for (const selector of graphicForegrounds.keys()) {
    const marks = rows.filter(row => row.source.startsWith(`${selector} color:`));
    assert.equal(marks.length, surfaces.length * 2);
    assert.ok(marks.every(row => row.ratio >= row.threshold));
  }
  assert.ok(rows.every(row => row.threshold === 3 && row.ratio >= 3));
  const checks = result.measurements.filter(row => row.kind === "text-declaration" && row.source.startsWith(".context-menu-item > .choice-check "));
  assert.equal(checks.length, surfaces.length * 2);
  assert.ok(checks.every(row => row.threshold === 4.5 && row.ratio >= 4.5));
  assert.ok(audit(`${css}\n.probe { background: var(--dim); }`).issues.some(issue => issue.includes("non-surface background")));
  assert.ok(audit(`${css}\n.probe { background: var(--muted); }`).issues.some(issue => issue.includes("ink fill lacks an explicit foreground")), "an inverted fill needs its own canvas text");
  assert.ok(audit(`${css}\n.pane-split > .pane-divider:hover::after { background: var(--rule); }`).issues.some(issue => issue.includes("non-surface background")));
  const weakened = audit(css.replace("--edge: #8f97b5", "--edge: #303446"));
  assert.ok(weakened.measurements.some(row => row.kind === "graphic-paint" && row.ratio < row.threshold));
});
test("hardcoded and unknown text colors, extra pairs, and alpha effects are detected", () => {
	for (const declaration of [
		"color: #fff",
		"color: rgb(0 0 0)",
		"-webkit-text-fill-color: white",
		"color: var(--unexpected)",
		"color: var(--text, #fff)",
	]) {
		assert.ok(
			audit(`${css}\n.probe { ${declaration}; }`).issues.some((i) => i.includes("non-token text color")),
			declaration,
		);
	}
	assert.ok(
		audit(`${css}\n.probe { color: var(--dim); background: var(--raised); }`).measurements.some(
			(m) => m.source.includes(".probe") && m.kind === "local-pair",
		),
	);
	assert.ok(audit(`${css}\n:root { color: #f00; }`).issues.some((i) => i.includes("non-token text color")));
	assert.ok(audit(`${css}\n.probe { opacity: .5; }`).issues.some((i) => i.includes("partial opacity")));
	assert.ok(
		audit(`${css}\n.probe { background: linear-gradient(white, black); }`).issues.some((i) =>
			i.includes("unmodeled background"),
		),
	);
	assert.ok(
		audit(`${css}\ninput { border: 1px solid var(--rule); }`).issues.some((i) =>
			i.includes("unclassified low-contrast hairline"),
		),
	);
	assert.ok(
		audit(`${css}\n.probe { color: var(--rule); background: var(--canvas); }`).issues.some((i) =>
			i.includes("non-token text color"),
		),
	);
	assert.ok(audit(`${css}\n.probe { background: var(--fg); }`).issues.some((i) => i.includes("ink fill lacks an explicit foreground")));
	assert.ok(audit(`${css}\n.probe { background: var(--dim); color: var(--canvas); }`).issues.some((i) => i.includes("non-surface background")));
	assert.deepEqual(audit(`${css}\n.probe { background: var(--fg); color: var(--canvas); }`).issues, []);
	assert.ok(audit(`${css}\ndialog::backdrop { background: #000000cc; }`).issues.some((i) => i.includes("unmodeled background")));
	assert.ok(audit(`${css}\n.probe { background: var(--backdrop); }`).issues.some((i) => i.includes("non-surface background")), "the translucent backdrop token is not a content surface");
	assert.ok(audit(`${css}\n.transcript-region::before { background: linear-gradient(to bottom,var(--canvas),transparent); }`).issues.some((i) => i.includes("unmodeled background")), "transcript edges have no gradient exception");
	assert.ok(audit(`${css}\n.probe { --dim: #000000; }`).issues.some((i) => i.includes("Component-local variable")));
	assert.deepEqual(audit(`${css}\n.probe { --edge: 12px; }`).issues, []);
});
test("contrast thresholds use exact ratios, not rounded display values", () => {
	assert.ok(ratio("#777777", "#ffffff") < 4.5);
	assert.ok(ratio("#767676", "#ffffff") >= 4.5);
	assert.equal(ratio("#fff", "#ffffff"), 1);
	assert.throws(() => ratio("#ffffff80", "#ffffff"), /opaque hex/);
});
test("no rule that defines a theme token has nonzero specificity", () => {
	const defining = parse(css).filter((r) => r.declarations.some((d) => required.includes(d.property.replace(/^--/, ""))));
	assert.ok(defining.length >= 3);
	for (const rule of defining) assert.ok(zeroSpecificity(rule.selector), `Token rule has specificity: ${rule.selector}`);
	assert.equal(zeroSpecificity(":root"), false);
	assert.equal(zeroSpecificity(":root[data-appearance=light]"), false);
	assert.equal(zeroSpecificity(":where(:root) .x"), false);
	assert.equal(zeroSpecificity(":where(:root[data-appearance=light])"), true);
});
test("system light overrides match explicit light exactly", () => {
	assert.throws(
		() => audit(`${css}\n@media (prefers-color-scheme: light) { :where(:root[data-appearance=system]) { --dim: #000000; } }`),
		/System light override differs/,
	);
});
