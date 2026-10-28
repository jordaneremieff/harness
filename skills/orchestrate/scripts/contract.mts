#!/usr/bin/env node

import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const KINDS = ["task", "lead", "partner", "review", "frame", "handoff"] as const;
type ContractKind = (typeof KINDS)[number];

const MAX_CONTRACT_BYTES = 1024 * 1024;
const MAX_REPORTED_FINDINGS = 40;
const MAX_DIAGNOSTIC_LENGTH = 300;
const CHARS_PER_TOKEN = 4;

// Frame field limits from the agent_collaborate tool definition (create fields,
// maxLength): title 160, purpose 4000, authority 4000, source 2000,
// restrictions 4000, acceptance 4000, integrator 256. The same definition caps
// contribution at 256 and message at 8000; those apply to join and post.
// Lengths are counted in Unicode code points, as JSON Schema maxLength does.
// The tool's own refusal wins if its schema changes; update these then.
const FRAME_LIMITS = {
	title: 160,
	purpose: 4000,
	authority: 4000,
	source: 2000,
	restrictions: 4000,
	acceptance: 4000,
	integrator: 256,
} as const;
type FrameField = keyof typeof FRAME_LIMITS;
const FRAME_REQUIRED: readonly FrameField[] = ["title", "purpose", "authority", "source", "restrictions", "acceptance"];

// Kinds whose answer is a deliverable; their End condition must carry the
// rule that tool calls come first and the last message is the deliverable.
const DELIVERABLE_KINDS: ReadonlySet<ContractKind> = new Set(["task", "lead", "partner", "review"]);

const REQUIRED_MARKER = /<!--\s*required\s*-->/;
const HEADING = /^ {0,3}(#{1,2})[ \t]+(.+?)[ \t]*$/;
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const QUOTE_CHARACTER = /["\u201c\u201d]/;
const SOURCE_WORD = /\bsource\b/i;
const AUTHORITY_SLOT = /authority|operator directions/i;
const END_CONDITION_SLOT = /^end condition$/i;
const FINAL_MESSAGE = /\b(?:last|final) message\b/i;
// Instructions to sleep, wait a fixed duration, or poll. Matched per sentence;
// a sentence that also carries a negation reads as a prohibition and is not
// flagged. Heuristic limits: an instruction split across sentences, or a
// negation in a different sentence, is not detected.
const SLEEP_WAIT_POLL =
	/\b(?:sleep|setTimeout|setInterval|poll(?:s|ing|ed)?)\b|\bwait[ \t]+(?:for[ \t]+)?\d+[ \t]*(?:ms|milliseconds?|seconds?|minutes?|hours?)\b/i;
const NEGATION = /\b(?:never|not|no|don't|do not|avoid|without|prohibit(?:ed|s)?|forbid(?:s|den)?|mustn't)\b/i;
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

type Slot = { name: string; required: boolean; guidance: string };
type Finding = { code: string; message: string };
type ContractSize = { words: number; approxTokens: number };
type Report = {
	file: string;
	kind: ContractKind;
	ok: boolean;
	findings: Finding[];
	omitted: number;
	size: ContractSize;
};
type ParseOptions =
	| { help: true }
	| { help: false; command: "template"; kind: ContractKind }
	| { help: false; command: "check"; kind: ContractKind; source: string; json: boolean }
	| { help: false; command: "frame"; source: string };

const findings: Finding[] = [];
let findingCount = 0;

function boundedDiagnostic(message: unknown): string {
	const safe = String(message).replace(
		UNSAFE_CHARACTERS,
		(character: string) => `\\u${(character.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`,
	);
	return safe.length <= MAX_DIAGNOSTIC_LENGTH ? safe : `${safe.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

function find(code: string, message: string) {
	findingCount++;
	if (findings.length < MAX_REPORTED_FINDINGS) findings.push({ code, message: boundedDiagnostic(message) });
}

function usage() {
	return `Usage: node skills/orchestrate/scripts/contract.mts <command> [options]

Print, check, or convert orchestration contracts. Dependency-free Node.

Commands:
  template <kind>                Print the contract template for a kind
  check <file|-> --kind <kind>   Check a filled contract (- reads stdin)
  frame <file|->                 Check a filled frame and print the
                                 agent_collaborate create arguments as JSON

Kinds: ${KINDS.join(", ")}

Options:
  --kind <kind>   Contract kind (required for check)
  --json          Machine-readable check report on stdout
  -h, --help      Show this help

Required slots:
  Each asset marks its required slots with an HTML comment on the heading
  line: ## Objective <!-- required -->. The checker reads the slot list from
  the asset for the kind and matches level-2 headings in the filled contract,
  case-insensitively. Slot content runs to the next level-1 or level-2
  heading; HTML comments do not count as content. A later duplicate heading
  replaces an earlier one.

Checks:
  slot.missing, slot.empty         A required slot is absent or has no content
  slot.unfilled                    A slot still holds the template guidance line
  end-condition.missing/.empty     The End condition slot, reported distinctly
  end-condition.no-final-message   task, lead, partner, review: the End
                                   condition does not say that the last (or
                                   final) message is the complete deliverable
  authority.missing-verbatim       An Authority or Operator directions slot has
                                   no quoted text, or no source: the word
                                   "source" in the slot, or for a frame a
                                   filled Source slot
  frame.field-too-long             A frame field exceeds its agent_collaborate
                                   limit (title ${FRAME_LIMITS.title}, source ${FRAME_LIMITS.source}, integrator ${FRAME_LIMITS.integrator},
                                   other fields ${FRAME_LIMITS.purpose} code points)
  text.sleep-wait-poll             A sentence instructs sleep, a timed wait, or
                                   polling; a sentence with a negation (never,
                                   not, no, avoid, without, prohibit) reads as
                                   a prohibition and is not flagged
  size                             Words and approximate tokens (characters / ${CHARS_PER_TOKEN})

frame output:
  On success, stdout holds one JSON object: action "create", title, purpose,
  authority, source, restrictions, acceptance, and integrator when filled.
  Add sessionId before the call when an ordinary primary creates the thread
  in another participant's storage.

Output:
  stdout  check: verdict line with size, or the JSON report with --json
          frame: the JSON arguments, only when there are no findings
  stderr  Findings in text mode and for frame, and usage errors

Exit codes:
  0  No findings
  1  One or more findings
  2  Invalid invocation or unreadable input
`;
}

function isKind(value: string): value is ContractKind {
	return (KINDS as readonly string[]).includes(value);
}

function parseKindValue(value: string): ContractKind {
	if (!isKind(value)) throw new Error(`kind must be one of ${KINDS.join(", ")}, received: ${value}`);
	return value;
}

function buildTemplateOptions(
	operand: string | undefined,
	kind: ContractKind | undefined,
	json: boolean,
): ParseOptions {
	if (json) throw new Error("--json applies to check, not template");
	if (operand === undefined) throw new Error(`template requires a kind, one of ${KINDS.join(", ")}`);
	const templateKind = parseKindValue(operand);
	if (kind !== undefined && kind !== templateKind)
		throw new Error(`--kind ${kind} conflicts with template kind ${templateKind}`);
	return { help: false, command: "template", kind: templateKind };
}

function buildOptions(positionals: string[], kind: ContractKind | undefined, json: boolean): ParseOptions {
	const [command, operand, extra] = positionals;
	if (extra !== undefined) throw new Error(`Expected at most two positional arguments, received extra: ${extra}`);
	if (command === undefined) throw new Error("A command is required: template, check, or frame");
	if (command === "template") return buildTemplateOptions(operand, kind, json);
	if (command === "frame") {
		if (json) throw new Error("frame always prints JSON; --json applies to check");
		if (kind !== undefined && kind !== "frame") throw new Error(`frame does not accept --kind ${kind}`);
		if (operand === undefined) throw new Error("frame requires a file path or - for stdin");
		return { help: false, command: "frame", source: operand };
	}
	if (command !== "check") throw new Error(`Unknown command: ${command}`);
	if (kind === undefined) throw new Error("check requires --kind");
	if (operand === undefined) throw new Error("check requires a file path or - for stdin");
	return { help: false, command: "check", kind, source: operand, json };
}

function parseArgs(argv: string[]): ParseOptions {
	const positionals: string[] = [];
	let kind: ContractKind | undefined;
	let json = false;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") return { help: true };
		if (arg === "--json") {
			json = true;
			continue;
		}
		if (arg === "--kind") {
			kind = parseKindValue(argv[++index] ?? "");
			continue;
		}
		if (arg.startsWith("--kind=")) {
			kind = parseKindValue(arg.slice("--kind=".length));
			continue;
		}
		if (arg.startsWith("-") && arg !== "-") throw new Error(`Unknown option: ${arg}`);
		positionals.push(arg);
	}
	return buildOptions(positionals, kind, json);
}

function assetPath(kind: ContractKind): string {
	return fileURLToPath(new URL(`../assets/${kind}.md`, import.meta.url));
}

function normalizeName(name: string): string {
	return name.replace(HTML_COMMENT, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function displayName(heading: string): string {
	return heading.replace(HTML_COMMENT, "").replace(/\s+/g, " ").trim();
}

function slotText(content: string): string {
	return content.replace(HTML_COMMENT, "").trim();
}

function sections(markdown: string): Map<string, string> {
	const result = new Map<string, string>();
	let current: string | undefined;
	let buffer: string[] = [];
	const flush = () => {
		if (current !== undefined) result.set(current, buffer.join("\n"));
	};
	for (const line of markdown.split(/\r?\n/)) {
		const heading = line.match(HEADING);
		if (heading) {
			flush();
			current = heading[1].length === 2 ? normalizeName(heading[2]) : undefined;
			buffer = [];
			continue;
		}
		if (current !== undefined) buffer.push(line);
	}
	flush();
	return result;
}

function templateSlots(markdown: string): Slot[] {
	const guidance = sections(markdown);
	const slots: Slot[] = [];
	for (const line of markdown.split(/\r?\n/)) {
		const match = line.match(HEADING);
		if (match?.[1].length !== 2) continue;
		const name = displayName(match[2]);
		slots.push({
			name,
			required: REQUIRED_MARKER.test(match[2]),
			guidance: slotText(guidance.get(normalizeName(name)) ?? ""),
		});
	}
	return slots;
}

function checkSlot(kind: ContractKind, slot: Slot, content: string | undefined): void {
	const text = content === undefined ? undefined : slotText(content);
	if (text !== undefined && text !== "" && text === slot.guidance) {
		find("slot.unfilled", `${kind}: slot still holds the template guidance: ${slot.name}`);
		return;
	}
	if (!slot.required || (text !== undefined && text !== "")) return;
	const prefix = END_CONDITION_SLOT.test(slot.name) ? "end-condition" : "slot";
	if (text === undefined) find(`${prefix}.missing`, `${kind}: required slot is missing: ${slot.name}`);
	else find(`${prefix}.empty`, `${kind}: required slot is empty: ${slot.name}`);
}

function checkRequiredSlots(kind: ContractKind, slots: Slot[], filled: Map<string, string>): void {
	for (const slot of slots) checkSlot(kind, slot, filled.get(normalizeName(slot.name)));
}

function checkFinalMessageRule(kind: ContractKind, filled: Map<string, string>): void {
	if (!DELIVERABLE_KINDS.has(kind)) return;
	const text = slotText(filled.get("end condition") ?? "");
	if (text === "" || FINAL_MESSAGE.test(text)) return;
	find(
		"end-condition.no-final-message",
		`${kind}: End condition must say that tool calls and thread posts come first and the last message is the complete deliverable`,
	);
}

function checkAuthoritySlots(kind: ContractKind, slots: Slot[], filled: Map<string, string>): void {
	const frameSource = kind === "frame" ? slotText(filled.get("source") ?? "") : "";
	for (const slot of slots) {
		if (!AUTHORITY_SLOT.test(slot.name)) continue;
		const text = slotText(filled.get(normalizeName(slot.name)) ?? "");
		if (text === "" || text === slot.guidance) continue;
		const hasSource = frameSource !== "" || SOURCE_WORD.test(text);
		if (!QUOTE_CHARACTER.test(text) || !hasSource) {
			find(
				"authority.missing-verbatim",
				`${kind}: slot '${slot.name}' must hold the operator's words in quotes and a named source`,
			);
		}
	}
}

function codePoints(text: string): number {
	return [...text].length;
}

function checkFrameLimits(kind: ContractKind, filled: Map<string, string>): void {
	if (kind !== "frame") return;
	for (const [field, limit] of Object.entries(FRAME_LIMITS)) {
		const length = codePoints(slotText(filled.get(field) ?? ""));
		if (length > limit) {
			find(
				"frame.field-too-long",
				`frame: field '${field}' is ${length} code points; the agent_collaborate limit is ${limit}`,
			);
		}
	}
}

function checkSleepWaitPoll(kind: ContractKind, text: string): void {
	for (const segment of text.replace(HTML_COMMENT, "").split(/(?<=[.!?])[ \t]+|\r?\n/)) {
		const sentence = segment.trim();
		if (sentence && SLEEP_WAIT_POLL.test(sentence) && !NEGATION.test(sentence)) {
			find("text.sleep-wait-poll", `${kind}: instructs sleep, a timed wait, or polling: ${sentence}`);
		}
	}
}

function measure(text: string): ContractSize {
	const words = (text.match(/\S+/g) ?? []).length;
	return { words, approxTokens: Math.ceil(text.length / CHARS_PER_TOKEN) };
}

function readContract(source: string): string {
	let text: string;
	if (source === "-") {
		text = readFileSync(0, "utf8");
	} else {
		if (!existsSync(source)) throw new Error(`Contract file does not exist: ${source}`);
		if (!statSync(source).isFile()) throw new Error(`Contract path is not a file: ${source}`);
		if (statSync(source).size > MAX_CONTRACT_BYTES)
			throw new Error(`Contract exceeds the ${MAX_CONTRACT_BYTES} byte input bound: ${source}`);
		text = readFileSync(source, "utf8");
	}
	if (Buffer.byteLength(text, "utf8") > MAX_CONTRACT_BYTES) {
		throw new Error(`Contract exceeds the ${MAX_CONTRACT_BYTES} byte input bound: ${source}`);
	}
	return text;
}

function runCheck(kind: ContractKind, text: string): Map<string, string> {
	const asset = assetPath(kind);
	if (!existsSync(asset)) throw new Error(`Template asset is missing for kind '${kind}': ${asset}`);
	const slots = templateSlots(readFileSync(asset, "utf8"));
	const filled = sections(text);
	checkRequiredSlots(kind, slots, filled);
	checkFinalMessageRule(kind, filled);
	checkAuthoritySlots(kind, slots, filled);
	checkFrameLimits(kind, filled);
	checkSleepWaitPoll(kind, text);
	return filled;
}

function frameArguments(filled: Map<string, string>): Record<string, string> {
	const args: Record<string, string> = { action: "create" };
	for (const field of FRAME_REQUIRED) args[field] = slotText(filled.get(field) ?? "");
	const integrator = slotText(filled.get("integrator") ?? "");
	if (integrator !== "") args.integrator = integrator;
	return args;
}

function logFindings(): void {
	for (const finding of findings) console.error(`FIND ${finding.code}: ${finding.message}`);
	const omitted = findingCount - findings.length;
	if (omitted > 0) console.error(`FIND report.truncated: ${omitted} additional findings omitted`);
}

function logReport(json: boolean, report: Report): void {
	if (json) {
		console.log(JSON.stringify(report, null, 2));
		return;
	}
	logFindings();
	console.log(
		`${report.ok ? "PASS" : "FAIL"} ${report.file} (kind ${report.kind}): ${report.size.words} words, ~${report.size.approxTokens} tokens`,
	);
}

function exitWithError(error: unknown): never {
	console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(2);
}

function main(): void {
	let options: ParseOptions;
	try {
		options = parseArgs(process.argv.slice(2));
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		console.error(usage());
		process.exit(2);
	}
	if (options.help) {
		console.log(usage());
		process.exit(0);
	}
	if (options.command === "template") {
		process.stdout.write(readFileSync(assetPath(options.kind), "utf8"));
		process.exit(0);
	}
	let text: string;
	let filled: Map<string, string>;
	const kind: ContractKind = options.command === "frame" ? "frame" : options.kind;
	try {
		text = readContract(options.source);
		filled = runCheck(kind, text);
	} catch (error) {
		exitWithError(error);
	}
	if (options.command === "frame") {
		logFindings();
		if (findingCount === 0) console.log(JSON.stringify(frameArguments(filled), null, 2));
		process.exit(findingCount === 0 ? 0 : 1);
	}
	logReport(options.json, {
		file: options.source,
		kind,
		ok: findingCount === 0,
		findings,
		omitted: findingCount - findings.length,
		size: measure(text),
	});
	process.exit(findingCount === 0 ? 0 : 1);
}

main();
