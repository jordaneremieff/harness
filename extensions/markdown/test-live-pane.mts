import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before } from "node:test";
import type { LiveBinding, LiveConfig } from "./live-protocol.ts";

let home: string;
const previous = process.env.PI_CODING_AGENT_DIR;
before(async () => {
	home = await mkdtemp(join(tmpdir(), "markdown-test-pane-"));
	process.env.PI_CODING_AGENT_DIR = home;
});
after(async () => {
	if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previous;
	await rm(home, { recursive: true, force: true });
});

const launches = new Map<string, { launchId: string; pid: number; serial: number }>();

export async function connectTestPane(
	config: LiveConfig,
	binding: LiveBinding,
	overrides: object = {},
): Promise<Response> {
	const {
		origin = "operator",
		pid = process.pid,
		launchId = randomUUID(),
		serial,
		...fields
	} = overrides as {
		origin?: "agent" | "operator";
		pid?: number;
		launchId?: string;
		serial?: number;
	};
	const post = (path: string, body: object) =>
		fetch(config.endpoint + path, {
			method: "POST",
			headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(5000),
		});
	const key = `${config.token}:${binding.workspace}`;
	let launch = launches.get(key);
	if (!launch) {
		const reserved = await post("/reserve", { launchId, origin });
		if (!reserved.ok) throw new Error(`Test pane reservation refused: ${reserved.status}`);
		await reserved.body?.cancel();
		const starting = await post("/starting", { launchId, pid });
		if (!starting.ok) throw new Error(`Test pane startup refused: ${starting.status}`);
		await starting.body?.cancel();
		launch = { launchId, pid, serial: 0 };
		launches.set(key, launch);
	}
	const next = serial ?? launch.serial + 1;
	launch.serial = Math.max(next, launch.serial);
	return post("/connect", {
		...binding,
		live: 3,
		pid: launch.pid,
		launchId: launch.launchId,
		serial: next,
		view: { kind: "scratchpad", title: "Test pane", mode: "writing", dirty: false, conflict: false },
		...fields,
	});
}
