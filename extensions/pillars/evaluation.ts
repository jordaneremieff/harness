import { createHash } from "node:crypto";
import { mkdtemp, opendir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { decodeBody, defaultCorpusRoot, readBody } from "./catalog.ts";
import pillarsExtension from "./index.ts";
import { parseJudgmentRequest } from "./commands.ts";

const slice = dirname(fileURLToPath(import.meta.url));
const flag = "pillars-eval-source";

/** Bind the source adapter, its local modules, and the live corpus to the approved plan. */
export async function evaluationSource(): Promise<{ digest: string; paths: string[] }> {
	const paths: string[] = [];
	const directory = await opendir(slice);
	let visits = 0;
	for await (const entry of directory) {
		if (++visits > 128) throw new Error("Pillars evaluation source limit exceeded.");
		if (entry.isFile() && entry.name.endsWith(".ts")) paths.push(join(slice, entry.name));
	}
	const root = defaultCorpusRoot();
	paths.push(join(root, "README.md"), join(root, "GOVERNANCE.md"));
	const inventory = decodeBody(await readBody(join(root, "README.md")));
	const targets = new Set<string>();
	for (const match of inventory.matchAll(/\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
		if (targets.size >= 128) throw new Error("Pillars evaluation corpus limit exceeded.");
		if (/^(principle|pattern|heuristic)-[a-z0-9-]+\.md$/.test(match[1])) targets.add(match[1]);
	}
	paths.push(...[...targets].map((name) => join(root, name)));
	const hash = createHash("sha256");
	for (const path of paths.sort()) {
		const local = path.startsWith(`${slice}/`)
			? `extension/${path.slice(slice.length + 1)}`
			: `corpus/${path.slice(root.length + 1)}`;
		hash
			.update(local)
			.update("\0")
			.update(await readBody(path))
			.update("\0");
	}
	return { digest: hash.digest("hex"), paths };
}

/** Evaluation-only host adapter; the production command still owns the request. */
export default async function evaluationExtension(pi: ExtensionAPI): Promise<void> {
	pi.registerFlag(flag, { description: "Approved Pillars evaluation source digest", type: "string" });
	const source = await evaluationSource();
	const keys = ["PI_PILLARS_CORPUS", "PI_PILLARS_COLLECT", "PI_PILLARS_DIR"] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	const directory = await mkdtemp(join(tmpdir(), "pillars-evaluation-"));
	let closed = false;
	let settled: (() => void) | undefined;
	async function cleanup(): Promise<void> {
		if (closed) return;
		closed = true;
		settled?.();
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(directory, { recursive: true, force: true });
	}
	process.env.PI_PILLARS_CORPUS = defaultCorpusRoot();
	process.env.PI_PILLARS_COLLECT = "0";
	process.env.PI_PILLARS_DIR = directory;
	try {
		pi.on("agent_settled", () => {
			settled?.();
		});
		pillarsExtension({
			...pi,
			registerCommand(name, command) {
				pi.registerCommand(name, {
					...command,
					handler: async (args, ctx) => {
						if (pi.getFlag(flag) !== source.digest)
							throw new Error("Pillars evaluation source differs from the approved plan.");
						if (!parseJudgmentRequest(args))
							throw new Error("The evaluation admits only check, derive, and review commands.");
						if (settled) throw new Error("A Pillars evaluation command is already active.");
						const completion = new Promise<void>((resolve) => {
							settled = resolve;
						});
						try {
							await command.handler(args, ctx);
							// This SDK adapter does not bind command-context waitForIdle actions.
							if (!ctx.isIdle()) await completion;
						} finally {
							settled = undefined;
						}
					},
				});
			},
		});
		pi.on("tool_call", (event) => {
			if (event.toolName === "pillars") return;
			return {
				block: true,
				reason: "The evaluation permits only Pillars source reads; no mutation or external access is authorized.",
			};
		});
		pi.on("session_shutdown", cleanup);
	} catch (error) {
		await cleanup();
		throw error;
	}
}
