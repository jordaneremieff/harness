// Library module for the draft prose meter. The command line entry is meter.mts (run it with --help).
import { readFileSync } from "node:fs";

export const GROUPS = [
	"lexical",
	"geometry",
	"epistemic",
	"laundering",
	"punctuation",
	"structure",
	"link",
	"spelling",
	"time",
	"commit",
] as const;
export type Group = (typeof GROUPS)[number];

export const COMPONENTS = ["lexical", "geometry", "epistemic", "laundering"] as const;
export type ScoredComponent = (typeof COMPONENTS)[number];
export type Component = ScoredComponent | "none";

export type Severity = "hard" | "scored";
export type Scope = "prose" | "literal" | "line";
export type Option = "spelling" | "times";

export const DETECTORS = [
	"bold-label",
	"see-also-top",
	"link-bare-url",
	"link-autolink",
	"link-url-anchor",
	"triad",
	"punch-fragment",
	"bold-density",
	"code-chip-soup",
	"heading-density",
	"dense-block",
	"commit-subject-length",
	"commit-subject-period",
	"commit-subject-generic",
	"commit-subject-narrated",
] as const;
export type DetectorName = (typeof DETECTORS)[number];

export interface RuleExamples {
	hit: string[];
	clean: string[];
}

/** A term with exemptions that guard only that term. */
export interface TermSpec {
	term: string;
	context?: string[];
	twin?: string[];
}

export interface JudgementItem {
	id: string;
	title: string;
	description: string;
	repair: string;
	handledBy: string;
}

export interface CatalogEntry {
	family: string;
	rules?: string[];
	judgement?: string;
}

export interface Rule {
	id: string;
	group: Group;
	severity: Severity;
	weight?: number;
	component?: Component;
	pattern?: string;
	flags?: string;
	terms?: Array<string | TermSpec>;
	detector?: DetectorName;
	params?: Record<string, number | string | boolean>;
	scope?: Scope;
	kinds?: string[];
	twin?: string[];
	context?: string[];
	twinFlags?: string;
	firstOnly?: boolean;
	option?: Option;
	strictSeverity?: Severity;
	message: string;
	repair: string;
	rationale: string;
	source: string;
	examples: RuleExamples;
	exampleKind?: string;
}

export type CalibrationStatus = "uncalibrated" | "calibrated-on-model-written-benchmark";

export interface Scoring {
	componentWeights: Record<ScoredComponent, number>;
	bands: { green: number; amber: number };
	defaultThreshold: number;
	minWords: number;
	lexicalDivisor: number;
	geometryDensityDivisor: number;
	geometryDensityShare: number;
	burstiness: { kneeCv: number; spanCv: number; minSentences: number };
	epistemic: { ratioDivisor: number; densityDivisor: number };
	launderingDivisor: number;
	cluster: { windowWords: number; isolatedShare: number; stepShare: number; maxNeighbours: number };
	calibration: { cohort: string | null; n: number; date: string | null; status: CalibrationStatus };
}

export interface RuleSet {
	version: number;
	scoring: Scoring;
	rules: Rule[];
	judgement: JudgementItem[];
	catalog: CatalogEntry[];
}

export interface CompiledRule {
	rule: Rule;
	regex?: RegExp;
	/** A match that overlaps the hit exempts it. */
	twins: RegExp[];
	/** A match anywhere near the hit exempts it. */
	contexts: RegExp[];
}

export class RulesError extends Error {}

const RULE_KEYS = new Set([
	"id",
	"group",
	"severity",
	"weight",
	"component",
	"pattern",
	"flags",
	"terms",
	"detector",
	"params",
	"scope",
	"kinds",
	"twin",
	"context",
	"twinFlags",
	"firstOnly",
	"option",
	"strictSeverity",
	"message",
	"repair",
	"rationale",
	"source",
	"examples",
	"exampleKind",
]);
const ID_PATTERN = /^[a-z]+\.[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS = new Set(["md", "html", "text", "ts", "js", "commit"]);
const FLAG_ALLOWED = /^[ius]*$/;

function fail(message: string): never {
	throw new RulesError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectString(value: unknown, where: string): string {
	if (typeof value !== "string" || value.trim() === "") fail(`${where} must be a non-empty string`);
	return value;
}

function expectNumber(value: unknown, where: string, min = 0): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < min) fail(`${where} must be a number >= ${min}`);
	return value;
}

function expectStringArray(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || value.length === 0) fail(`${where} must be a non-empty array of strings`);
	return value.map((entry, index) => expectString(entry, `${where}[${index}]`));
}

function exactKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
	for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${where} has unknown key "${key}"`);
	for (const key of allowed) if (!(key in value)) fail(`${where} is missing key "${key}"`);
}

function section(value: Record<string, unknown>, key: string, keys: string[]): Record<string, unknown> {
	const entry = value[key];
	if (!isRecord(entry)) return fail(`scoring.${key} must be an object`);
	exactKeys(entry, keys, `scoring.${key}`);
	return entry;
}

function parseComponentWeights(value: Record<string, unknown>): Record<ScoredComponent, number> {
	const weights = section(value, "componentWeights", [...COMPONENTS]);
	const parsed = {
		lexical: expectNumber(weights.lexical, "scoring.componentWeights.lexical"),
		geometry: expectNumber(weights.geometry, "scoring.componentWeights.geometry"),
		epistemic: expectNumber(weights.epistemic, "scoring.componentWeights.epistemic"),
		laundering: expectNumber(weights.laundering, "scoring.componentWeights.laundering"),
	};
	const total = Object.values(parsed).reduce((sum, entry) => sum + entry, 0);
	if (Math.abs(total - 1) > 1e-9) fail("scoring.componentWeights must sum to 1");
	return parsed;
}

function parseBands(value: Record<string, unknown>): Scoring["bands"] {
	const bands = section(value, "bands", ["green", "amber"]);
	const green = expectNumber(bands.green, "scoring.bands.green");
	const amber = expectNumber(bands.amber, "scoring.bands.amber");
	if (green >= amber) fail("scoring.bands.green must be below scoring.bands.amber");
	return { green, amber };
}

function parseCalibration(value: Record<string, unknown>): Scoring["calibration"] {
	const calibration = section(value, "calibration", ["cohort", "n", "date", "status"]);
	if (calibration.status !== "uncalibrated" && calibration.status !== "calibrated-on-model-written-benchmark")
		fail('scoring.calibration.status must be "uncalibrated" or "calibrated-on-model-written-benchmark"');
	for (const key of ["cohort", "date"] as const) {
		const entry = calibration[key];
		if (entry !== null && typeof entry !== "string") fail(`scoring.calibration.${key} must be a string or null`);
	}
	return {
		cohort: calibration.cohort as string | null,
		n: expectNumber(calibration.n, "scoring.calibration.n"),
		date: calibration.date as string | null,
		status: calibration.status,
	};
}

function parseScoring(value: unknown): Scoring {
	if (!isRecord(value)) return fail("scoring must be an object");
	exactKeys(
		value,
		[
			"componentWeights",
			"bands",
			"defaultThreshold",
			"minWords",
			"lexicalDivisor",
			"geometryDensityDivisor",
			"geometryDensityShare",
			"burstiness",
			"epistemic",
			"launderingDivisor",
			"cluster",
			"calibration",
		],
		"scoring",
	);
	const burstiness = section(value, "burstiness", ["kneeCv", "spanCv", "minSentences"]);
	const epistemic = section(value, "epistemic", ["ratioDivisor", "densityDivisor"]);
	const cluster = section(value, "cluster", ["windowWords", "isolatedShare", "stepShare", "maxNeighbours"]);
	return {
		componentWeights: parseComponentWeights(value),
		bands: parseBands(value),
		defaultThreshold: expectNumber(value.defaultThreshold, "scoring.defaultThreshold"),
		minWords: expectNumber(value.minWords, "scoring.minWords", 1),
		lexicalDivisor: expectNumber(value.lexicalDivisor, "scoring.lexicalDivisor", 0.001),
		geometryDensityDivisor: expectNumber(value.geometryDensityDivisor, "scoring.geometryDensityDivisor", 0.001),
		geometryDensityShare: expectNumber(value.geometryDensityShare, "scoring.geometryDensityShare"),
		burstiness: {
			kneeCv: expectNumber(burstiness.kneeCv, "scoring.burstiness.kneeCv"),
			spanCv: expectNumber(burstiness.spanCv, "scoring.burstiness.spanCv", 0.001),
			minSentences: expectNumber(burstiness.minSentences, "scoring.burstiness.minSentences", 2),
		},
		epistemic: {
			ratioDivisor: expectNumber(epistemic.ratioDivisor, "scoring.epistemic.ratioDivisor", 0.001),
			densityDivisor: expectNumber(epistemic.densityDivisor, "scoring.epistemic.densityDivisor", 0.001),
		},
		launderingDivisor: expectNumber(value.launderingDivisor, "scoring.launderingDivisor", 0.001),
		cluster: {
			windowWords: expectNumber(cluster.windowWords, "scoring.cluster.windowWords", 1),
			isolatedShare: expectNumber(cluster.isolatedShare, "scoring.cluster.isolatedShare"),
			stepShare: expectNumber(cluster.stepShare, "scoring.cluster.stepShare"),
			maxNeighbours: expectNumber(cluster.maxNeighbours, "scoring.cluster.maxNeighbours"),
		},
		calibration: parseCalibration(value),
	};
}

function checkRegexSource(source: string, flags: string, where: string): RegExp {
	let regex: RegExp;
	try {
		regex = new RegExp(source, flags);
	} catch (error) {
		return fail(`${where} is not a valid regular expression: ${(error as Error).message}`);
	}
	const probe = new RegExp(source, flags.replace("g", ""));
	const empty = probe.exec("");
	if (empty !== null) fail(`${where} matches the empty string`);
	return regex;
}

export function compileTerms(terms: string[]): string {
	const alternatives = terms.map((term) => {
		const wildcard = term.endsWith("*");
		const body = wildcard ? term.slice(0, -1) : term;
		const escaped = body
			.trim()
			.split(/\s+/)
			.map((word) => word.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
			.join("\\s+");
		return wildcard ? `${escaped}[\\p{L}]*` : escaped;
	});
	return `(?<![\\w./@#$-])(?:${alternatives.join("|")})(?![\\w@#$-]|[./]\\w)`;
}

export function plainTerms(rule: Rule): string[] {
	return (rule.terms ?? []).filter((entry): entry is string => typeof entry === "string");
}

export function specTerms(rule: Rule): TermSpec[] {
	return (rule.terms ?? []).filter((entry): entry is TermSpec => typeof entry !== "string");
}

export function termText(entry: string | TermSpec): string {
	return typeof entry === "string" ? entry : entry.term;
}

export function ruleSource(rule: Rule): string | undefined {
	if (rule.pattern !== undefined) return rule.pattern;
	if (rule.terms !== undefined) return compileTerms(rule.terms.map(termText));
	return undefined;
}

export function ruleFlags(rule: Rule): string {
	const given = rule.flags ?? "";
	const base = rule.terms !== undefined ? `${given}iu` : given;
	return `g${[...new Set(base.split(""))].join("")}`;
}

function parseBase(value: Record<string, unknown>, where: string): Rule {
	const id = expectString(value.id, `${where}.id`);
	if (!ID_PATTERN.test(id)) fail(`${where}.id "${id}" must look like group.kebab-name`);
	const here = `rule ${id}`;
	const group = value.group;
	if (typeof group !== "string" || !(GROUPS as readonly string[]).includes(group)) fail(`${here}: unknown group`);
	if (!id.startsWith(`${group}.`)) fail(`${here}: id must start with its group`);
	const severity = value.severity;
	if (severity !== "hard" && severity !== "scored") return fail(`${here}: severity must be "hard" or "scored"`);
	const examples = value.examples;
	if (!isRecord(examples)) return fail(`${here}.examples must be an object with hit and clean arrays`);
	exactKeys(examples, ["hit", "clean"], `${here}.examples`);
	return {
		id,
		group: group as Group,
		severity,
		message: expectString(value.message, `${here}.message`),
		repair: expectString(value.repair, `${here}.repair`),
		rationale: expectString(value.rationale, `${here}.rationale`),
		source: expectString(value.source, `${here}.source`),
		examples: {
			hit: expectStringArray(examples.hit, `${here}.examples.hit`),
			clean: expectStringArray(examples.clean, `${here}.examples.clean`),
		},
	};
}

function parseTermSpec(entry: unknown, where: string): string | TermSpec {
	if (typeof entry === "string") return expectString(entry, where);
	if (!isRecord(entry)) return fail(`${where} must be a string or an object`);
	for (const key of Object.keys(entry)) if (!["term", "context", "twin"].includes(key)) fail(`${where} has unknown key "${key}"`);
	const spec: TermSpec = { term: expectString(entry.term, `${where}.term`) };
	if ("context" in entry) spec.context = expectStringArray(entry.context, `${where}.context`);
	if ("twin" in entry) spec.twin = expectStringArray(entry.twin, `${where}.twin`);
	return spec;
}

function parseTerms(value: unknown, here: string): Array<string | TermSpec> {
	if (!Array.isArray(value) || value.length === 0) return fail(`${here}.terms must be a non-empty array`);
	return value.map((entry, index) => parseTermSpec(entry, `${here}.terms[${index}]`));
}

function parseParams(value: unknown, here: string): Record<string, number | string | boolean> {
	if (!isRecord(value)) return fail(`${here}.params must be an object`);
	const params: Record<string, number | string | boolean> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "number" && typeof entry !== "string" && typeof entry !== "boolean")
			fail(`${here}.params.${key} must be a number, string or boolean`);
		params[key] = entry;
	}
	return params;
}

function parseMatchSource(value: Record<string, unknown>, rule: Rule): void {
	const here = `rule ${rule.id}`;
	const sources = ["pattern", "terms", "detector"].filter((key) => key in value);
	if (sources.length !== 1) fail(`${here}: exactly one of pattern, terms, detector is required`);
	if ("pattern" in value) rule.pattern = expectString(value.pattern, `${here}.pattern`);
	if ("terms" in value) rule.terms = parseTerms(value.terms, here);
	if ("detector" in value) {
		const detector = value.detector;
		if (typeof detector !== "string" || !(DETECTORS as readonly string[]).includes(detector))
			fail(`${here}: unknown detector "${String(detector)}"`);
		rule.detector = detector as DetectorName;
	}
	if ("flags" in value) {
		rule.flags = expectString(value.flags, `${here}.flags`);
		if (!FLAG_ALLOWED.test(rule.flags)) fail(`${here}.flags may contain only i, u, s`);
		if (rule.pattern === undefined) fail(`${here}.flags applies to pattern rules only`);
	}
	if ("params" in value) rule.params = parseParams(value.params, here);
}

function parseGuards(value: Record<string, unknown>, rule: Rule): void {
	const here = `rule ${rule.id}`;
	if ("twin" in value) rule.twin = expectStringArray(value.twin, `${here}.twin`);
	if ("context" in value) rule.context = expectStringArray(value.context, `${here}.context`);
	if ("twinFlags" in value) {
		rule.twinFlags = expectString(value.twinFlags, `${here}.twinFlags`);
		if (!FLAG_ALLOWED.test(rule.twinFlags)) fail(`${here}.twinFlags may contain only i, u, s`);
	}
	if ("firstOnly" in value) {
		if (typeof value.firstOnly !== "boolean") fail(`${here}.firstOnly must be a boolean`);
		rule.firstOnly = value.firstOnly;
	}
}

function parseScopeAndKinds(value: Record<string, unknown>, rule: Rule): void {
	const here = `rule ${rule.id}`;
	if ("scope" in value) {
		if (value.scope !== "prose" && value.scope !== "literal" && value.scope !== "line")
			fail(`${here}.scope must be prose, literal or line`);
		rule.scope = value.scope;
	}
	if ("kinds" in value) {
		rule.kinds = expectStringArray(value.kinds, `${here}.kinds`);
		for (const kind of rule.kinds) if (!KINDS.has(kind)) fail(`${here}.kinds has unknown kind "${kind}"`);
	}
	if ("exampleKind" in value) {
		const kind = expectString(value.exampleKind, `${here}.exampleKind`);
		if (!KINDS.has(kind)) fail(`${here}.exampleKind is unknown`);
		rule.exampleKind = kind;
	}
}

function parseApplicability(value: Record<string, unknown>, rule: Rule): void {
	const here = `rule ${rule.id}`;
	parseScopeAndKinds(value, rule);
	if ("option" in value) {
		if (value.option !== "spelling" && value.option !== "times") fail(`${here}.option must be spelling or times`);
		rule.option = value.option;
	}
	if ("strictSeverity" in value) {
		if (value.strictSeverity !== "hard" && value.strictSeverity !== "scored")
			fail(`${here}.strictSeverity must be hard or scored`);
		rule.strictSeverity = value.strictSeverity;
		if (rule.strictSeverity === rule.severity) fail(`${here}.strictSeverity must differ from severity`);
	}
}

function parseWeighting(value: Record<string, unknown>, rule: Rule): void {
	const here = `rule ${rule.id}`;
	if (rule.severity === "hard") {
		if ("weight" in value || "component" in value) fail(`${here}: hard rules take no weight or component`);
		return;
	}
	const component = value.component;
	if (component !== "none" && !(COMPONENTS as readonly string[]).includes(component as string))
		fail(`${here}: scored rules need a known component`);
	rule.component = component as Component;
	if (rule.component === "none") {
		if ("weight" in value) fail(`${here}: advisory rules (component none) take no weight`);
		return;
	}
	rule.weight = expectNumber(value.weight, `${here}.weight`, 0.01);
}

function checkAll(sources: string[] | undefined, flags: string, where: string): void {
	for (const [index, source] of (sources ?? []).entries()) checkRegexSource(source, flags, `${where}[${index}]`);
}

function validateRegexes(rule: Rule): void {
	const here = `rule ${rule.id}`;
	if (rule.context !== undefined && (rule.terms?.length ?? 0) > 1)
		fail(`${here}: a terms rule with several terms cannot carry rule-level context; give each guarded term its own context`);
	const flags = `g${rule.twinFlags ?? "i"}`;
	for (const spec of specTerms(rule)) {
		checkAll(spec.context, flags, `${here} term "${spec.term}" context`);
		checkAll(spec.twin, flags, `${here} term "${spec.term}" twin`);
	}
	const source = ruleSource(rule);
	if (source !== undefined) checkRegexSource(source, ruleFlags(rule), `${here} pattern`);
	checkAll(rule.twin, flags, `${here}.twin`);
	checkAll(rule.context, flags, `${here}.context`);
}

function parseRule(value: unknown, index: number): Rule {
	const where = `rules[${index}]`;
	if (!isRecord(value)) return fail(`${where} must be an object`);
	for (const key of Object.keys(value)) if (!RULE_KEYS.has(key)) fail(`${where} has unknown key "${key}"`);
	const rule = parseBase(value, where);
	parseMatchSource(value, rule);
	parseGuards(value, rule);
	parseApplicability(value, rule);
	parseWeighting(value, rule);
	validateRegexes(rule);
	return rule;
}

function parseJudgementItem(entry: unknown, index: number): JudgementItem {
	const where = `judgement[${index}]`;
	if (!isRecord(entry)) return fail(`${where} must be an object`);
	exactKeys(entry, ["id", "title", "description", "repair", "handledBy"], where);
	return {
		id: expectString(entry.id, `${where}.id`),
		title: expectString(entry.title, `${where}.title`),
		description: expectString(entry.description, `${where}.description`),
		repair: expectString(entry.repair, `${where}.repair`),
		handledBy: expectString(entry.handledBy, `${where}.handledBy`),
	};
}

function parseJudgement(value: unknown): JudgementItem[] {
	if (!Array.isArray(value) || value.length === 0) return fail("judgement must be a non-empty array");
	const items = value.map((entry, index) => parseJudgementItem(entry, index));
	if (new Set(items.map((item) => item.id)).size !== items.length) fail("duplicate judgement id");
	return items;
}

function parseCatalogEntry(entry: unknown, index: number, ruleIds: Set<string>, judgementIds: Set<string>): CatalogEntry {
	const where = `catalog[${index}]`;
	if (!isRecord(entry)) return fail(`${where} must be an object`);
	for (const key of Object.keys(entry)) if (!["family", "rules", "judgement"].includes(key)) fail(`${where} has unknown key "${key}"`);
	if (("rules" in entry) === ("judgement" in entry)) fail(`${where} needs exactly one of rules and judgement`);
	const parsed: CatalogEntry = { family: expectString(entry.family, `${where}.family`) };
	if ("rules" in entry) {
		parsed.rules = expectStringArray(entry.rules, `${where}.rules`);
		for (const id of parsed.rules) if (!ruleIds.has(id)) fail(`${where} names unknown rule "${id}"`);
		return parsed;
	}
	parsed.judgement = expectString(entry.judgement, `${where}.judgement`);
	if (!judgementIds.has(parsed.judgement)) fail(`${where} names unknown judgement "${parsed.judgement}"`);
	return parsed;
}

function parseCatalog(value: unknown, ruleIds: Set<string>, judgementIds: Set<string>): CatalogEntry[] {
	if (!Array.isArray(value) || value.length === 0) return fail("catalog must be a non-empty array");
	const entries = value.map((entry, index) => parseCatalogEntry(entry, index, ruleIds, judgementIds));
	if (new Set(entries.map((entry) => entry.family)).size !== entries.length) fail("duplicate catalog family");
	return entries;
}

export function parseRules(json: unknown): RuleSet {
	if (!isRecord(json)) return fail("rule data must be an object");
	exactKeys(json, ["version", "scoring", "rules", "judgement", "catalog"], "rule data");
	if (json.version !== 1) fail("rule data version must be 1");
	if (!Array.isArray(json.rules) || json.rules.length === 0) fail("rules must be a non-empty array");
	const rules = json.rules.map((entry, index) => parseRule(entry, index));
	const seen = new Set<string>();
	for (const rule of rules) {
		if (seen.has(rule.id)) fail(`duplicate rule id "${rule.id}"`);
		seen.add(rule.id);
	}
	const judgement = parseJudgement(json.judgement);
	const catalog = parseCatalog(json.catalog, seen, new Set(judgement.map((item) => item.id)));
	return { version: 1, scoring: parseScoring(json.scoring), rules, judgement, catalog };
}

export function defaultRulesUrl(): URL {
	return new URL("../data/rules.json", import.meta.url);
}

export function loadRules(path?: string): RuleSet {
	const source = path ?? defaultRulesUrl();
	let text: string;
	try {
		text = readFileSync(source, "utf8");
	} catch (error) {
		return fail(`cannot read rule data: ${(error as Error).message}`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error) {
		return fail(`rule data is not valid JSON: ${(error as Error).message}`);
	}
	return parseRules(json);
}

function compileAlternative(rule: Rule, source: string, twin: string[], context: string[]): CompiledRule {
	const flags = `g${rule.twinFlags ?? "i"}`;
	return {
		rule,
		regex: new RegExp(source, ruleFlags(rule)),
		twins: twin.map((entry) => new RegExp(entry, flags)),
		contexts: context.map((entry) => new RegExp(entry, flags)),
	};
}

function compilePlain(rule: Rule): CompiledRule {
	const flags = `g${rule.twinFlags ?? "i"}`;
	const compiled: CompiledRule = {
		rule,
		twins: (rule.twin ?? []).map((entry) => new RegExp(entry, flags)),
		contexts: (rule.context ?? []).map((entry) => new RegExp(entry, flags)),
	};
	const source = ruleSource(rule);
	if (source !== undefined) compiled.regex = new RegExp(source, ruleFlags(rule));
	return compiled;
}

function compileTermRule(rule: Rule): CompiledRule[] {
	const plain = plainTerms(rule);
	const out = plain.length > 0 ? [compileAlternative(rule, compileTerms(plain), rule.twin ?? [], rule.context ?? [])] : [];
	for (const spec of specTerms(rule)) {
		const twin = [...(rule.twin ?? []), ...(spec.twin ?? [])];
		out.push(compileAlternative(rule, compileTerms([spec.term]), twin, spec.context ?? []));
	}
	return out;
}

/** Compile each rule. Terms with their own exemptions become separate alternatives, so an exemption guards only its term. */
export function compileRules(set: RuleSet): CompiledRule[] {
	return set.rules.flatMap((rule) => (rule.terms === undefined ? [compilePlain(rule)] : compileTermRule(rule)));
}
