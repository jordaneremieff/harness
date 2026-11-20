import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	CONFIG_DIR_NAME,
	createEventBus,
	getPackageDir,
	SettingsManager,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { ConfigBridge } from "./bridge.ts";
import { ConfigBackend } from "./operations.ts";
import { publishSettings } from "./settings.ts";

test("the bridge serves authorised finite operations and wakes panes after edits", { timeout: 20000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "config-bridge-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
	const bus = createEventBus();
	const stop = publishSettings(bus, { agentDir, env: {} });
	const backend = new ConfigBackend(() => ({
		kind: "ordinary",
		agentDir,
		cwd,
		projectTrusted: true,
		bus,
		env: {},
		pi: { version: VERSION, packageDir: getPackageDir(), configDir: CONFIG_DIR_NAME, SettingsManager },
	}));
	const bridge = new ConfigBridge({
		backend,
		agentDir,
		label: () => "test",
		expectedBuild: () => "sha256:new",
		pollMs: 2000,
	});
	try {
		const capability = await bridge.capability();
		assert.equal(statSync(capability.path).mode & 0o777, 0o600);
		const live = JSON.parse(readFileSync(capability.path, "utf8"));
		assert.equal(live.version, 1);
		const client = randomUUID();
		const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
			fetch(`${live.endpoint}${path}`, {
				method: "POST",
				redirect: "error",
				headers: { "Content-Type": "application/json", Authorization: `Bearer ${live.token}`, ...headers },
				body: JSON.stringify(body),
			});

		assert.equal((await post("/connect", { version: 1, client }, { Authorization: "Bearer wrong" })).status, 403);
		assert.equal((await post("/connect", { version: 1, client }, { Origin: "http://evil.example" })).status, 403);
		assert.equal((await post("/files", { client })).status, 404);
		assert.equal((await post("/catalogue", { client, generation: 1 })).status, 409);

		const connect = await (await post("/connect", { version: 1, client, build: "sha256:old" })).json();
		assert.equal(connect.ok, true);
		assert.equal(connect.context.agentDir, agentDir);
		assert.deepEqual(connect.build, { expected: "sha256:new", current: false });

		const catalogue = await (await post("/catalogue", { client, generation: 7 })).json();
		assert.equal(catalogue.generation, 7);
		assert.equal(catalogue.catalogue.generation, 7);
		assert.ok(catalogue.catalogue.entries.some((entry: { id: string }) => entry.id === "pi:/theme"));

		const poll = post("/poll", { client, after: 0 }).then((response) => response.json());
		const edit = await backend.edit({
			mode: "commit",
			changes: [
				{ id: "pi:/theme", scope: "global", action: "set", value: "light", base: { present: true, value: "dark" } },
			],
		});
		assert.equal(edit.outcome, "committed");
		assert.deepEqual(await poll, { ok: true, sequence: 1, command: null, changed: true });

		const viaBridge = await (
			await post("/edit", {
				client,
				request: {
					mode: "commit",
					requestId: "pane-1",
					changes: [
						{ id: "pi:/theme", scope: "global", action: "set", value: "dark", base: { present: true, value: "light" } },
					],
				},
			})
		).json();
		assert.equal(viaBridge.result.outcome, "committed");
		assert.equal(viaBridge.result.requestId, "pane-1");

		assert.equal(bridge.reveal("compaction"), true);
		const revealed = await (await post("/poll", { client, after: 1 })).json();
		assert.deepEqual(revealed.command, { op: "reveal", query: "compaction" });

		await post("/catalogue", { client, generation: 9 });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "another-process" }));
		const external = await (await post("/poll", { client, after: 2 })).json();
		assert.equal(external.changed, true);

		const tools = await (await post("/tools", { client })).json();
		assert.equal(tools.tools.session, false);
		assert.equal((await post("/close", { client })).status, 200);
		assert.equal((await post("/catalogue", { client, generation: 8 })).status, 409);

		const second = await bridge.capability();
		bridge.close();
		assert.throws(() => statSync(second.path));
		await assert.rejects(post("/connect", { version: 1, client: randomUUID() }));
	} finally {
		bridge.close();
		stop();
		rmSync(root, { recursive: true, force: true });
	}
});
