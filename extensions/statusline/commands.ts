import type { ExtensionAPI, SlashCommandInfo } from "@earendil-works/pi-coding-agent";

/** Exact registration identity: invocation name, kind, and every provenance field. */
function commandIdentity(command: SlashCommandInfo): string {
	const info = command.sourceInfo;
	return JSON.stringify([
		command.name,
		command.source,
		info.path,
		info.source,
		info.scope,
		info.origin,
		info.baseDir ?? null,
		info.changelogPath ?? null,
	]);
}

/** Send an extension command only if its exact registration is still current. */
export function dispatchCommand(
	host: Pick<ExtensionAPI, "getCommands" | "sendUserMessage">,
	command: SlashCommandInfo,
): boolean {
	if (command.source !== "extension") return false;
	const identity = commandIdentity(command);
	if (!host.getCommands().some((candidate) => commandIdentity(candidate) === identity)) return false;
	host.sendUserMessage(`/${command.name}`, { expandPromptTemplates: true });
	return true;
}
