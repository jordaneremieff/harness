/** Closed Git option grammar. This reader neither resolves aliases nor executes commands. */
import type { Stage } from "./shell.ts";

export interface OptionOccurrence {
	spelling: string;
	canonical: string;
	value?: string;
	argumentIndex: number;
	polarity: "set" | "unset";
}

export type CliEvidence =
	| {
			status: "known";
			subcommand: ["push"];
			globals: OptionOccurrence[];
			options: OptionOccurrence[];
			operands: string[];
	  }
	| { status: "unrelated" }
	| { status: "unknown"; reason: string };

interface Descriptor {
	canonical: string;
	arity: "none" | "required" | "optional";
	polarity: "set" | "unset";
}

const pushOptions = new Map<string, Descriptor>();
function option(canonical: string, names: string[], arity: Descriptor["arity"] = "none", negate = true): void {
	for (const name of names) {
		pushOptions.set(name, { canonical, arity, polarity: "set" });
		if (negate && name.startsWith("--")) {
			pushOptions.set(`--no-${name.slice(2)}`, { canonical, arity: "none", polarity: "unset" });
		}
	}
}
option("verbose", ["-v", "--verbose"]);
option("quiet", ["-q", "--quiet"]);
option("all", ["--all", "--branches"]);
option("mirror", ["--mirror"]);
option("delete", ["-d", "--delete"]);
option("tags", ["--tags"]);
option("dry-run", ["-n", "--dry-run"]);
option("porcelain", ["--porcelain"]);
option("force", ["-f", "--force"]);
option("force-with-lease", ["--force-with-lease"], "optional");
option("force-if-includes", ["--force-if-includes"]);
option("recurse-submodules", ["--recurse-submodules"], "required");
option("thin", ["--thin"]);
option("repo", ["--repo"], "required");
option("receive-pack", ["--receive-pack", "--exec"], "required");
option("set-upstream", ["-u", "--set-upstream"]);
option("progress", ["--progress"]);
option("prune", ["--prune"]);
option("verify", ["--verify"]);
pushOptions.set("--no-verify", { canonical: "verify", arity: "none", polarity: "unset" });
option("follow-tags", ["--follow-tags"]);
option("signed", ["--signed"], "optional");
option("atomic", ["--atomic"]);
option("push-option", ["-o", "--push-option"], "required");
option("ipv4", ["-4", "--ipv4"]);
option("ipv6", ["-6", "--ipv6"]);
option("help", ["-h", "--help"], "none", false);

const globalFlags = new Set([
	"-p",
	"--paginate",
	"-P",
	"--no-pager",
	"--no-lazy-fetch",
	"--no-replace-objects",
	"--bare",
	"--literal-pathspecs",
	"--no-literal-pathspecs",
	"--glob-pathspecs",
	"--noglob-pathspecs",
	"--icase-pathspecs",
	"--no-optional-locks",
	"--no-advice",
]);
const globalValues = new Set([
	"-C",
	"-c",
	"--git-dir",
	"--namespace",
	"--work-tree",
	"--config-env",
	"--shallow-file",
	"--attr-source",
]);
const globalQueries = new Set(["--version", "-v", "--help", "-h", "--html-path", "--man-path", "--info-path"]);

/** CLI selectors name supported option spellings, never attached values or abbreviations. */
export function isGitPushFlag(flag: string): boolean {
	return pushOptions.has(flag);
}

/** Decode one global option word; an empty advance signals the end of the global run. */
function decodeGlobalWord(
	args: readonly string[],
	index: number,
	literal: (index: number) => boolean,
): { advance: number; options: OptionOccurrence[] } | CliEvidence {
	const arg = args[index];
	if (!literal(index)) return { status: "unknown", reason: "dynamic-word" };
	if (!arg.startsWith("-")) return { advance: 0, options: [] };
	if (globalQueries.has(arg) || arg.startsWith("--list-cmds=")) return { status: "unrelated" };
	const equals = arg.indexOf("=");
	const name = equals < 0 ? arg : arg.slice(0, equals);
	const attached = equals < 0 ? undefined : arg.slice(equals + 1);
	if (name === "--exec-path") {
		if (attached === undefined) return { status: "unrelated" };
		return {
			advance: 1,
			options: [{ spelling: name, canonical: name.slice(2), value: attached, argumentIndex: index, polarity: "set" }],
		};
	}
	if (globalFlags.has(arg)) return { advance: 1, options: [{ spelling: arg, canonical: arg, argumentIndex: index, polarity: "set" }] };
	if (globalValues.has(name)) return decodeGlobalValue(name, attached, args, index, literal);
	return { status: "unknown", reason: "unsupported-global-option" };
}

function decodeGlobalValue(
	name: string,
	attached: string | undefined,
	args: readonly string[],
	index: number,
	literal: (index: number) => boolean,
): { advance: number; options: OptionOccurrence[] } | CliEvidence {
	if (attached !== undefined && (!name.startsWith("--") || name === "--shallow-file"))
		return { status: "unknown", reason: "invalid-option-form" };
	const nextIndex = attached === undefined ? index + 1 : index;
	const value = attached ?? args[nextIndex];
	if (value === undefined) return { status: "unknown", reason: "missing-value" };
	if (!literal(nextIndex)) return { status: "unknown", reason: "dynamic-word" };
	return {
		advance: nextIndex - index + 1,
		options: [{ spelling: name, canonical: name, value, argumentIndex: index, polarity: "set" }],
	};
}

/** Decode the leading Git global option run; index points at the first non-option word. */
function decodeGlobalArgs(
	args: readonly string[],
	literal: (index: number) => boolean,
): { globals: OptionOccurrence[]; nextIndex: number } | CliEvidence {
	const globals: OptionOccurrence[] = [];
	let index = 0;
	for (; index < args.length; index++) {
		const decoded = decodeGlobalWord(args, index, literal);
		if ("status" in decoded) return decoded;
		if (decoded.advance === 0) break;
		globals.push(...decoded.options);
		index += decoded.advance - 1;
	}
	return { globals, nextIndex: index };
}

function pushOccurrence(
	spelling: string,
	descriptor: Descriptor,
	argumentIndex: number,
	value?: string,
): OptionOccurrence {
	return {
		spelling,
		canonical: descriptor.canonical,
		polarity: descriptor.polarity,
		argumentIndex,
		...(value === undefined ? {} : { value }),
	};
}

function decodeLongPushOption(
	args: readonly string[],
	index: number,
	arg: string,
): { options: OptionOccurrence[]; consumedNext: boolean } | CliEvidence {
	const equals = arg.indexOf("=");
	const spelling = equals < 0 ? arg : arg.slice(0, equals);
	const descriptor = pushOptions.get(spelling);
	if (!descriptor) return { status: "unknown", reason: "unsupported-option" };
	const attached = equals < 0 ? undefined : arg.slice(equals + 1);
	if (attached !== undefined && descriptor.arity === "none") return { status: "unknown", reason: "invalid-option-form" };
	if (attached === undefined && descriptor.arity === "required") {
		const value = args[index + 1];
		if (value === undefined) return { status: "unknown", reason: "missing-value" };
		return { options: [pushOccurrence(spelling, descriptor, index, value)], consumedNext: true };
	}
	return { options: [pushOccurrence(spelling, descriptor, index, attached)], consumedNext: false };
}

/** One bound covers argument words and decoded option occurrences together. */
const PUSH_WORD_BUDGET = 4096;

function decodeShortPushCluster(
	args: readonly string[],
	index: number,
	arg: string,
	collected: number,
): { options: OptionOccurrence[]; consumedNext: boolean } | CliEvidence {
	const cluster: OptionOccurrence[] = [];
	let consumedNext = false;
	for (let position = 1; position < arg.length; position++) {
		const spelling = `-${arg[position]}`;
		const descriptor = pushOptions.get(spelling);
		if (!descriptor) return { status: "unknown", reason: "unsupported-option" };
		let value: string | undefined;
		if (descriptor.arity === "required") {
			const attached = arg.slice(position + 1);
			if (attached !== "") {
				value = attached;
			} else {
				const next = args[index + 1];
				if (next === undefined) return { status: "unknown", reason: "missing-value" };
				value = next;
				consumedNext = true;
			}
		}
		cluster.push(pushOccurrence(spelling, descriptor, index, value));
		if (collected + cluster.length + args.length > PUSH_WORD_BUDGET)
			return { status: "unknown", reason: "option-limit" };
		if (descriptor.arity !== "none") break;
	}
	return { options: cluster, consumedNext };
}

/** Decode one push option word, including a short-option cluster. */
function decodePushOption(
	args: readonly string[],
	index: number,
	collected: number,
): { options: OptionOccurrence[]; consumedNext: boolean } | CliEvidence {
	const arg = args[index];
	return arg.startsWith("--")
		? decodeLongPushOption(args, index, arg)
		: decodeShortPushCluster(args, index, arg, collected);
}

function collectPushOptions(
	args: readonly string[],
	start: number,
	unknown: (reason: string) => CliEvidence,
): { options: OptionOccurrence[]; operands: string[] } | CliEvidence {
	const options: OptionOccurrence[] = [];
	const operands: string[] = [];
	let terminated = false;
	let index = start;
	for (; index < args.length; index++) {
		const arg = args[index];
		if (!terminated && arg === "--") {
			terminated = true;
			continue;
		}
		if (terminated || arg === "-" || !arg.startsWith("-")) {
			operands.push(arg);
			continue;
		}
		const decoded = decodePushOption(args, index, options.length);
		if ("status" in decoded) return decoded;
		options.push(...decoded.options);
		if (decoded.consumedNext) index++;
		if (options.length + args.length > PUSH_WORD_BUDGET) return unknown("option-limit");
	}
	return { options, operands };
}

/** Decode one shell stage; all occurrence indexes refer to the original argument vector. */
export function decodeGitPush(stage: Stage): CliEvidence {
	if (stage.commandLiteral === false) return { status: "unknown", reason: "dynamic-command" };
	if (stage.command !== "git") return { status: "unrelated" };
	const args = stage.args;
	const literal = (index: number) => stage.argLiterals?.[index] !== false;
	const unknown = (reason: string): CliEvidence => ({ status: "unknown", reason });
	if (stage.shellReasons?.length) return unknown(stage.shellReasons[0]);
	if (args.length > PUSH_WORD_BUDGET) return unknown("word-limit");
	const leading = decodeGlobalArgs(args, literal);
	if ("status" in leading) return leading;
	const index = leading.nextIndex;
	if (index === args.length) return unknown("missing-subcommand");
	if (args[index] !== "push") return { status: "unrelated" };
	if (args.slice(index + 1).some((_, offset) => !literal(index + 1 + offset))) return unknown("dynamic-word");
	const rest = collectPushOptions(args, index + 1, unknown);
	if ("status" in rest) return rest;
	return { status: "known", subcommand: ["push"], globals: leading.globals, options: rest.options, operands: rest.operands };
}
