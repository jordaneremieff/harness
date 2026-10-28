/** Stop an isolated writer between wake publication and recovery-marker clearance. */
import { writeSync } from "node:fs";
import { dirname } from "node:path";
import { bindInstallationPackages } from "./installation-binding.ts";

const input = JSON.parse(process.argv[2] ?? "null") as { packageDir: string };
bindInstallationPackages(input.packageDir, new URL("./", import.meta.url));
const [{ AgentCatalog }, { readDeliveryWake }, { parseHostMetadata }, { runHost }, { createDurableRuntime }] = await Promise.all([import("./catalog.ts"), import("./delivery-wake.ts"), import("./host-protocol.ts"), import("./host-process.ts"), import("./durable-runtime.ts")]);
const metadata = parseHostMetadata(input), root = dirname(dirname(metadata.storagePath));
const mark = AgentCatalog.prototype.markRecoveryDue;
AgentCatalog.prototype.markRecoveryDue = function (identity, due) {
	if (identity === metadata.storageId && !due && this.read(identity).recoveryDue === true && (readDeliveryWake(root, identity)?.recipients.length ?? 0) > 0) {
		writeSync(1, "WAKE_BEFORE_MARKER_CLEAR\n");
		process.kill(process.pid, "SIGSTOP");
	}
	return mark.call(this, identity, due);
};
const host = await runHost(() => createDurableRuntime(metadata), { metadata, idleMs: 0, exit: () => process.exit(0) });
await host.done;
