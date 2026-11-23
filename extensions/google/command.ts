import { GoogleRuntime } from "./gws.ts";
import { errorResult } from "./result.ts";
import type { Environment } from "./settings.ts";
import { logout, parseSetupArgs, productionDeps, type SetupDeps, setup, type UpdateReport, update } from "./setup.ts";

export const USAGE =
	"google setup [--client <file>] [--account <email>] [--services gmail,drive,sheets,calendar,docs,slides,tasks] [--access read|write] | google update | google status | google logout";

type Print = (line: string, level?: "info" | "error") => void;
export type EmissionKind =
	| "progress"
	| "sign-in"
	| "sign-in-output"
	| "status"
	| "status-not-ready"
	| "complete"
	| "usage"
	| "refusal"
	| "error";
type Emit = (kind: EmissionKind, text: string) => void;
export type CommandDeps = Omit<SetupDeps, "log">;

/** Keep the shell printer's output and exit contract independent of the operator view. */
export function googleCommand(input: string, agentDir: string, env: Environment, print: Print): Promise<boolean> {
	return runGoogleCommand(input, agentDir, env, (kind, text) => {
		if (kind === "error" || kind === "refusal" || kind === "usage") print(text, "error");
		else print(text);
	});
}

function updateText({ executable, installed, latest, pinned }: UpdateReport): string {
	const newer = latest && latest !== pinned ? ` Upstream release ${latest} exists; this extension pins ${pinned}.` : "";
	return `gws ${pinned} ${installed ? "installed" : "is already installed"} at ${executable}.${newer}`;
}

export async function runGoogleCommand(
	input: string,
	agentDir: string,
	env: Environment,
	emit: Emit,
	overrides: Partial<CommandDeps> = {},
): Promise<boolean> {
	const deps = { ...productionDeps((line, kind) => emit(kind ?? "progress", line)), ...overrides };
	const [verb, ...rest] = input.trim().split(/\s+/).filter(Boolean);
	try {
		switch (verb) {
			case "setup": {
				const options = parseSetupArgs(rest);
				const report = await setup({ agentDir, env, ...options }, deps);
				emit(
					"complete",
					`Signed in as ${report.account}. Granted scopes: ${report.scopes.join(" ")}. gws: ${report.executable}${report.installed ? " (installed now)" : ""}.`,
				);
				break;
			}
			case "update":
				emit("complete", updateText(await update({ agentDir, env }, deps)));
				break;
			case "logout":
				await logout({ agentDir, env });
				emit(
					"complete",
					"Signed out locally. Remove the app's access in your Google Account to revoke the grant at Google.",
				);
				break;
			case "status": {
				const { data } = await new GoogleRuntime(agentDir, env).status();
				emit(data?.ready === false ? "status-not-ready" : "status", JSON.stringify(data, null, 2));
				break;
			}
			default:
				emit("usage", `Usage: ${USAGE}`);
				return false;
		}
		return true;
	} catch (error) {
		const failure = errorResult(error).error;
		const refused = ["INVALID_ARGUMENT", "SETUP_REQUIRED", "BACKEND_VERSION_MISMATCH", "CONFIG_ERROR"].includes(
			failure?.code ?? "",
		);
		emit(refused ? "refusal" : "error", `${failure?.code ?? "ERROR"}: ${failure?.message ?? String(error)}`);
		return false;
	}
}
