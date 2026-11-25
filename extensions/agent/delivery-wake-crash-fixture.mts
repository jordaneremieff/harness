/** Stop an isolated writer between wake publication and recovery-marker clearance. */
import { writeSync } from "node:fs";
import { bindInstallationPackages } from "./installation-binding.ts";

const input = JSON.parse(process.argv[2] ?? "null") as { packageDir: string };
bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
const [{ RecipientHintWriter }, { parseHostMetadata }, { runHost }, { createDurableRuntime }] = await Promise.all([
	import("./recipient-hints.ts"),
	import("./host-protocol.ts"),
	import("./host-process.ts"),
	import("./durable-runtime.ts"),
]);
const metadata = parseHostMetadata(input);
const publish = RecipientHintWriter.prototype.publish;
RecipientHintWriter.prototype.publish = function (demand) {
	const result = publish.call(this, demand);
	if (demand.size) {
		writeSync(1, "WAKE_BEFORE_MARKER_CLEAR\n");
		process.kill(process.pid, "SIGSTOP");
	}
	return result;
};
const host = await runHost(() => createDurableRuntime(metadata), {
	metadata,
	idleMs: 0,
	exit: (status) => process.exit(status),
});
await host.done;
