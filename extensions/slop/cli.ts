#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { proseKinds } from "./detect.ts";
import { readRegular } from "./files.ts";
import { fileInput } from "./input.ts";
import { check, runCheck } from "./operations.ts";
import { terminalText } from "./presentation-text.ts";

const usage = "Usage: slop check [--staged | --range A..B | --commit-file F | --text-file F --kind K | PATH...]";

function parse(argv: string[]) {
	const parsed = parseArgs({
		args: argv,
		allowPositionals: true,
		tokens: true,
		options: {
			staged: { type: "boolean" },
			range: { type: "string" },
			"commit-file": { type: "string" },
			"text-file": { type: "string" },
			kind: { type: "string" },
		},
	});
	const names = parsed.tokens.flatMap((token) => (token.kind === "option" ? [token.name] : []));
	if (new Set(names).size !== names.length) throw new Error("Options must not repeat.");
	const { staged, range, "commit-file": commitFile, "text-file": textFile, kind: rawKind } = parsed.values;
	const paths = parsed.positionals;
	if (
		[staged, range !== undefined, commitFile !== undefined, textFile !== undefined, paths.length > 0].filter(Boolean)
			.length > 1
	)
		throw new Error(usage);
	if ((rawKind === undefined) !== (textFile === undefined))
		throw new Error("Use --kind only and always with --text-file.");
	const kind = proseKinds.find((value) => value === rawKind);
	if (rawKind !== undefined && !kind) throw new Error("kind must be reply, document or commit.");
	return {
		staged,
		range,
		file: commitFile ?? textFile,
		kind: commitFile === undefined ? kind : ("commit" as const),
		paths,
	};
}
function loadText(cwd: string, file: string): string {
	const bytes = readRegular(resolve(cwd, file), 8 * 1024 * 1024);
	if (!bytes) throw new Error(`${file}: file does not exist.`);
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function main(argv: string[]): Promise<number> {
	const [action, ...args] = argv;
	if (action === "--help" || (args.length === 1 && args[0] === "--help")) {
		console.log(usage);
		return 0;
	}
	if (action !== "check") throw new Error(usage);
	const options = { agentDir: getAgentDir() };
	const cwd = process.cwd();
	const { staged, range, file, kind, paths } = parse(args);
	let result: Awaited<ReturnType<typeof check>>;
	if (file !== undefined) result = await check(options, cwd, { text: loadText(cwd, file), kind });
	else if (paths.length) {
		const inputs = paths.map((path) => fileInput(cwd, path));
		result = runCheck(options, {
			lines: inputs.flatMap((input) => input.lines),
			skipped: inputs.flatMap((input) => input.skipped),
		});
	} else result = await check(options, cwd, { diff: staged ? { staged: true } : range !== undefined ? { range } : {} });
	console.log(terminalText(result.content[0].text));
	return result.details.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) {
	try {
		process.exitCode = await main(process.argv.slice(2));
	} catch (error) {
		console.error(terminalText(error instanceof Error ? error.message : String(error)));
		process.exitCode = 2;
	}
}
