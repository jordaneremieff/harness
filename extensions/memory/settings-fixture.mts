import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";

/** Keep factory configuration reads out of the machine agent directory. */
export function isolateMachineSettings(): void {
	let agentDir: string;
	const previous = {
		PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
		PI_HARNESS_FILE: process.env.PI_HARNESS_FILE,
	};
	before(() => {
		agentDir = mkdtempSync(join(tmpdir(), "memory-agent-settings-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.PI_HARNESS_FILE = join(agentDir, "harness.json");
	});
	after(() => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(agentDir, { recursive: true, force: true });
	});
}
