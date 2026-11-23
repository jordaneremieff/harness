import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { LIVE_LIFETIME, PANE_PROTOCOL, isRecord, readLiveConfig, type LiveConfig } from "./live-protocol.ts";
import type { LiveLaunch } from "./launch-ledger.ts";

class ReservationRefused extends Error {}
async function post(config: LiveConfig, route: "reserve" | "cancel", body: object): Promise<unknown> {
	const result = await fetch(`${config.endpoint}/${route}`, {
		method: "POST",
		redirect: "error",
		headers: { authorization: `Bearer ${config.token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(3000),
	});
	if (!result.ok) {
		await result.body?.cancel();
		if (result.status === 409)
			throw new ReservationRefused(
				"The reader launch was refused. List the conversation's panes and pending launches before another attempt.",
			);
		throw new Error("The live Markdown host is unavailable.");
	}
	return await result.json();
}

/** The bridge creates the private one-use file. No capability crosses the reader command line. */
export async function liveArguments(
	argv: string[],
	live?: LiveConfig,
	options: Partial<Pick<LiveLaunch, "origin" | "documentId" | "revision">> = {},
): Promise<{ argv: string[]; launchId?: string; remove: () => Promise<void> }> {
	if (!live) return { argv, remove: async () => {} };
	const config = readLiveConfig(live);
	if (config.live !== PANE_PROTOCOL)
		throw new ReservationRefused(
			"This Markdown host lacks reader launch reservations. Reload the conversation and update the reader app.",
		);
	if (live[LIVE_LIFETIME]?.aborted) throw new Error("The live Markdown host closed.");
	const launchId = randomUUID();
	const remove = async () => {
		await post(config, "cancel", { launchId }).catch(() => {});
	};
	const reply = await post(config, "reserve", {
		launchId,
		origin: options.origin ?? "operator",
		documentId: options.documentId,
		revision: options.revision,
	}).catch(async (error: unknown) => {
		// A lost response can leave an unused file on a still-running bridge.
		if (!(error instanceof ReservationRefused)) await remove();
		throw error;
	});
	if (
		!isRecord(reply) ||
		reply.ok !== true ||
		typeof reply.path !== "string" ||
		!isAbsolute(reply.path) ||
		live[LIVE_LIFETIME]?.aborted
	) {
		await remove();
		throw new Error("The reader launch was not confirmed.");
	}
	return { argv: [...argv, "--live", reply.path], launchId, remove };
}
async function supportsLive(app?: string): Promise<boolean> {
	if (!app) return false;
	try {
		const path = join(app, "Contents", "Resources", "build.json");
		const info = await lstat(path);
		if (!info.isFile() || info.size > 8192) return false;
		const build: unknown = JSON.parse(await readFile(path, "utf8"));
		return isRecord(build) && build.paneProtocol === PANE_PROTOCOL;
	} catch {
		return false;
	}
}
/** Preparing a command does not establish that its reader process started. */
export async function withLiveShow<
	T extends { show?: string[]; showUnavailable?: string; documentId?: string; revision?: number },
>(
	outcome: T,
	app: string | undefined,
	connection?: () => Promise<LiveConfig>,
	signal?: AbortSignal,
): Promise<T & { launchId?: string }> {
	if (!outcome.show) return outcome;
	if (!connection)
		return {
			...outcome,
			show: undefined,
			showUnavailable: "The exact invoking conversation is unavailable. No reader launch was prepared.",
		};
	if (!(await supportsLive(app)))
		return {
			...outcome,
			show: undefined,
			showUnavailable:
				"The installed app does not support the current live pane protocol. Build it with node extensions/markdown/native/build.mts. The saved document remains readable.",
		};
	try {
		signal?.throwIfAborted();
		const config = await connection();
		signal?.throwIfAborted();
		const launch = await liveArguments(outcome.show, config, {
			origin: "agent",
			documentId: outcome.documentId,
			revision: outcome.revision,
		});
		if (signal?.aborted) {
			await launch.remove();
			signal.throwIfAborted();
		}
		return { ...outcome, show: launch.argv, launchId: launch.launchId };
	} catch (error) {
		return {
			...outcome,
			show: undefined,
			showUnavailable:
				error instanceof ReservationRefused
					? error.message
					: "The exact invoking conversation is unavailable. The saved document remains readable from the Markdown view; no replacement conversation was selected.",
		};
	}
}
