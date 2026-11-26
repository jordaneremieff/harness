import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const captureProgram = fileURLToPath(new URL("../rex/terminal-origin.ts", import.meta.url));
const splitProgram = fileURLToPath(new URL("../rex/terminal-pane.ts", import.meta.url));

type RecordValue = Record<string, unknown>;
function object(value: unknown): value is RecordValue {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

type Helper = (
	program: string,
	verb: "capture" | "split",
	signal: AbortSignal,
	input?: RecordValue,
) => Promise<unknown>;
const invoke: Helper = (program, verb, signal, input) =>
	new Promise((resolve, reject) => {
		const child = execFile(
			process.execPath,
			[program, verb],
			{ timeout: 7500, maxBuffer: 32768, signal },
			(err, out) => {
				if (err) return reject(Error("No terminal acknowledgement."));
				try {
					resolve(JSON.parse(out));
				} catch {
					reject(Error("Invalid terminal acknowledgement."));
				}
			},
		);
		child.stdin?.on("error", () => {});
		child.stdin?.end(input === undefined ? undefined : JSON.stringify(input));
	});

export type PreparePane = (
	agentDir: string,
	signal: AbortSignal,
) => Promise<(root: string, ticket: string) => Promise<RecordValue>>;

export async function preparePane(
	agentDir: string,
	signal: AbortSignal,
	helper: Helper = invoke,
	install: (dir: string) => Promise<string> = async (dir) => (await import("./installer.ts")).ensureEditorApp(dir),
): ReturnType<PreparePane> {
	signal.throwIfAborted();
	const origin = await helper(captureProgram, "capture", signal).catch(() => null);
	if (!object(origin) || origin.version !== 1 || !object(origin.exact)) {
		throw Error("Open /editor from a Pi pane in Rex. Editor needs that exact pane to place its split.");
	}
	const executable = await install(agentDir);
	signal.throwIfAborted();
	if (!isAbsolute(executable)) throw Error("Editor did not install an executable for this pane.");
	return async (root, ticket) => {
		signal.throwIfAborted();
		const result = await helper(splitProgram, "split", signal, {
			version: 1,
			origin,
			argv: [executable, "--pane", ticket],
			cwd: root,
			placement: { side: "right", share: 0.55 },
			label: "Editor",
		}).catch(() => null);
		if (object(result) && result.version === 1) {
			if (result.outcome === "created" && object(result.receipt)) return result.receipt;
			if (result.outcome === "unavailable" || result.outcome === "stale") {
				throw Error("Rex did not create the Editor split. Open /editor from a connected local Pi pane.");
			}
		}
		throw Error("Rex did not confirm the Editor split. Check the invoking tab before you open another pane.");
	};
}
