import { paneConfig, startPaneService } from "./pane-service.ts";

const CONFIG_LIMIT = 32768;
let config = Buffer.alloc(0);
let startup: ReturnType<typeof startPaneService> | undefined;
let closing = false;

async function close(problem?: unknown) {
	if (closing) return;
	closing = true;
	process.stdin.pause();
	const service = await startup?.catch(() => undefined);
	await service?.close().catch(() => {});
	if (problem !== undefined) {
		const message = problem instanceof Error ? problem.message : "Invalid Editor service request.";
		process.stderr.write(`Editor service: ${message.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 400)}\n`);
	}
	process.exitCode = problem === undefined ? 0 : 1;
	process.stdin.destroy();
}

process.stdin.on("data", (chunk: Buffer) => {
	if (closing) return;
	if (startup || config.length + chunk.length > CONFIG_LIMIT) {
		void close(Error("Expected exactly one Editor configuration line."));
		return;
	}
	config = Buffer.concat([config, chunk]);
	const newline = config.indexOf(10);
	if (newline < 0) return;
	if (newline !== config.length - 1) {
		void close(Error("Expected exactly one Editor configuration line."));
		return;
	}
	try {
		startup = startPaneService(
			paneConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(config.subarray(0, newline)))),
		);
		config = Buffer.alloc(0);
		void startup.then(({ port, token }) => {
			if (!closing) process.stdout.write(`${JSON.stringify({ port, token })}\n`);
		}, close);
	} catch (error) {
		void close(error);
	}
});
process.stdin.once("end", () => void close(startup ? undefined : Error("Editor configuration was not supplied.")));
process.stdin.once("error", close);
process.stdout.once("error", close);
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
