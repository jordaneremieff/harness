import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentManager } from "./manager.ts";
import { HostError } from "./host-protocol.ts";
import { admittedResult } from "./result-reference.ts";
import { installPeerResolver, managedRelease } from "./terminal.ts";
import { plainLine } from "./view-text.ts";

import { agentPaletteCommands, paletteEnvironmentKeys, type PalettePaths } from "./palette-publication.ts";

type PaletteRequest = {
	version: 1;
	command: string;
	context: { session?: string; block?: string; client?: string; origin?: string };
	answers: unknown[];
};
type PaletteReply =
	| { ask: { kind: "input" | "pick"; prompt: Record<string, unknown> } }
	| { show: { argv: string[]; label: string; cwd?: string; placement?: "right" | "below" | "float" } }
	| { done: { notice?: string } }
	| { error: string };

const terminalFile = fileURLToPath(new URL("./terminal.ts", import.meta.url));
const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
type Roster = Pick<Awaited<ReturnType<AgentManager["dashboardPage"]>>, "rows">;
type RosterRow = Roster["rows"][number];
type PaletteManager = Pick<AgentManager, "control"> & { dashboardPage(): Promise<Roster> };
const replyBudgetMs = 18_000;

function shortLine(text: string, limit: number): string {
	return Array.from(plainLine(text)).slice(0, limit).join("");
}

function errorDetail(error: unknown): string {
	return shortLine(error instanceof Error ? error.message : String(error), 400);
}

function deliveryUncertain(detail: string): PaletteReply {
	return { error: `Delivery was not confirmed. Your message may have arrived. Check the conversation before sending again. ${detail}`.trimEnd() };
}

function pauseAtDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolveResult, reject) => {
		const onAbort = () => reject(signal.reason);
		operation.then(resolveResult, reject).finally(() => signal.removeEventListener("abort", onAbort));
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function baseTitle(row: RosterRow): string {
	return shortLine(row.name ?? "", 100) || row.profile?.handle || row.id;
}

function shortTarget(row: RosterRow): string {
	return row.storageId.slice(0, 8) + row.id.slice(row.storageId.length);
}

function rosterItems(rows: readonly RosterRow[]) {
	const visible = [...rows].sort((a, b) => b.modifiedAt - a.modifiedAt || a.id.localeCompare(b.id)).slice(0, 200);
	const counts = new Map<string, number>();
	for (const row of visible) {
		const title = baseTitle(row);
		counts.set(title, (counts.get(title) ?? 0) + 1);
	}
	const usedTitles = new Set(counts.keys());
	return visible.map((row) => {
		const base = baseTitle(row);
		let title = base;
		if (counts.get(base) !== 1) {
			const suffix = row.profile?.handle || shortTarget(row);
			title = `${base} (${suffix})`;
			if (usedTitles.has(title)) title = `${base} (${row.id})`;
			for (let n = 2; usedTitles.has(title); n++) title = `${base} (${row.id}, ${n})`;
			usedTitles.add(title);
		}
		return { id: row.id, title, subtitle: shortLine(`${row.state} · ${basename(row.cwd) || row.cwd}`, 100), detail: row.state, icon: "person" };
	});
}

function readRoster(manager: PaletteManager, signal?: AbortSignal): Promise<Roster> {
	const roster = manager.dashboardPage();
	return signal ? pauseAtDeadline(roster, signal) : roster;
}

export async function runAgentPaletteStep(request: PaletteRequest, paths: PalettePaths, manager: PaletteManager, signal?: AbortSignal): Promise<PaletteReply> {
	const command = agentPaletteCommands.find(({ id }) => id === request.command);
	if (!command) return { error: "Unknown Agent palette command." };
	const opening = command.id === "agent.open";
	const { answers } = request;
	if (answers.length > (opening ? 1 : 2)) return { error: "Too many answers for this command." };
	const [identity, message] = answers;
	if (answers.length && (typeof identity !== "string" || !identity.trim())) return { error: "Choose an agent from the list." };
	if (answers.length === 2 && (typeof message !== "string" || !message.trim())) return { error: "Enter a message before sending." };

	const { rows } = await readRoster(manager, signal);
	const items = rosterItems(rows);
	if (!answers.length) return { ask: { kind: "pick", prompt: { title: command.title, items } } };
	const target = rows.find((row) => row.id === identity);
	if (!target) return { error: "The selected agent is not in the retained roster." };
	const name = items.find((item) => item.id === target.id)?.title ?? baseTitle(target);
	if (opening) return { show: {
		argv: ["/usr/bin/env", ...paletteEnvironmentKeys.map((key) => `${key}=${paths[key]}`), process.execPath, terminalFile, "--session", target.id],
		label: shortLine(`agent ${name}`, 32), cwd: packageRoot, placement: "right",
	} };
	if (typeof message !== "string") return { ask: { kind: "input", prompt: { title: `Message ${name}`, placeholder: "Type a message" } } };
	return sendMessage(target.id, name, message, manager, signal);
}

async function sendMessage(id: string, name: string, message: string, manager: PaletteManager, signal?: AbortSignal): Promise<PaletteReply> {
	if (signal?.aborted) return { error: "The palette step timed out before sending." };
	try {
		const admission = manager.control("submit", { sessionId: id, message, whenBusy: "steer", origin: "operator", replyTo: id }, { id: `terminal:${randomUUID()}`, cwd: packageRoot });
		admittedResult(id, await (signal ? pauseAtDeadline(admission, signal) : admission));
		return { done: { notice: `Sent to ${name}.` } };
	} catch (error) {
		const detail = errorDetail(error);
		if (error instanceof HostError && (error.code === "invalid" || error.code === "claim")) return { error: `Message refused: ${detail}` };
		return deliveryUncertain(detail);
	}
}

function parseRequest(raw: string): PaletteRequest {
	const value = JSON.parse(raw) as Partial<PaletteRequest> | null;
	if (value?.version !== 1 || typeof value.command !== "string" || !Array.isArray(value.answers)
		|| value.context === null || typeof value.context !== "object" || Array.isArray(value.context)) throw new Error("Invalid palette request.");
	return { version: 1, command: value.command, context: value.context, answers: value.answers };
}

async function run(args: string[], signal: AbortSignal): Promise<PaletteReply> {
	const rawRequest = args.at(-1);
	if (args.length !== paletteEnvironmentKeys.length + 1 || !rawRequest || !args.slice(0, -1).every(isAbsolute))
		return { error: "The Agent palette command needs absolute paths to its configuration and store." };
	const request = parseRequest(rawRequest);
	const paths = Object.fromEntries(paletteEnvironmentKeys.map((key, i) => [key, args[i]])) as PalettePaths;
	Object.assign(process.env, paths);
	const release = managedRelease();
	const hook = installPeerResolver(release.anchor);
	try {
		const [{ AgentManager }, { acquireHost }] = await Promise.all([import("./manager.ts"), import("./host-client.ts")]);
		let root = paths.PI_AGENT_SESSIONS_DIR;
		try { root = realpathSync(root); }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const packageDir = fileURLToPath(new URL("./node_modules/@earendil-works/pi-coding-agent", release.anchor));
		const manager = new AgentManager({ root, agentDir: paths.PI_AGENT_DIR, packageDir,
			acquire: (metadata, options) => acquireHost(metadata, { ...options, signal, retryAttempts: 0 }) });
		try { return await runAgentPaletteStep(request, paths, manager, signal); }
		finally { await manager.close(); }
	} finally { hook.deregister(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const deadline = new AbortController();
	const timer = setTimeout(() => deadline.abort(new Error("The palette step timed out.")), replyBudgetMs);
	const reply = await run(process.argv.slice(2), deadline.signal).catch((error) => ({ error: errorDetail(error) || "The Agent command failed." }));
	clearTimeout(timer);
	// End this one-step client, not a Durable host. Flush the sole reply first.
	process.stdout.write(`${JSON.stringify(reply)}\n`, () => process.exit(0));
}
