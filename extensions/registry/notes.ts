import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SettingsSnapshot } from "./configuration.ts";
import type { SettingRecord } from "./configuration-protocol.ts";

export interface NoteResource { kind: "extension" | "skill" | "prompt"; name: string; path: string; entryPath?: string; tool?: string }
export interface NoteKnowledge {
	cwd: string; home: string; agentDir: string;
	version: string; packageDir: string; docsPath: string; examplesPath: string;
	resources: readonly NoteResource[] | null;
	settings: SettingsSnapshot;
}
export interface NoteCall { name: string; input: Record<string, unknown> }
type Target = { key: string; kind: "document" | "setting" | "extension" | "pi-settings" | "root" | "host"; value: string };
interface Word { text: string; raw: string; redirect?: "input" | "output" }
interface Command { words: Word[]; inputs: Word[]; pipe: boolean }
const READERS = new Set(["cat", "head", "tail", "less", "more", "bat", "jq", "rg", "grep", "sed", "awk", "wc"]);
const ENUMERATORS = new Set(["ls", "fd", "find", "tree"]);
const SEARCH_OPTION_VALUES = new Set(["-A", "-B", "-C", "--after-context", "--before-context", "--context", "-M", "--max-columns", "--max-filesize", "-j", "--threads", "-r", "--replace", "--sort", "--sortr", "--color", "--colors", "--type-add", "--include", "--exclude"]);
const FD_OPTION_VALUES = new Set(["--max-results", "--changed-within", "--changed-before", "-S", "--size", "-j", "--threads", "--exact-depth", "--format"]);
const FD_EXEC_OPTIONS = new Set(["-x", "--exec", "-X", "--exec-batch"]);

function redirectArguments(words: Word[]): { words: Word[]; inputs: Word[] } {
	const args: Word[] = [], inputs: Word[] = [];
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i];
		if (!word.redirect) { args.push(word); continue; }
		const target = words[++i];
		if (!target || target.redirect) throw new Error("Missing redirection target");
		if (word.redirect === "input") inputs.push(target);
	}
	return { words: args, inputs };
}
const OPTION_VALUES = new Set(["-e", "--regexp", "-f", "--file", "-g", "--glob", "--iglob", "-t", "--type", "-T", "--type-not", "-n", "--lines", "-c", "--bytes", "-m", "--max-count", "--max-depth", "-d", "--maxdepth", "-L", "--level"]);

class ShellWords {
	commands: Command[] = [];
	private words: Word[] = [];
	private text = "";
	private raw = "";
	private quote = "";
	private escaped = false;
	private pipe = false;
	private word(): void {
		if (this.raw) this.words.push({ text: this.text, raw: this.raw });
		this.text = ""; this.raw = "";
	}
	private command(pipe: boolean): void {
		this.word();
		if (this.words.length) this.commands.push({ ...redirectArguments(this.words), pipe: this.pipe });
		this.words = []; this.pipe = pipe;
	}
	private quoted(char: string): void {
		this.raw += char;
		if (char === this.quote) this.quote = "";
		else this.text += char;
	}
	private separator(char: string, next: string): number {
		if (char === "&" && next !== "&") throw new Error("Background command");
		const double = next === char && (char === "|" || char === "&");
		this.command(char === "|" && !double);
		return Number(double);
	}
	private redirection(char: string, next: string): number {
		if (next === "(" || (char === "<" && next === "<")) throw new Error("Shell expression");
		if (/^\d+$/.test(this.raw)) { this.text = ""; this.raw = ""; }
		else this.word();
		this.words.push({ text: char, raw: char, redirect: char === "<" ? "input" : "output" });
		return Number(char === ">" && [">", "&"].includes(next));
	}
	private unquoted(char: string, next: string): number {
		if (char === "'" || char === '"') { this.raw += char; this.quote = char; return 0; }
		if (char === "&" && next === ">") { this.redirection(">", ""); return 1; }
		if (char === "<" || char === ">") return this.redirection(char, next);
		if (["\n", ";", "|", "&"].includes(char)) return this.separator(char, next);
		if (/\s/.test(char)) { this.word(); return 0; }
		if (char === "#" && !this.raw) return -1;
		if ("()".includes(char)) throw new Error("Shell expression");
		this.raw += char; this.text += char;
		return 0;
	}
	private character(char: string, next: string): number {
		if (this.escaped) { this.raw += char; this.text += char; this.escaped = false; return 0; }
		if (char === "\\" && this.quote !== "'") { this.raw += char; this.escaped = true; return 0; }
		if (this.quote) { this.quoted(char); return 0; }
		return this.unquoted(char, next);
	}
	parse(script: string): Command[] {
		for (let i = 0; i < script.length; i += 1) {
			const skip = this.character(script[i], script[i + 1]);
			if (skip < 0) { while (i < script.length && script[i] !== "\n") i += 1; this.command(false); }
			else i += skip;
			if (this.words.length > 512 || this.commands.length > 32) return [];
		}
		if (this.quote || this.escaped) return [];
		this.command(false);
		return this.commands;
	}
}
/** A deliberately small shell lexer. It executes nothing and refuses expansions it cannot resolve. */
export function simpleCommands(script: string): Command[] {
	if (script.length > 32768 || script.includes("<<") || /\$\(|`/.test(script)) return [];
	try { return new ShellWords().parse(script); } catch { return []; }
}
function pathOf(word: Word, knowledge: NoteKnowledge, cwd: string | null = knowledge.cwd): string | undefined {
	let value = word.text;
	if (!value || value.length > 4096 || /[*?`\n]/.test(value) || word.raw.includes("\\$") || (word.raw.includes("'") && /\$|^~/.test(value))) return;
	if (value.startsWith("~") && word.raw.startsWith('"')) return;
	value = value.replace(/^~(?=\/|$)/, knowledge.home).replace(/\$\{HOME\}|\$HOME(?=\/|$)/g, knowledge.home);
	if (value.includes("$") || value.startsWith("~")) return;
	if (cwd === null && !isAbsolute(value)) return;
	return resolve(cwd ?? knowledge.cwd, value);
}
function outside(path: string, cwd: string): boolean {
	const rel = relative(cwd, path);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}
function eligiblePath(path: string, knowledge: NoteKnowledge): boolean {
	if (resolve(knowledge.cwd) === resolve(knowledge.home)) return true;
	if (!outside(path, knowledge.agentDir) && outside(knowledge.cwd, knowledge.agentDir)) return true;
	return outside(path, knowledge.cwd);
}
function whole(text: string, token: string): boolean {
	let start = text.indexOf(token);
	while (start !== -1) {
		const before = text[start - 1] ?? "", after = text[start + token.length] ?? "";
		if ((!before || !/[\w.]/.test(before)) && (!after || !/[\w.]/.test(after))) return true;
		start = text.indexOf(token, start + token.length);
	}
	return false;
}
function complete(snapshot: SettingsSnapshot): boolean {
	return snapshot.available && snapshot.collection.status === "available" && snapshot.collection.malformed === 0 && snapshot.collection.omitted === 0 &&
		!snapshot.publications.some((pub) => pub.diagnostics.some((fact) => fact.code === "coverage"));
}
function optionTakesValue(word: string, next: string, search: boolean): boolean {
	if (!OPTION_VALUES.has(word)) return false;
	if (!["-n", "-c"].includes(word)) return true;
	return !search && /^[+-]?\d+$/.test(next);
}
function optionKind(text: string, options: boolean): "end" | "pattern" | "option" | "argument" {
	if (!options) return "argument";
	if (text === "--") return "end";
	if (text === "-e" || text === "--regexp") return "pattern";
	return text.startsWith("-") ? "option" : "argument";
}
function optionValueCount(program: string, word: string, next: string, search: boolean): number {
	if (program === "jq" && ["--arg", "--argjson", "--slurpfile", "--rawfile"].includes(word)) return 2;
	if (program === "awk" && ["-v", "--assign", "-F", "--field-separator"].includes(word)) return 1;
	if (program === "fd" && (word === "-E" || FD_OPTION_VALUES.has(word))) return 1;
	if (["rg", "grep"].includes(program) && SEARCH_OPTION_VALUES.has(word)) return 1;
	if (["--exclude", "--exclude-dir", "--label", "--from-file"].includes(word)) return 1;
	return Number(optionTakesValue(word, next, search));
}
function positionals(words: Word[], search: boolean, program = ""): { args: Word[]; pattern?: Word } {
	const args: Word[] = [];
	let pattern: Word | undefined, options = true;
	for (let i = 0; i < words.length; i += 1) {
		const word = words[i];
		if (program === "fd" && options && FD_EXEC_OPTIONS.has(word.text)) break;
		switch (optionKind(word.text, options)) {
			case "end": options = false; break;
			case "pattern": pattern = words[++i]; break;
			case "option": i += optionValueCount(program, word.text, words[i + 1]?.text ?? "", search); break;
			case "argument": args.push(word); break;
		}
	}
	if (search && !pattern) pattern = args.shift();
	return { args, ...(pattern ? { pattern } : {}) };
}
function roots(knowledge: NoteKnowledge): Map<string, NoteResource[]> | undefined {
	if (knowledge.resources === null) return;
	const result = new Map<string, NoteResource[]>();
	for (const kind of ["extensions", "skills", "prompts"]) result.set(resolve(knowledge.agentDir, kind), []);
	for (const resource of knowledge.resources) {
		if (!isAbsolute(resource.path)) continue;
		const root = dirname(resource.path);
		result.set(root, [...(result.get(root) ?? []), resource]);
		if (result.has(resource.path)) result.set(resource.path, [...(result.get(resource.path) ?? []), resource]);
	}
	return result;
}
function enumerationPaths(program: string, words: Word[]): Word[] {
	const args = positionals(words, false, program).args;
	if (program === "fd") return args.slice(1);
	if (program !== "find") return args;
	const expression = words.findIndex((word) => word.text.startsWith("-"));
	return words.slice(0, expression < 0 ? words.length : expression);
}
function echoedName(word: Word | undefined): string | undefined {
	const match = /^(?:\$([A-Z][A-Z0-9_]*)|\$\{([A-Z][A-Z0-9_]*)\}|"\$([A-Z][A-Z0-9_]*)"|"\$\{([A-Z][A-Z0-9_]*)\}")$/.exec(word?.raw ?? "");
	return match?.slice(1).find(Boolean);
}
class NoteDetector {
	private readonly knowledge: NoteKnowledge;
	private readonly publications: SettingsSnapshot["publications"];
	private readonly targets = new Map<string, Target>();
	private scriptCwd: string | null;
	constructor(knowledge: NoteKnowledge) {
		this.knowledge = knowledge;
		this.scriptCwd = knowledge.cwd;
		this.publications = complete(knowledge.settings) ? knowledge.settings.publications : [];
	}
	private add(kind: Target["kind"], value: string): void {
		const key = `${kind}:${value}`;
		this.targets.set(key, { key, kind, value });
	}
	private extensionPath(path: string): void {
		const resource = (this.knowledge.resources ?? [])
			.filter((resource) => resource.kind === "extension" && !outside(path, resource.path))
			.sort((a, b) => b.path.length - a.path.length)[0];
		if (resource) this.add("extension", resource.path);
	}
	private path(word: Word, enumeration = false, host = false, piSettings = false): void {
		const path = pathOf(word, this.knowledge, this.scriptCwd);
		if (!path || !eligiblePath(path, this.knowledge)) return;
		this.extensionPath(path);
		if (enumeration) {
			if (roots(this.knowledge)?.has(path)) this.add("root", path);
			return;
		}
		if (this.publications.some((pub) => pub.source.path === path)) this.add("document", path);
		if (piSettings && path === resolve(this.knowledge.agentDir, "settings.json")) this.add("pi-settings", path);
		if (host && [resolve(this.knowledge.agentDir, "install/current-version"), resolve(this.knowledge.packageDir, "package.json")].includes(path)) this.add("host", "pi");
	}
	private names(pattern: string, exactEnv = false): void {
		if (pattern.length > 32768) return;
		for (const row of this.publications.flatMap((pub) => pub.records)) {
			const matches = exactEnv ? row.env === pattern : whole(pattern, row.env) || whole(pattern, row.name);
			if (matches) this.add("setting", row.name);
		}
	}
	private search(pattern: string, args: Word[], pipedEnv = false): void {
		if (pipedEnv) { this.names(pattern); return; }
		if (!args.length) return;
		const paths = args.map((word) => pathOf(word, this.knowledge, this.scriptCwd));
		if (paths.some((path) => !path || !eligiblePath(path, this.knowledge))) return;
		this.names(pattern);
	}
	private reader(program: string, words: Word[], inputs: Word[], pipedEnv: boolean): void {
		if (!READERS.has(program)) return;
		const isSearch = program === "rg" || program === "grep";
		const parsed = positionals(words, isSearch || ["jq", "sed", "awk"].includes(program), program);
		const paths = [...parsed.args, ...inputs];
		if (isSearch && parsed.pattern) this.search(parsed.pattern.text, paths, pipedEnv);
		for (const word of paths) this.path(word, false, false, true);
	}
	private simpleProgram(program: string, words: Word[]): boolean {
		switch (program) {
			case "printenv": if (words.length === 1) this.names(words[0].text, true); return true;
			case "echo": { const name = words.length === 1 ? echoedName(words[0]) : undefined; if (name) this.names(name, true); return true; }
			case "pi": if (words.length === 1 && ["--version", "-v"].includes(words[0].text)) this.add("host", "pi"); return true;
			default: return false;
		}
	}
	private shellCommand(command: Command, pipedEnv: boolean): void {
		let [program, ...words] = command.words;
		if (!program || /['"\\/$]/.test(program.raw)) return;
		if (program.text === "git" && words[0]?.text === "grep") { program = words[0]; words = words.slice(1); }
		if (this.simpleProgram(program.text, words)) return;
		if (ENUMERATORS.has(program.text) || (program.text === "rg" && words.some((word) => word.text === "--files"))) {
			for (const word of enumerationPaths(program.text, words)) this.path(word, true);
			return;
		}
		this.reader(program.text, words, command.inputs, pipedEnv);
	}
	private changeDirectory(command: Command): void {
		if (this.scriptCwd === null) return;
		const args = command.words;
		if (args.length !== 2 || args[1].text.startsWith("-")) { this.scriptCwd = null; return; }
		this.scriptCwd = pathOf(args[1], this.knowledge, this.scriptCwd) ?? null;
	}
	private shell(script: string): void {
		const commands = simpleCommands(script);
		for (let i = 0; i < commands.length; i += 1) {
			if (commands[i].words[0]?.text === "cd") {
				if (!commands[i].pipe && !commands[i + 1]?.pipe) this.changeDirectory(commands[i]);
				continue;
			}
			const previous = commands[i - 1]?.words;
			const pipedEnv = commands[i].pipe && previous?.length === 1 && previous[0].text === "env";
			this.shellCommand(commands[i], pipedEnv);
		}
	}
	private grep(pattern: string, path: Word | undefined): void {
		this.search(pattern, path ? [path] : []);
		if (!path) return;
		const resolved = pathOf(path, this.knowledge);
		if (resolved && eligiblePath(resolved, this.knowledge)) this.extensionPath(resolved);
	}
	match(call: NoteCall): Target[] {
		const path = typeof call.input.path === "string" ? { text: call.input.path, raw: call.input.path } : undefined;
		switch (call.name) {
			case "read": if (path) this.path(path, false, true, true); break;
			case "ls": case "find": if (path) this.path(path, true); break;
			case "grep": if (typeof call.input.pattern === "string") this.grep(call.input.pattern, path); break;
			case "bash": if (typeof call.input.command === "string") this.shell(call.input.command); break;
		}
		return [...this.targets.values()];
	}
}
/** Match only exact registered paths or published names, never guessed sibling copies. */
export function noteTargets(call: NoteCall, knowledge: NoteKnowledge): Target[] { return new NoteDetector(knowledge).match(call); }
function clip(value: string, length: number): string { return [...value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")].slice(0, length).join(""); }
function rowText(row: SettingRecord, length = 80): string {
	const value = row.secret ? row.secretState ?? "unset" : row.value === undefined ? "unset" : JSON.stringify(row.value);
	return `${row.name} = ${clip(value, length)} (origin ${row.origin}, env ${row.env}${row.status === "invalid" ? ", validity invalid" : ""})`;
}
function bounded(header: string, facts: string[], call: string, limit = 8, summary = ""): string | undefined {
	let count = Math.min(limit, facts.length, summary || facts.length > 8 ? 7 : 8);
	while (count >= 0) {
		const omitted = facts.length - count;
		const footer = [summary, ...(omitted ? [`${omitted} other facts omitted.`] : [])].filter(Boolean).join(" ");
		const lines = [header, ...facts.slice(0, count), ...(footer ? [footer] : []), ...(call ? [call] : [])];
		const text = lines.join("\n");
		if (lines.length <= 10 && Buffer.byteLength(text) <= 1200) return text;
		count -= 1;
	}
}
function documentNote(header: string, publications: SettingsSnapshot["publications"]): string | undefined {
	const rows = publications.flatMap((pub) => pub.records);
	const overrides = rows.filter((row) => row.origin === "env").map((row) => rowText(row, 60));
	const invalid = rows.filter((row) => row.origin !== "env" && row.status === "invalid").map((row) => rowText(row));
	const diagnostics = publications.flatMap((pub) => pub.diagnostics.map((fact) => `${clip(fact.field, 256)}: ${fact.code} (${fact.source})`));
	const defaults = publications.flatMap((pub) => {
		const keys = pub.records.filter((row) => row.origin === "default").map((row) => row.key);
		return keys.length ? [`${pub.slice}: ${keys.join(", ")} (defaults apply)`] : [];
	});
	return fitDocument(header, overrides, [...invalid, ...diagnostics, ...defaults]);
}
function fitDocument(header: string, overrides: string[], others: string[]): string | undefined {
	const calls = 'registry {"kind":"setting"}; registry {"kind":"setting","name":"<slice>.<key>"}';
	const minimum = overrides.length ? 1 : 0;
	for (let envCount = Math.min(6, overrides.length); envCount >= minimum; envCount -= 1) {
		const hint = envCount ? ["file values for these keys do not apply while the env var is set"] : [];
		const prefix = [header, ...overrides.slice(0, envCount), ...hint];
		for (let count = Math.min(9 - prefix.length, others.length); count >= 0; count -= 1) {
			const omitted = overrides.length - envCount + others.length - count;
			const call = `${calls}${omitted ? ` (${omitted} other facts omitted.)` : ""}`;
			const text = [...prefix, ...others.slice(0, count), call].join("\n");
			if (Buffer.byteLength(text) <= 1200) return text;
		}
	}
}
function settingsBoundary(): string {
	return `Configured values from responding loaded publishers at ${new Date().toISOString()}; running processes may not have applied file edits.`;
}
function extensionNote(path: string, knowledge: NoteKnowledge): string | undefined {
	if (!complete(knowledge.settings) || knowledge.resources === null) return;
	const resources = knowledge.resources.filter((resource) => resource.kind === "extension" && resource.path === path);
	const resource = resources.find((resource) => resource.tool !== undefined) ?? resources[0];
	if (!resource?.entryPath) return;
	const publication = knowledge.settings.publications.find((pub) => pub.slice === basename(path));
	const rows = [...(publication?.records ?? [])].sort((a, b) => Number(b.origin === "env") - Number(a.origin === "env"));
	const facts = publication ? rows.map((row) => rowText(row)) : ["It publishes no harness settings."];
	const calls: string[] = [];
	if (publication) calls.push(`registry ${JSON.stringify({ kind: "setting", search: `${basename(path)}.` })}`);
	if (resource.tool) calls.push(`registry ${JSON.stringify({ kind: "tool", name: resource.tool, detail: true })}`);
	const hint = rows.some((row) => row.origin === "env") ? "file values do not apply while the env var is set" : "";
	const boundary = publication ? settingsBoundary() : "";
	return bounded(`[registry] ${clip(resource.name, 256)} is loaded in this session from ${clip(resource.entryPath, 4096)}.`,
		facts, calls.join("; "), 6, [boundary, hint].filter(Boolean).join(" "));
}
function piSettingsNote(knowledge: NoteKnowledge): string | undefined {
	if (knowledge.resources === null || !complete(knowledge.settings)) return;
	const extensions = new Set(knowledge.resources.filter((resource) => resource.kind === "extension").map((resource) => resource.entryPath ?? resource.path));
	const rows = knowledge.settings.publications.flatMap((pub) => pub.records).filter((row) => row.origin === "env");
	const facts = rows.length ? ["Harness settings set by environment (file values do not apply while set):", ...rows.map((row) => rowText(row))]
		: ["No harness setting is set by environment."];
	return bounded(`[registry] This session loaded ${extensions.size} extensions; Pi settings list configured sources, not load results.`, facts,
		'registry {"kind":"setting"}; registry {"kind":"setting","search":"<extension>."}', 7,
		`Extension count follows available host provenance. ${settingsBoundary()}`);
}
function compose(target: Target, knowledge: NoteKnowledge): string | undefined {
	if (target.kind === "extension") return extensionNote(target.value, knowledge);
	if (target.kind === "pi-settings") return piSettingsNote(knowledge);
	if (target.kind === "host") {
		const text = ["[registry] Running Pi facts from this process.", `version = ${knowledge.version}`,
			`package = ${clip(knowledge.packageDir, 4096)}`, `docs = ${clip(knowledge.docsPath, 4096)}`, `examples = ${clip(knowledge.examplesPath, 4096)}`, "registry {}"].join("\n");
		return Buffer.byteLength(text) <= 1200 ? text : undefined;
	}
	if (target.kind === "root") {
		const resources = roots(knowledge)?.get(target.value);
		if (!resources) return;
		const names = [...new Set(resources.map((resource) => `${resource.kind} ${clip(resource.name, 256)}`))].sort();
		const otherDirectories = new Set((knowledge.resources ?? []).filter((resource) => resource.kind === "extension" && dirname(resource.path) !== target.value && resource.path !== target.value).map((resource) => resource.path));
		return bounded("[registry] Loaded resources from host provenance; a directory listing also shows files this session did not load.", names,
			'registry {"kind":"tool"}; registry {"kind":"skill"}; registry {"kind":"prompt"}', 8,
			`${otherDirectories.size} other loaded extension directories; source and scope: registry {"kind":"tool","name":"<tool>"}`);
	}
	if (!complete(knowledge.settings)) return;
	const pubs = knowledge.settings.publications;
	const selected = pubs.filter((pub) => target.kind === "document" ? pub.source.path === target.value : pub.records.some((row) => row.name === target.value));
	if (!selected.length) return;
	const rows = selected.flatMap((pub) => pub.records).filter((row) => target.kind !== "setting" || row.name === target.value);
	const header = `[registry] Configured values published by loaded extensions at ${new Date().toISOString()}; running processes may not have applied file edits.`;
	if (target.kind === "document") return documentNote(header, selected);
	return bounded(header, rows.map((row) => rowText(row)), `registry ${JSON.stringify({ kind: "setting", name: target.value })}`, 6);
}

/** Session-local budget and nested-result transport. No result object enters this state. */
export class RegistryNotes {
	private seen = new Set<string>();
	private queued = new Map<string, string[]>();
	private count = 0;
	private readonly knowledge: () => NoteKnowledge;
	private readonly refresh: () => SettingsSnapshot;
	private readonly enabled: () => boolean;
	constructor(knowledge: () => NoteKnowledge, refresh: () => SettingsSnapshot, enabled: () => boolean) {
		this.knowledge = knowledge; this.refresh = refresh; this.enabled = enabled;
	}
	reset(): void { this.seen.clear(); this.queued.clear(); this.count = 0; }
	private fits(notes: string[], note: string): boolean { return notes.length < 2 && Buffer.byteLength([...notes, note].join("")) <= 1600; }
	private append(call: NoteCall, pending: string[]): void {
		if (this.count >= 6 || !["read", "bash", "grep", "ls", "find"].includes(call.name)) return;
		const knowledge = this.knowledge();
		const targets = noteTargets(call, knowledge).filter((target) => !this.seen.has(target.key));
		if (!targets.length || !this.enabled()) return;
		knowledge.settings = this.refresh();
		const freshTargets = new Set(noteTargets(call, knowledge).map((target) => target.key));
		for (const target of targets) {
			if (this.count >= 6) break;
			if (!freshTargets.has(target.key)) continue;
			const note = compose(target, knowledge);
			if (!note || !this.fits(pending, note)) continue;
			pending.push(note); this.seen.add(target.key); this.count += 1;
		}
	}
	private forward(parent: string, pending: string[]): void {
		const outer = this.queued.get(parent) ?? [];
		for (const note of pending) if (this.fits(outer, note)) outer.push(note);
		if (outer.length) this.queued.set(parent, outer);
	}
	result(call: NoteCall, id: string, parent?: string): string[] {
		try {
			const pending = this.queued.get(id) ?? [];
			this.queued.delete(id);
			this.append(call, pending);
			if (!parent) return pending;
			this.forward(parent, pending);
			return [];
		} catch { return []; }
	}
}
