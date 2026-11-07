import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { googleCommand } from "./command.ts";

/** Shell entry for the same verbs as /google: node extensions/google/cli.ts setup --client <file> */
const ok = await googleCommand(process.argv.slice(2).join(" "), getAgentDir(), process.env, (line, level) =>
	(level === "error" ? console.error : console.log)(line),
);
process.exitCode = ok ? 0 : 1;
