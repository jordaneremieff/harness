import { homedir } from "node:os";
import { basename, dirname, isAbsolute } from "node:path";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { installedAccessors } from "./host.ts";
import type { NoteKnowledge, NoteResource } from "./notes.ts";
import type { SettingsSnapshot } from "./configuration.ts";
import type { HostSnapshot } from "./records.ts";

/** Resource paths come only from the host's loaded registrations. */
export function noteResource(kind: NoteResource["kind"], name: string, source: SourceInfo, resolvedPath?: string): NoteResource | undefined {
	const path = resolvedPath ?? source.path;
	if (!isAbsolute(path)) return;
	if (kind === "prompt") return { kind, name, path };
	const entryFile = /\.[cm]?[jt]s$/.test(path);
	const location = kind === "skill" || entryFile ? dirname(path) : path;
	const extensionName = entryFile && !/^index\.[cm]?[jt]s$/.test(basename(path)) ? basename(path).replace(/\.[cm]?[jt]s$/, "") : basename(location);
	return { kind, name: kind === "extension" ? extensionName : name, path: location,
		...(kind === "extension" ? { entryPath: path } : {}) };
}
export function ordinaryNoteResources(snapshot: HostSnapshot): NoteResource[] | null {
	if (!snapshot.availability.tools || !snapshot.availability.commands) return null;
	const tools = snapshot.tools.map((tool) => {
		const resource = noteResource("extension", tool.name, tool.sourceInfo);
		return resource ? { ...resource, tool: tool.name } : undefined;
	});
	const commands = snapshot.commands.map((command) => {
		const kind = command.source === "skill" ? "skill" : command.source === "prompt" ? "prompt" : "extension";
		return noteResource(kind, command.name, command.sourceInfo);
	});
	return [...tools, ...commands].filter((resource) => resource !== undefined);
}
export function noteKnowledge(cwd: string, agentDir: string, resources: readonly NoteResource[] | null, settings: SettingsSnapshot): NoteKnowledge {
	return { cwd, agentDir, home: homedir(), resources, settings, version: installedAccessors.version(),
		packageDir: installedAccessors.packageDir(), docsPath: installedAccessors.docsPath(), examplesPath: installedAccessors.examplesPath() };
}
