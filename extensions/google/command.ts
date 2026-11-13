import { GoogleRuntime } from "./gws.ts";
import { errorResult } from "./result.ts";
import type { Environment } from "./settings.ts";
import { logout, parseSetupArgs, productionDeps, type SetupDeps, setup, update } from "./setup.ts";

export const USAGE =
	"google setup [--client <file>] [--account <email>] [--services gmail,drive,sheets,calendar,docs,slides,tasks] [--access read|write] | google update | google status | google logout";

export type Print = (line: string, level?: "info" | "error") => void;

/** Shared by the /google command and cli.ts. Returns false when the verb failed. */
export async function googleCommand(
	input: string,
	agentDir: string,
	env: Environment,
	print: Print,
	deps: SetupDeps = productionDeps((line) => print(line)),
): Promise<boolean> {
	const [verb, ...rest] = input.trim().split(/\s+/).filter(Boolean);
	try {
		if (verb === "setup") {
			const report = await setup({ agentDir, env, ...parseSetupArgs(rest) }, deps);
			print(
				`Signed in as ${report.account}. Granted scopes: ${report.scopes.join(" ")}. gws: ${report.executable}${report.installed ? " (installed now)" : ""}.`,
			);
		} else if (verb === "update") {
			const report = await update({ agentDir, env }, deps);
			const newer =
				report.latest && report.latest !== report.pinned
					? ` Upstream release ${report.latest} exists; this extension pins ${report.pinned}.`
					: "";
			print(
				`gws ${report.pinned} ${report.installed ? "installed" : "is already installed"} at ${report.executable}.${newer}`,
			);
		} else if (verb === "logout") {
			await logout({ agentDir, env });
			print("Signed out locally. Remove the app's access in your Google Account to revoke the grant at Google.");
		} else if (verb === "status") {
			print(JSON.stringify((await new GoogleRuntime(agentDir, env).status()).data, null, 2));
		} else {
			print(`Usage: ${USAGE}`, "error");
			return false;
		}
		return true;
	} catch (error) {
		const failure = errorResult(error).error;
		print(`${failure?.code ?? "ERROR"}: ${failure?.message ?? String(error)}`, "error");
		return false;
	}
}
