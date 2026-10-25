import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cleanGitEnvironment, mainCheckoutRoot, parseSliceReference } from "../scripts/worktrees.mts";
import { inspectPublishedUpstream, inspectUpstream } from "./upstream.mts";

export type EvolutionOperation =
	| { operation: "evolution.status" }
	| { operation: "evolution.sync"; sourceOnly: true }
	| { operation: "evolution.promotion-plan" | "evolution.promote-local"; slices: string[]; full?: boolean }
	| { operation: "upstream.status" }
	| { operation: "upstream.update" };

export interface EvolutionCommandResult {
	ok: boolean;
	command: string[];
	exitCode: number | null;
	stdout: string;
	stderr: string;
	truncated: boolean;
	timedOut: boolean;
	/** Timeout or lost child acknowledgement is not evidence that effects rolled back. */
	uncertain: boolean;
}

const worktreeScript = fileURLToPath(new URL("../scripts/worktrees.mts", import.meta.url));
const outputLimit = 8_000;

/** Bound command output and time; never retry after timeout or transport loss. */
export function runEvolutionCommand(
	cwd: string,
	command: string[],
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<EvolutionCommandResult> {
	return new Promise((resolve) => {
		const env = cleanGitEnvironment(options.env ?? process.env);
		delete env.PI_PROMOTE_GATES;
		const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
		let stdout = Buffer.alloc(0);
		let stderr = Buffer.alloc(0);
		let truncated = false;
		let timedOut = false;
		let spawnFailed = false;
		const retain = (previous: Buffer, chunk: Buffer) => {
			const remaining = outputLimit - previous.length;
			if (chunk.length > remaining) truncated = true;
			return Buffer.concat([previous, chunk.subarray(0, Math.max(0, remaining))]);
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = retain(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = retain(stderr, chunk);
		});
		const timer = setTimeout(
			() => {
				timedOut = true;
				// Stop the owned command tree, not an unrelated Pi host.
				if (child.pid !== undefined) {
					try {
						process.kill(-child.pid, "SIGKILL");
					} catch {
						child.kill("SIGKILL");
					}
				}
			},
			options.timeoutMs ?? 30 * 60_000,
		);
		child.once("error", () => {
			spawnFailed = true;
			stderr = retain(stderr, Buffer.from("Command failed to start."));
		});
		child.once("close", (exitCode) => {
			clearTimeout(timer);
			resolve({
				ok: exitCode === 0 && !timedOut && !spawnFailed,
				command,
				exitCode,
				stdout: stdout.toString("utf8"),
				stderr: stderr.toString("utf8"),
				truncated,
				timedOut,
				uncertain: timedOut || (!spawnFailed && exitCode === null),
			});
		});
	});
}

function promotionCommand(request: Extract<EvolutionOperation, { slices: string[] }>): string[] {
	if (!Array.isArray(request.slices) || request.slices.length < 1 || request.slices.length > 32) {
		throw new Error("Select between 1 and 32 slices.");
	}
	if (request.full !== undefined && typeof request.full !== "boolean") throw new Error("full must be boolean.");
	for (const slice of request.slices) {
		if (typeof slice !== "string" || slice.length > 160) throw new Error("Invalid slice reference.");
		parseSliceReference(slice);
	}
	if (new Set(request.slices).size !== request.slices.length) throw new Error("Duplicate slice reference.");
	return [
		process.execPath,
		worktreeScript,
		"promote",
		...request.slices,
		"--no-push",
		"--sync-selected",
		"--json",
		...(request.operation === "evolution.promotion-plan" ? ["--dry-run"] : []),
		...(request.full ? ["--full"] : []),
	];
}

/** Validate untyped HTTP/model input before constructing any process arguments. */
export function evolutionCommand(request: EvolutionOperation): string[] | null {
	if (!request || typeof request !== "object") throw new Error("Invalid evolution operation.");
	switch (request.operation) {
		case "evolution.status":
		case "upstream.status":
			return null;
		case "evolution.sync":
			if (request.sourceOnly !== true) throw new Error("Evolution sync requires sourceOnly: true.");
			return [process.execPath, worktreeScript, "sync", "--current", "--source-only"];
		case "evolution.promotion-plan":
		case "evolution.promote-local":
			return promotionCommand(request);
		case "upstream.update":
			return ["pi", "update"];
		default:
			throw new Error("Unknown evolution operation.");
	}
}

export async function inspectEvolution(options: { cwd: string }) {
	const [worktrees, changes, upstream] = await Promise.all([
		runEvolutionCommand(options.cwd, ["git", "worktree", "list", "--porcelain"], { timeoutMs: 5000 }),
		runEvolutionCommand(options.cwd, ["git", "status", "--porcelain=v1", "--untracked-files=normal"], {
			timeoutMs: 5000,
		}),
		inspectUpstream(options),
	]);
	return {
		observedAt: new Date().toISOString(),
		worktrees,
		changes,
		upstream,
		owners: {
			development: "docs/conventions/worktrees.md",
			releaseIntake: "extensions/evo/README.md#release-intake",
			acceptance: "docs/agent-delivery.md#deliver-and-report",
		},
		actions: ["evolution.sync", "evolution.promotion-plan", "evolution.promote-local", "upstream.update"],
		publication: "separate-authority-required",
		semanticReview: "required",
	};
}

/** Bind maintenance to the server-selected checkout, independent of the sealed script location. */
export function evolutionEnvironment(cwd: string, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const root = realpathSync(mainCheckoutRoot(realpathSync(cwd)));
	return { ...cleanGitEnvironment(environment), PI_HARNESS_ROOT: root, PI_WORKTREE_ROOT: `${root}.worktrees` };
}

export async function dispatchEvolutionOperation(options: { cwd: string }, request: EvolutionOperation) {
	const command = evolutionCommand(request);
	if (request.operation === "upstream.status") {
		const [local, published] = await Promise.all([inspectUpstream(options), inspectPublishedUpstream()]);
		return { ...local, latestPublished: published };
	}
	if (request.operation === "evolution.status") return inspectEvolution(options);
	if (command === null) throw new Error("Operation has no command.");
	return runEvolutionCommand(options.cwd, command, { env: evolutionEnvironment(options.cwd) });
}
