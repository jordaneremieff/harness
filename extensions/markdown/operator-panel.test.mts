import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PanelHost } from "../../operator-ui/index.ts";
import { panelOperations } from "./operator-panel.ts";
import { responsePage } from "./panel-protocol.ts";
import { responseSnapshot } from "./responses.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

test("panel import registers and emits nothing and creates no store", async () => {
	const root = await mkdtemp(join(tmpdir(), "markdown-panel-import-"));
	try {
		const path = new URL("./operator-panel.ts", import.meta.url).href;
		const script = `const module = await import(${JSON.stringify(path)}); const panel = module.operatorPanel(); process.stdout.write(JSON.stringify({version:panel.version,title:panel.title}));`;
		const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { cwd: root, env: { ...process.env, PI_MARKDOWN_DIR: join(root, "store"), PI_HARNESS_FILE: join(root, "no-settings.json") }, timeout: 10000, maxBuffer: 8192 });
		assert.deepEqual(JSON.parse(result.stdout), { version: 2, title: "Markdown" });
		assert.equal(result.stderr, "");
		assert.deepEqual(await readdir(root), []);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test("native view drops a page when its captured target closes", async () => {
	const response = responseSnapshot(fauxAssistantMessage("Exact response"), "42", { kind: "native-response", session: "s", conversation: "1" });
	assert.ok(response);
	const controller = new AbortController();
	const host: PanelHost = { theme: {} as Theme, requestRender: () => {}, notify: () => {}, push: () => {}, back: () => {}, close: () => {}, target: { id: "s:1", label: "captured" }, signal: controller.signal, request: async () => {
		controller.abort();
		return { text: "page", data: JSON.parse(JSON.stringify(responsePage(response, 0))) };
	} };
	await assert.rejects(panelOperations(host).read({ kind: "response", response: { entryId: "42", preview: "Exact response", bytes: 14, stop: "stop", completeness: { state: "complete" } } }, controller.signal), /abort/iu);
});
