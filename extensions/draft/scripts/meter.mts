// Command line entry for the draft prose meter. Run `node meter.mts --help` for usage.
import { MAX_INPUT_BYTES, readDescriptor, runCli } from "./cli.mts";

process.exitCode = runCli(process.argv.slice(2), {
	readStdin: () => readDescriptor(0, MAX_INPUT_BYTES),
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
	env: process.env,
	stdoutIsTty: process.stdout.isTTY === true,
	stdinIsTty: process.stdin.isTTY === true,
});
