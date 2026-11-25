/**
 * Two roles for the launch arbitration test. `count-runner` records one runner process start in the file that
 * `LAUNCH_COUNT_FILE` names, then runs the Durable runner. `acquire` acquires the storage's host from a separate
 * process through that counting runner and prints the host's process ID.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const role = process.argv[2];
if (role === "count-runner") {
	appendFileSync(process.env.LAUNCH_COUNT_FILE ?? "", `${process.pid}\n`);
	process.argv.splice(2, 1);
	process.argv[1] = fileURLToPath(new URL("./durable-runner.ts", import.meta.url));
	await import("./durable-runner.ts");
} else if (role === "acquire") {
	const { acquireHost } = await import("./host-client.ts");
	const metadata = JSON.parse(process.argv[3] ?? "null");
	const client = await acquireHost(metadata, {
		runner: fileURLToPath(import.meta.url),
		runnerArgs: ["count-runner"],
		launchTimeoutMs: 30_000,
	});
	process.stdout.write(`HOST ${client.pid}\n`);
	await client.close();
}
