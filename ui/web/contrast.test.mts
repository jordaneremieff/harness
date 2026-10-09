import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// CONTRAST_CSS selects an isolated stylesheet; colocated style.css is the normal source.
const cssPath = process.env.CONTRAST_CSS
	? resolve(process.env.CONTRAST_CSS)
	: fileURLToPath(new URL("./style.css", import.meta.url));
const css = readFileSync(cssPath, "utf8");
const foregrounds = ["text", "secondary", "muted", "success", "warning", "danger", "info"];
const surfaces = ["canvas", "surface", "tint", "tint-strong", "code"];
// The one primary action per view inverts ink: canvas-colored text on an ink fill.
const inverseFills = ["text", "secondary"];
const required = [...foregrounds, ...surfaces, "faint"];
// Faint hairlines decorate content already identified by text, position, or a label.
// Any new use of the low-contrast hairline needs a deliberate classification.
const decorativeHairlines = new Set([
	".skip-link|border",
	".sidebar|border-right",
	".nav-filter|border-bottom",
	".sidebar-foot|border-top",
	".agent-message-panel|border-top",
	".message-body blockquote|border-left",
	".message-body th, .message-body td|border-bottom",
	".latest|border",
	".composer|border-top",
	".receipt-details pre|border",
	".command-menu|border",
	".command-hint|border-top",
	"dialog|border",
	"dialog[data-variant=menu] #modal-body > button|border-top",
	".options|border-top",
	".options > button|border-bottom",
	".notification|border-bottom",
	".picker-sessions|border-top",
	".picker-session|border-bottom",
]);
// Non-content paint: the dialog backdrop dims the page and the scroll fade masks clipped lines.
const decorativeBackgrounds = new Set([
	"dialog::backdrop|var(--backdrop)",
	".transcript-region::before|linear-gradient(var(--canvas) 6px, transparent)",
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
				assert.match(selector, /^@(?:media|container)\b/, `Unsupported at-rule: ${selector}`);
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
	"caret-color",
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
function themeValues(rules: Rule[]): Record<string, Palette> {
	const base = rules.filter((r) => r.selector === ":root" && r.contexts.length === 0);
	const light = rules.filter(
		(r) => /^:root\[data-appearance=(?:light|"light"|'light')\]$/.test(r.selector) && r.contexts.length === 0,
	);
	const system = rules.filter((r) => /^:root\[data-appearance=(?:system|"system"|'system')\]$/.test(r.selector));
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
	for (const rule of rules.filter((r) => r.selector.startsWith(":root")))
		assert.ok(knownRoots.has(rule), `Unmodeled theme selector: ${rule.selector}`);
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
	return { dark: darkValues, light: { ...darkValues, ...lightOverrides } };
}
function matrix(palette: Palette, theme: string, measure: Measure) {
	for (const name of required) {
		assert.ok(palette[`--${name}`], `${theme} lacks --${name}`);
		rgb(palette[`--${name}`]);
	}
	for (const fg of foregrounds) for (const bg of surfaces) measure("text-matrix", `--${fg} / --${bg}`, fg, bg, 4.5);
	for (const fill of inverseFills) measure("inverse-text", `--canvas / --${fill}`, "canvas", fill, 4.5);
	for (const bg of surfaces) measure("border-matrix", `--muted / --${bg}`, "muted", bg, 3);
	for (const bg of surfaces) measure("focus-matrix", `--text / --${bg}`, "text", bg, 3);
}
function textDeclaration(context: Context, property: string, value: string) {
	const { theme, source, exclusions, issues, measure, decl } = context;
	if (["inherit", "currentColor"].includes(value)) {
		exclusions.push(`${theme}: inherited foreground ${source} ${property}: ${value}`);
		return;
	}
	const name = token(value);
	if (!name || ![...foregrounds, "canvas"].includes(name)) {
		issues.push(`${theme}: non-token text color ${source} ${property}: ${value}`);
		return;
	}
	for (const bg of name === "canvas" ? inverseFills : surfaces)
		measure("text-declaration", `${source} ${property}: ${value} / --${bg}`, name, bg, 4.5);
	const localBg = token(decl["background-color"] ?? decl.background ?? "");
	if (localBg) measure("local-pair", `${source} ${property} on --${localBg}`, name, localBg, 4.5);
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
	if (inverseFills.includes(name)) inverseBackground(context, name);
	else for (const fg of foregrounds) measure("background-declaration", `${source} --${fg} / --${name}`, fg, name, 4.5);
}
function decorativeEdge(context: Context, property: string, edge: string, name: string | undefined): boolean {
	if (edge !== "transparent" && name !== "faint") return false;
	const { theme, rule, source, issues, exclusions } = context;
	if (name === "faint" && !decorativeHairlines.has(`${rule.selector}|${property}`))
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
		if (!rule.selector.startsWith(":root") && !/^-?[\d.]+(?:px|rem|em)$/.test(value))
			issues.push(`Component-local variable requires explicit analysis: ${source} ${property}`);
		return false;
	}
	const text = textProperties.has(property);
	const background = ["background", "background-color"].includes(property);
	const edge = edgePattern.test(property);
	if (rule.contexts.includes("@media (forced-colors:active)") && (text || background || edge)) {
		forcedDeclaration(context, property, value);
		return false;
	}
	if (text) textDeclaration(context, property, value);
	if (background) backgroundDeclaration(context, value);
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
test("all color declarations use modeled semantic tokens", () => assert.deepEqual(result.issues, []));
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
		audit(`${css}\n.probe { color: var(--text); background: var(--text); }`).measurements.some(
			(m) => m.source.includes(".probe") && m.ratio === 1,
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
		audit(`${css}\ninput { border: 1px solid var(--faint); }`).issues.some((i) =>
			i.includes("unclassified low-contrast hairline"),
		),
	);
	assert.ok(
		audit(`${css}\n.probe { color: var(--canvas); background: var(--tint); }`).measurements.some(
			(m) => m.source.includes(".probe") && m.ratio < m.threshold,
		),
	);
	assert.ok(audit(`${css}\n.probe { background: var(--text); }`).issues.some((i) => i.includes("ink fill lacks")));
	assert.ok(audit(`${css}\ndialog::backdrop { background: #000000cc; }`).issues.some((i) => i.includes("unmodeled background")));
	assert.throws(() => audit(`${css}\n.probe { background: var(--backdrop); }`), /opaque hex/, "the translucent backdrop token is not a content surface");
	assert.ok(audit(`${css}\n.probe { --muted: #000000; }`).issues.some((i) => i.includes("Component-local variable")));
	assert.deepEqual(audit(`${css}\n.probe { --edge: 12px; }`).issues, []);
});
test("contrast thresholds use exact ratios, not rounded display values", () => {
	assert.ok(ratio("#777777", "#ffffff") < 4.5);
	assert.ok(ratio("#767676", "#ffffff") >= 4.5);
	assert.equal(ratio("#fff", "#ffffff"), 1);
	assert.throws(() => ratio("#ffffff80", "#ffffff"), /opaque hex/);
});
test("system light overrides match explicit light exactly", () => {
	assert.throws(
		() => audit(`${css}\n@media (prefers-color-scheme: light) { :root[data-appearance=system] { --muted: #000000; } }`),
		/System light override differs/,
	);
});
