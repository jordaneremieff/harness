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

/** Decode one shell stage; all occurrence indexes refer to the original argument vector. */
export function decodeGitPush(stage: Stage): CliEvidence {
	if (stage.commandLiteral === false) return { status: "unknown", reason: "dynamic-command" };
	if (stage.command !== "git") return { status: "unrelated" };
	const args = stage.args;
	const literal = (index: number) => stage.argLiterals?.[index] !== false;
	const unknown = (reason: string): CliEvidence => ({ status: "unknown", reason });
	if (stage.shellReasons?.length) return unknown(stage.shellReasons[0]);
	if (args.length > 4096) return unknown("word-limit");
	const globals: OptionOccurrence[] = [];
	let index = 0;
	for (; index < args.length; index++) {
		if (!literal(index)) return unknown("dynamic-word");
		const arg = args[index];
		if (!arg.startsWith("-")) break;
		if (globalQueries.has(arg) || arg.startsWith("--list-cmds=")) return { status: "unrelated" };
		const equals = arg.indexOf("=");
		const name = equals < 0 ? arg : arg.slice(0, equals);
		const attached = equals < 0 ? undefined : arg.slice(equals + 1);
		if (name === "--exec-path") {
			if (attached === undefined) return { status: "unrelated" };
			globals.push({
				spelling: name,
				canonical: name.slice(2),
				value: attached,
				argumentIndex: index,
				polarity: "set",
			});
		} else if (globalFlags.has(arg)) {
			globals.push({ spelling: arg, canonical: arg, argumentIndex: index, polarity: "set" });
		} else if (globalValues.has(name)) {
			if (attached !== undefined && (!name.startsWith("--") || name === "--shallow-file"))
				return unknown("invalid-option-form");
			const argumentIndex = index;
			const value = attached ?? args[++index];
			if (value === undefined) return unknown("missing-value");
			if (!literal(index)) return unknown("dynamic-word");
			globals.push({ spelling: name, canonical: name, value, argumentIndex, polarity: "set" });
		} else return unknown("unsupported-global-option");
	}
	if (index === args.length) return unknown("missing-subcommand");
	if (args[index] !== "push") return { status: "unrelated" };
	index++;
	if (args.slice(index).some((_, offset) => !literal(index + offset))) return unknown("dynamic-word");
	const options: OptionOccurrence[] = [];
	const operands: string[] = [];
	let terminated = false;
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
		const argumentIndex = index;
		if (arg.startsWith("--")) {
			const equals = arg.indexOf("=");
			const spelling = equals < 0 ? arg : arg.slice(0, equals);
			const descriptor = pushOptions.get(spelling);
			if (!descriptor) return unknown("unsupported-option");
			let value = equals < 0 ? undefined : arg.slice(equals + 1);
			if (value !== undefined && descriptor.arity === "none") return unknown("invalid-option-form");
			if (value === undefined && descriptor.arity === "required") {
				value = args[++index];
				if (value === undefined) return unknown("missing-value");
			}
			options.push({
				spelling,
				canonical: descriptor.canonical,
				polarity: descriptor.polarity,
				argumentIndex,
				...(value === undefined ? {} : { value }),
			});
		} else {
			for (let position = 1; position < arg.length; position++) {
				const spelling = `-${arg[position]}`;
				const descriptor = pushOptions.get(spelling);
				if (!descriptor) return unknown("unsupported-option");
				let value: string | undefined;
				if (descriptor.arity === "required") {
					value = arg.slice(position + 1) || args[++index];
					if (value === undefined) return unknown("missing-value");
				}
				options.push({
					spelling,
					canonical: descriptor.canonical,
					polarity: descriptor.polarity,
					argumentIndex,
					...(value === undefined ? {} : { value }),
				});
				if (options.length + args.length > 4096) return unknown("option-limit");
				if (descriptor.arity !== "none") break;
			}
		}
		if (options.length + args.length > 4096) return unknown("option-limit");
	}
	return { status: "known", subcommand: ["push"], globals, options, operands };
}
