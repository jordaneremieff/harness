import { spawn } from "node:child_process";
import { cleanGitEnvironment } from "./git-environment.mts";
import { inspectPublishedUpstream, inspectUpstream } from "./upstream.mts";

export type EvolutionOperation =
	| { operation: "evolution.status" }
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

const outputLimit = 8_000;

/** Bound command output and time; never retry after timeout or transport loss. */
export function runEvolutionCommand(
	cwd: string,
	command: string[],
	options: { timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<EvolutionCommandResult> {
	return new Promise((resolve) => {
		const env = cleanGitEnvironment(options.env ?? process.env);
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

/** Validate untyped HTTP/model input before constructing any process arguments. */
export function evolutionCommand(request: EvolutionOperation): string[] | null {
	if (!request || typeof request !== "object") throw new Error("Invalid evolution operation.");
	switch (request.operation) {
		case "evolution.status":
		case "upstream.status":
			return null;
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
		},
		actions: ["upstream.update"],
	};
}

export async function dispatchEvolutionOperation(options: { cwd: string }, request: EvolutionOperation) {
	const command = evolutionCommand(request);
	if (request.operation === "upstream.status") {
		const [local, published] = await Promise.all([inspectUpstream(options), inspectPublishedUpstream()]);
		return { ...local, latestPublished: published };
	}
	if (request.operation === "evolution.status") return inspectEvolution(options);
	if (command === null) throw new Error("Operation has no command.");
	return runEvolutionCommand(options.cwd, command, { env: cleanGitEnvironment(process.env) });
}
